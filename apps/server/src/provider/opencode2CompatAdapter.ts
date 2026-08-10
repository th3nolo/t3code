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
  const authHeader =
    options.password != null && options.password.length > 0
      ? `Basic ${Buffer.from(`opencode:${options.password}`, "utf8").toString("base64")}`
      : null;

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

    // Rebuild the request with the rewritten URL and injected auth.
    const headers = new Headers(
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
 * Translate the v2 `session.*` SSE event stream into the v1 events T3's
 * reducer consumes. NOT YET IMPLEMENTED — passes the stream through unchanged.
 *
 * To implement: read the SSE body, and for each `data:` JSON event map the v2
 * `type` (server.connected, session.created, session.step.started,
 * session.reasoning.delta, session.text.delta, session.step.finished, …) to
 * the corresponding v1 event (session.updated, message.updated,
 * message.part.updated, …), re-serializing as SSE. See the event table in
 * `docs/opencode2-beta-compat.md`. This is the load-bearing piece for live
 * streaming chat and the most likely thing to drift between builds.
 */
function translateEventStream(response: Response): Response {
  return response;
}
