/**
 * OpenCode v2 (opencode2) beta compatibility adapter.
 *
 * The bundled `@opencode-ai/sdk/v2` targets an older wire protocol than the
 * live opencode2 preview server: routes moved under `/api/*`, requests need
 * HTTP Basic auth, request/response payload shapes were redesigned, and some
 * operations moved endpoint (notably prompt). This module provides a `fetch`
 * wrapper (the one hook hey-api's client exposes) that bridges the gap without
 * touching T3's call sites.
 *
 * See `docs/opencode2-beta-compat.md` for the full protocol map and repair
 * playbook. opencode2 is a fast-moving beta — transforms are fail-open where
 * possible: on an unrecognized shape they return the input untouched.
 *
 * Validated end to end (create -> switchModel -> prompt -> streamed reply ->
 * turn complete) against `v0.0.0-next-17088` through T3's exact SDK call shapes.
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

// --- response reshaping ------------------------------------------------------

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
  if (Array.isArray(m.content)) parts = m.content.map((c) => ({ type: c.type ?? "text", text: c.text }));
  else if (typeof m.text === "string") parts = [{ type: "text", text: m.text }];
  else parts = [];
  const { content: _c, text: _t, type: _ty, ...rest } = m;
  return { info: { ...rest, id: m.id, role }, parts };
}

/**
 * Reshape a v2 JSON response body into the shape T3's SDK/adapter expects,
 * keyed by (method, path). Returns `undefined` to mean "no transform". Exported
 * for unit testing.
 */
export function transformJsonBody(method: string, pathname: string, body: unknown): unknown {
  // GET /api/provider — v2 { location, data:[…] } → v1 { all, connected, default }.
  // (models come from the CLI path; this keeps the SDK inventory call from throwing.)
  if (method === "GET" && pathname === `${API_PREFIX}/provider`) {
    const data = (body as { data?: unknown })?.data;
    if (Array.isArray(data)) {
      const all = data.map((p) => ({ ...(p as object), models: (p as { models?: unknown }).models ?? {} }));
      return { all, connected: all.map((p: { id?: string }) => p.id).filter(Boolean), default: {} };
    }
    return undefined;
  }
  // GET /api/session/{id}/message — flat v2 messages → bare array of v1 { info, parts }.
  // T3 reads `result.data` as the array (see session.messages consumers).
  if (method === "GET" && /\/api\/session\/[^/]+\/message$/.test(pathname)) {
    const data = (body as { data?: unknown })?.data;
    if (Array.isArray(data)) return data.map(toV1Message);
    return undefined;
  }
  // Single-object session endpoints (create/get): unwrap v2's { data: X } envelope
  // to X, so T3 reads `result.data.id` etc. Skip list responses (they carry cursor).
  if (
    /\/api\/session(\/[^/]+)?$/.test(pathname) &&
    body &&
    typeof body === "object" &&
    "data" in (body as object) &&
    !("cursor" in (body as object))
  ) {
    return (body as { data: unknown }).data;
  }
  return undefined;
}

// --- request reshaping -------------------------------------------------------

function extractText(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("");
}

// --- event stream translation ------------------------------------------------

function partId(messageID: string, kind: "text" | "reasoning", ordinal: number): string {
  return `${messageID}::${kind}::${ordinal}`;
}

/**
 * Map a single v2 `session.*` event to zero or more v1 events (`{type,
 * properties}`) that T3's OpenCodeAdapter switch understands. `startTimes`
 * carries per-part start timestamps so `*.ended` can emit `time: {start, end}`
 * — the final text part MUST carry `time.end` or T3 never completes the turn.
 * Exported for unit testing.
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
  const partDelta = (kind: "text" | "reasoning") =>
    !messageID || !sessionID
      ? []
      : [
          {
            type: "message.part.delta",
            properties: { sessionID, partID: partId(messageID, kind, ordinal), delta: String(d.delta ?? "") },
          },
        ];
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
      return [];
  }
}

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

async function reshapeResponse(method: string, pathname: string, response: Response): Promise<Response> {
  if (pathname === `${API_PREFIX}/event`) return translateEventStream(response);
  if (!(response.headers.get("content-type") ?? "").includes("application/json")) return response;
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    return response;
  }
  const transformed = transformJsonBody(method, pathname, body);
  if (transformed === undefined) return response;
  return new Response(JSON.stringify(transformed), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Wrap a base `fetch` so the v1-era SDK reaches the v2 server: rewrite paths
 * under /api, inject Basic auth, translate the prompt request, and reshape
 * responses + the SSE event stream. Pure pass-through when no password is
 * present (v2 requires auth; v1 has none, so password presence is the v2
 * signal), leaving v1/unauthenticated servers untouched.
 */
export function createOpencode2Fetch(
  baseFetch: typeof fetch,
  options: Opencode2CompatOptions = {},
): typeof fetch {
  if (options.password == null || options.password.length === 0) return baseFetch;
  const authHeader = `Basic ${Buffer.from(`opencode:${options.password}`, "utf8").toString("base64")}`;

  return async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const isReq = input instanceof Request;
    const originalUrl = isReq ? input.url : String(input);
    const method = ((isReq ? input.method : init?.method) ?? "GET").toUpperCase();

    let targetUrl = originalUrl;
    let pathname: string | null = null;
    let search = "";
    try {
      const url = new globalThis.URL(originalUrl);
      if (shouldRewrite(url.pathname)) {
        url.pathname = `${API_PREFIX}${url.pathname}`;
        targetUrl = url.toString();
      }
      pathname = url.pathname;
      search = url.search;
    } catch {
      // non-absolute URL — leave it alone
    }

    const headers = new globalThis.Headers(
      isReq ? input.headers : (init?.headers as HeadersInit | undefined),
    );
    if (!headers.has("authorization")) headers.set("authorization", authHeader);

    let bodyText: string | undefined;
    if (isReq) {
      try {
        bodyText = await input.clone().text();
      } catch {
        /* no body */
      }
    } else if (init?.body != null && typeof init.body === "string") {
      bodyText = init.body;
    }

    // Prompt translation: the bundled SDK POSTs session.prompt to
    // /session/{id}/message and session.promptAsync (the chat path) to
    // /session/{id}/prompt_async; v2's prompt endpoint is POST
    // /session/{id}/prompt with body {text}. v2 also ignores a model in the
    // prompt body, so switch the model first.
    if (method === "POST" && pathname && /\/api\/session\/[^/]+\/(message|prompt_async)$/.test(pathname)) {
      let obj: { model?: unknown; text?: string; parts?: unknown } = {};
      try {
        obj = bodyText ? JSON.parse(bodyText) : {};
      } catch {
        /* keep {} */
      }
      const sid = pathname.split("/")[3];
      const origin = new globalThis.URL(targetUrl).origin;
      if (obj.model) {
        try {
          await baseFetch(`${origin}${API_PREFIX}/session/${sid}/model${search}`, {
            method: "POST",
            headers: new globalThis.Headers({ authorization: authHeader, "content-type": "application/json" }),
            body: JSON.stringify({ model: obj.model }),
          });
        } catch {
          /* best-effort model switch */
        }
      }
      bodyText = JSON.stringify({ text: obj.text ?? extractText(obj.parts) });
      headers.set("content-type", "application/json");
      const url = new globalThis.URL(targetUrl);
      url.pathname = url.pathname.replace(/\/(message|prompt_async)$/, "/prompt");
      targetUrl = url.toString();
      pathname = url.pathname;
    }

    const sendInit: RequestInit = { ...(isReq ? {} : init), method, headers };
    if (bodyText !== undefined && method !== "GET" && method !== "HEAD") sendInit.body = bodyText;

    const response = await baseFetch(targetUrl, sendInit);
    if (pathname === null) return response;
    return reshapeResponse(method, pathname, response);
  };
}
