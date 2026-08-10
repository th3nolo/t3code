/**
 * OpenCode v2 (opencode2) beta compatibility adapter.
 *
 * The bundled `@opencode-ai/sdk/v2` targets an older wire protocol than the
 * live opencode2 preview server: routes moved under `/api/*`, every request
 * needs HTTP Basic auth, and several payload shapes were redesigned. This
 * module provides a `fetch` wrapper (the one hook hey-api's client exposes)
 * that bridges the gap without touching T3's call sites.
 *
 * See `docs/opencode2-beta-compat.md` for the full protocol map, the shapes
 * behind each transform here, and the repair playbook. opencode2 is a
 * fast-moving beta — EVERY transform is fail-open: on an unrecognized shape it
 * returns the input untouched, so drift degrades gracefully instead of
 * crashing chat.
 *
 * Status: path rewrite + auth + provider/message response reshaping are
 * validated against `v0.0.0-next-17086`. The SSE event-stream translation
 * (`/api/event`) is the remaining work — see `translateEventStream`.
 */

const API_PREFIX = "/api";

// Top-level route segments the v2 server serves under /api/*. Extend if a new
// namespace 404s through the adapter.
const REWRITE_SEGMENTS = [
  "provider",
  "agent",
  "session",
  "event",
  "app",
  "mcp",
  "permission",
  "question",
  "find",
  "file",
  "config",
] as const;

const shouldRewrite = (pathname: string): boolean =>
  !pathname.startsWith(`${API_PREFIX}/`) &&
  REWRITE_SEGMENTS.some((seg) => pathname === `/${seg}` || pathname.startsWith(`/${seg}/`));

export interface Opencode2CompatOptions {
  /** Password for the target server (from `opencode2 pair` / serve stdout). */
  readonly password?: string | null;
}

/**
 * Wrap a base `fetch` so requests from the v1-era SDK reach the v2 server:
 * rewrite the path under /api, inject Basic auth, and reshape the response
 * body for the routes T3 consumes.
 */
export function createOpencode2Fetch(
  baseFetch: typeof fetch,
  options: Opencode2CompatOptions = {},
): typeof fetch {
  // v2 servers require Basic auth; v1 servers have none. Use password presence
  // as the v2 signal: with no password, return the base fetch untouched so a
  // v1 (or external unauthenticated) server sees no path rewrite or reshaping.
  if (options.password == null || options.password.length === 0) {
    return baseFetch;
  }
  const authHeader = `Basic ${Buffer.from(`opencode:${options.password}`, "utf8").toString("base64")}`;

  return async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const originalUrl = input instanceof Request ? input.url : String(input);

    let targetUrl = originalUrl;
    let rewrittenPathname: string | null = null;
    try {
      const url = new URL(originalUrl);
      if (shouldRewrite(url.pathname)) {
        rewrittenPathname = `${API_PREFIX}${url.pathname}`;
        url.pathname = rewrittenPathname;
        targetUrl = url.toString();
      }
    } catch {
      // Non-absolute URL — leave it alone.
    }

    // Rebuild the request with the rewritten URL and injected auth. Use
    // globalThis.Headers explicitly: the server bundle imports Effect's
    // `Headers` (a non-constructor module object) at top scope, which would
    // otherwise shadow the web global here ("Headers is not a constructor").
    const headers = new globalThis.Headers(
      input instanceof Request ? input.headers : (init?.headers as HeadersInit | undefined),
    );
    if (authHeader && !headers.has("authorization")) {
      headers.set("authorization", authHeader);
    }

    const response =
      input instanceof Request
        ? await baseFetch(new Request(targetUrl, input), { ...init, headers })
        : await baseFetch(targetUrl, { ...init, headers });

    if (rewrittenPathname === null) return response;
    return reshapeResponse(rewrittenPathname, response);
  };
}

/**
 * Reshape a v2 response body into the shape T3's SDK/adapter expects.
 * Fail-open: anything we don't specifically recognize is returned untouched.
 */
async function reshapeResponse(pathname: string, response: Response): Promise<Response> {
  const contentType = response.headers.get("content-type") ?? "";

  // Leave streams (SSE) to the dedicated translator.
  if (pathname === `${API_PREFIX}/event`) return translateEventStream(response);
  if (!contentType.includes("application/json")) return response;

  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    return response;
  }

  const transformed = transformJsonBody(pathname, body);
  if (transformed === undefined) return response;

  return new Response(JSON.stringify(transformed), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Pure JSON body transforms, keyed by route. Returns `undefined` to mean
 * "no transform — use the original response". Exported for unit testing.
 */
export function transformJsonBody(pathname: string, body: unknown): unknown {
  // GET /api/session/{id}/message — flat v2 messages → v1 { info, parts }.
  if (/\/api\/session\/[^/]+\/message$/.test(pathname)) {
    const data = (body as { data?: unknown })?.data;
    if (Array.isArray(data)) {
      return { ...(body as object), data: data.map(toV1Message) };
    }
    return undefined;
  }

  // GET /api/provider — v2 { location, data:[…] } → v1 { all, connected, default }.
  // NOTE: v2 providers carry no models here; models come from the CLI `models`
  // path. This mapping only keeps the SDK inventory call from throwing.
  if (pathname === `${API_PREFIX}/provider`) {
    const data = (body as { data?: unknown })?.data;
    if (Array.isArray(data)) {
      const all = data.map((p) => ({ ...(p as object), models: (p as { models?: unknown }).models ?? {} }));
      return { all, connected: all.map((p: { id?: string }) => p.id).filter(Boolean), default: {} };
    }
    return undefined;
  }

  return undefined;
}

/** v2 flat message → v1 { info, parts }. */
function toV1Message(message: unknown): unknown {
  const m = message as {
    id?: string;
    type?: string;
    text?: string;
    content?: Array<{ type?: string; text?: string }>;
    [k: string]: unknown;
  };
  if (!m || typeof m !== "object") return message;

  const role = m.type; // v2 uses `type` where v1 used `info.role`
  let parts: Array<{ type: string; text?: string }>;
  if (Array.isArray(m.content)) {
    // assistant: reply lives in content[] items (text | reasoning)
    parts = m.content.map((c) => ({ type: c.type ?? "text", text: c.text }));
  } else if (typeof m.text === "string") {
    // user/system: single text part
    parts = [{ type: "text", text: m.text }];
  } else {
    parts = [];
  }

  const { content: _c, text: _t, type: _ty, ...rest } = m;
  return { info: { ...rest, id: m.id, role }, parts };
}

/**
 * Synthesize a stable v1 `partID` from v2's `(assistantMessageID, kind,
 * ordinal)` triple. v2 streams have no part identity of their own; T3's reducer
 * keys everything on `partID`, so start/delta/end for one content run must all
 * resolve to the same id.
 */
function partId(messageID: string, kind: "text" | "reasoning", ordinal: number): string {
  return `${messageID}::${kind}::${ordinal}`;
}

/**
 * Map a single v2 `session.*` event to zero or more v1 events (`{type,
 * properties}`) that T3's OpenCodeAdapter switch understands. `startTimes`
 * carries per-part start timestamps across events in the stream so `*.ended`
 * can emit a `time: {start, end}` — the final text part MUST carry `time.end`
 * or T3 never marks the assistant turn complete.
 *
 * Exported for unit testing. Fail-open: unmapped event types return [].
 */
export function translateEvent(
  event: { type?: string; created?: number; data?: Record<string, unknown> },
  startTimes: Map<string, number>,
): Array<{ type: string; properties: Record<string, unknown> }> {
  const d = event.data ?? {};
  const ts = event.created ?? 0;
  const sessionID = d.sessionID as string | undefined;
  const messageID = d.assistantMessageID as string | undefined;
  const ordinal = typeof d.ordinal === "number" ? d.ordinal : 0;

  const partStarted = (kind: "text" | "reasoning") => {
    if (!messageID || !sessionID) return [];
    const id = partId(messageID, kind, ordinal);
    startTimes.set(id, ts);
    return [
      {
        type: "message.part.updated",
        properties: { sessionID, part: { id, messageID, type: kind, text: "", time: { start: ts } } },
      },
    ];
  };
  const partDelta = (kind: "text" | "reasoning") => {
    if (!messageID || !sessionID) return [];
    return [
      {
        type: "message.part.delta",
        properties: { sessionID, partID: partId(messageID, kind, ordinal), delta: String(d.delta ?? "") },
      },
    ];
  };
  const partEnded = (kind: "text" | "reasoning") => {
    if (!messageID || !sessionID) return [];
    const id = partId(messageID, kind, ordinal);
    const start = startTimes.get(id) ?? ts;
    return [
      {
        type: "message.part.updated",
        properties: {
          sessionID,
          part: { id, messageID, type: kind, text: String(d.text ?? ""), time: { start, end: ts } },
        },
      },
    ];
  };
  const status = (statusPayload: Record<string, unknown>) =>
    sessionID ? [{ type: "session.status", properties: { sessionID, status: statusPayload } }] : [];

  switch (event.type) {
    case "session.created":
      return sessionID
        ? [{ type: "session.updated", properties: { sessionID, info: { id: sessionID, ...d } } }]
        : [];
    case "session.execution.started":
      return status({ type: "busy" });
    case "session.step.started":
      // Register the assistant message role before any of its parts arrive, so
      // messageRoleForPart resolves "assistant" and deltas are emitted.
      return messageID && sessionID
        ? [{ type: "message.updated", properties: { sessionID, info: { id: messageID, role: "assistant" } } }]
        : [];
    case "session.retry.scheduled": {
      const err = d.error as { message?: string } | undefined;
      return status({ type: "retry", message: err?.message ?? "Retrying…" });
    }
    case "session.reasoning.started":
      return partStarted("reasoning");
    case "session.reasoning.delta":
      return partDelta("reasoning");
    case "session.reasoning.ended":
      return partEnded("reasoning");
    case "session.text.started":
      return partStarted("text");
    case "session.text.delta":
      return partDelta("text");
    case "session.text.ended":
      return partEnded("text");
    case "session.execution.succeeded":
      return status({ type: "idle" });
    case "session.execution.failed":
      return [
        ...(sessionID ? [{ type: "session.error", properties: { sessionID, error: d.error ?? {} } }] : []),
        ...status({ type: "idle" }),
      ];
    default:
      // server.connected, session.input.*, session.instructions.updated,
      // session.step.ended, session.usage.updated, etc. — no v1 equivalent
      // T3 needs; drop them.
      return [];
  }
}

/**
 * Translate the v2 `session.*` SSE stream into the v1 events T3's reducer
 * consumes, re-framed as Server-Sent Events. Fail-open: any line we can't
 * parse or map is dropped rather than breaking the stream.
 *
 * See `docs/opencode2-beta-compat.md` for the full event mapping table. This is
 * the load-bearing piece for live streaming chat and the most drift-prone —
 * re-capture the event payloads and re-verify `translateEvent` after an
 * opencode2 update.
 */
function translateEventStream(response: Response): Response {
  if (!response.body) return response;

  const startTimes = new Map<string, number>();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  const emit = (controller: { enqueue: (chunk: Uint8Array) => void }, frame: string) => {
    const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
    if (!dataLine) return;
    let v2Event: { type?: string; created?: number; data?: Record<string, unknown> };
    try {
      v2Event = JSON.parse(dataLine.slice(5).trim());
    } catch {
      return;
    }
    for (const v1Event of translateEvent(v2Event, startTimes)) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(v1Event)}\n\n`));
    }
  };

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        emit(controller, frame);
      }
    },
    flush(controller) {
      if (buffer.trim().length > 0) emit(controller, buffer);
    },
  });

  return new Response(response.body.pipeThrough(transform), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
