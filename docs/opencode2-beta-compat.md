# OpenCode v2 (opencode2) beta compatibility — agent playbook

> **Audience:** an AI agent (or human) maintaining this fork's OpenCode v2
> preview support. OpenCode v2 is a fast-moving **beta**: its CLI binary,
> HTTP routes, and payload shapes change every few days. This document is the
> map so you don't have to re-reverse-engineer it from scratch each time.
> Everything here was verified empirically against a live `opencode2` build —
> **re-verify against the build on disk before trusting any specific shape.**

Last verified against: `opencode2 v0.0.0-next-17086`, server OpenAPI
`title: "opencode HttpApi", version: "0.0.1"` (the API version string does not
track the CLI build — ignore it).

---

## TL;DR — what works, what doesn't

| Capability | State | Where |
|---|---|---|
| Provider **detection** (installed + version) | ✅ done | `OpenCodeProvider.ts` |
| Model **list** (inventory) | ✅ done, via CLI `models` | `opencodeRuntime.ts` `loadInventoryFromCli` |
| Version **advisory** (no false "update" nag) | ✅ done | `providerMaintenance.ts` |
| Background **service** auto-start before probes | ✅ done | `opencodeRuntime.ts` |
| **Chat** (sessions/prompt/streaming) | 🟡 **built, needs live-UI validation** | `opencode2CompatAdapter.ts` |

Raw chat **works** against opencode2 — verified end to end at the HTTP level
(create session → prompt free model → assistant reply received). The
translation layer between T3's bundled v1-era SDK expectations and v2's wire
protocol is now built (path rewrite + auth + response reshaping + SSE event
translation) and unit-tested — the `translateEvent` mapping was validated by
replaying a real captured turn through a faithful reducer simulation (it
reconstructs the assistant text and completes the turn). What remains is
**live validation inside T3's actual Electron UI**: the SSE translation only
fully proves out against the real reducer, and the spawn/connect wiring (below)
hasn't been exercised end to end in the running app.

---

## The five layers of incompatibility

Each was a separate failure, fixed (or specified) independently. When chat or
detection breaks after an opencode2 update, figure out **which layer** moved.

### 1. Version string — `0.0.0-<channel>-<build>`
opencode2 versions every build as `0.0.0-next-NNNNN` / `0.0.0-beta-…` /
`0.0.0-dev-…` / `0.0.0-tui-v2-…`. It also prints `opencode2 v0.0.0-next-NNNNN`
(a `v` prefix with no word boundary before the digit).
- Breaks: the plain semver parser (no match on `v0…`) and the
  `MINIMUM_OPENCODE_VERSION` gate (`0.0.0` always loses).
- Fixed in `OpenCodeProvider.ts`: `parseOpenCodeCliVersion` accepts the `v`
  prefix + prerelease; `OPENCODE_V2_PREVIEW_VERSION_PATTERN` skips the minimum
  gate for preview builds.
- Same pattern reused in `providerMaintenance.ts` `deriveVersionAdvisory` so
  the npm-`latest` (stable v1) comparison stops nagging preview users.

### 2. CLI surface changed
- `models --verbose` → flag removed; v2 prints **help text with exit 0**.
- `models` → prints **bare `provider/model` slug lines**, no JSON metadata.
- `agent list` → gone (`ERROR … chdir 'agent'`), harmlessly tolerated.
- Fixed in `opencodeRuntime.ts`:
  - `parseModelsCliOutput` synthesizes `{id, name}` from slug-only lines.
  - `loadInventoryFromCli` falls back `models --verbose` → `models` →
    `models --standalone`, and includes stderr in failure detail.

### 3. CLI needs a background **service**
v2 CLI commands are thin clients over a persistent background server. Spawned
non-interactively (as from the health check) they fail if the service is down.
- Fixed: `loadInventoryFromCli` runs `opencode2 service start` (idempotent;
  fast no-op failure on v1) before probing.
- Service management: `service start|restart|status|stop`, `pair` (prints URL +
  Username `opencode` + Password), `service get|set <key> <value>`.

### 4. HTTP routes moved under `/api/*` **and no published SDK matches**
The server serves everything under `/api/…`. Checked all three SDK dist-tags:
- `@opencode-ai/sdk@beta` → generates `/agent`, `/global/health`, `/experimental/*`
- `@opencode-ai/sdk@next` (older build, 16233) → `/provider`, `/session`, `/agent`
- **server (17086)** → `/api/provider`, `/api/session`, `/api/agent`

So **no published SDK targets the live server.** T3 bundles a v2 SDK that calls
`/provider` etc. → 404. This is the core reason chat is unwired.

### 5. Auth + payload shapes diverged (see full map below)
Every route requires HTTP Basic `opencode:<password>` even on localhost.
Responses are wrapped `{location, data}`. Messages are a flat, redesigned
model. The event stream is a new `session.*` namespace.

---

## Full v2 wire protocol (verified)

**Base:** `http://127.0.0.1:<port>`; all data routes under `/api/`.
**Auth (required, even localhost):** `Authorization: Basic base64("opencode:"+password)`.
Password + URL come from `opencode2 pair` (background service) or the
`server listening on <url>` / `server password <pw>` lines that
`opencode2 serve` prints on stdout.

> **Architectural gotcha:** a freshly-spawned `opencode2 serve` on a random
> port has **no connected providers/auth** — provider list comes back empty.
> The **background service** (via `pair`) is where the authenticated providers
> live. Any chat integration must talk to the service, not a bare spawned
> server. The service URL/password **rotate on restart** — they must be
> re-read from `pair`/stdout each session, never cached.

### Routes used for chat (operationId — METHOD path)
```
v2.provider.list          GET  /api/provider
v2.agent.list             GET  /api/agent
v2.session.create         POST /api/session
v2.session.get            GET  /api/session/{sessionID}
v2.session.list           GET  /api/session
v2.session.prompt         POST /api/session/{sessionID}/prompt
v2.message.list           GET  /api/session/{sessionID}/message
v2.session.permission.reply POST /api/session/{sessionID}/permission/{requestID}/reply
v2.session.question.reply   POST /api/session/{sessionID}/question/{requestID}/reply
v2.session.interrupt      POST /api/session/{sessionID}/interrupt
v2.event.subscribe        GET  /api/event   (SSE stream)
```
All accept an optional `?directory=<abs path>` query (deepObject `location[...]`
also accepted). Use an absolute project dir; providers are resolved per dir.

### Request shapes
```jsonc
// POST /api/session            (all fields optional)
{ "title": "…", "model": { "providerID": "opencode", "id": "grok-code" },
  "location": { "directory": "C:\\abs\\path" } }
// NB Model.Ref is { id, providerID, variant? } — the model key is `id`, NOT `modelID`.

// POST /api/session/{id}/prompt
{ "text": "…", "model": { "providerID": "opencode", "id": "grok-code" } }
// text is a top-level string (NOT v1's { parts:[{type:"text",text}] }).
// Returns immediately with a pending user message; the reply streams via events.
```

### Response shapes (the reshaping the adapter must do)
```jsonc
// GET /api/provider  → { location, data: [ {id, integrationID, name, package, settings, headers?} ] }
//   NOTE: providers carry NO models here. provider.get also has no models.
//   Model list must come from the CLI `models` path (already implemented).
//   T3's SDK inventory expects { all:[…with models], connected:[…], default:{} } — diverged.

// POST /api/session → { data: Session.Info { id:"ses_…", projectID, cost, tokens, time, title?, location } }

// GET /api/session/{id}/message → { data: [ Message ], cursor }
//   USER message (flat):      { id, time, text, type:"user" }
//   ASSISTANT message (flat): { id, time:{created,completed}, type:"assistant",
//     agent, model:{id,providerID}, finish, cost, tokens,
//     content: [ {type:"text", text} | {type:"reasoning", text, state, time} ] }
//   i.e. reply text lives in content[] items of type "text".
//   T3's UI expects v1 { info:{id, role, …}, parts:[{type, text, …}] }.
//   Adapter mapping: role = type; parts = content (map reasoning→reasoning part,
//   text→text part); user message → single {type:"text", text} part.
```

### Event stream (SSE `GET /api/event`)
New `session.*` namespace, one JSON object per `data:` line. Observed types:
```
server.connected, session.created, session.input.admitted,
session.execution.started, session.instructions.updated, session.input.promoted,
session.step.started, session.reasoning.started, session.reasoning.delta,
session.text.delta (analogous), session.step.finished, …
```
Each carries `{ id, type, created, durable:{aggregateID:"ses_…"}, … }`.
T3's reducer consumes **v1** event names (`message.updated`,
`message.part.updated`, `session.updated`, …). Translating this stream is the
**largest** part of a chat adapter and the most likely thing to drift.

---

## The chat adapter (built — how it works)

Single injection point: T3 constructs the client via `createOpencodeClient` in
`createOpenCodeSdkClient` (`opencodeRuntime.ts`). The hey-api `Config` accepts a
`fetch?: typeof fetch`, so we pass `createOpencode2Fetch(globalThis.fetch,
{password})` from `opencode2CompatAdapter.ts`, which:

1. **Rewrites paths** `/(provider|agent|session|event|…)` → `/api/$1`.
2. **Injects Basic auth** from the server password.
3. **Reshapes JSON responses** (`transformJsonBody`) — provider.list and
   message.list are the load-bearing ones. Fail-open: unrecognized shapes pass
   through untouched, so drift degrades instead of crashing.
4. **Translates the SSE event stream** (`translateEvent` + `translateEventStream`)
   — each v2 `session.*` event becomes the v1 event(s) T3's reducer expects
   (see the mapping in the code + the event table above). Synthesizes a stable
   `partID` from `(assistantMessageID, kind, ordinal)` and, crucially, sets
   `time.end` on the final text part so T3 marks the turn complete.

**v1/v2 gating:** the adapter is a **pure pass-through when no password is
present**. v2 requires auth, v1 has none — so password-presence is the v2
signal, and a v1/unauthenticated server sees no path rewrite or reshaping.

Spawn/connect wiring (also done):
- `parseServerUrlFromOutput` now matches both `"opencode server listening on"`
  (v1) and `"server listening on"` (v2).
- `parseServerPasswordFromOutput` captures the password the v2 server prints on
  startup; it flows through `OpenCodeServerProcess/Connection.password` into
  `createOpenCodeSdkClient` as `serverPassword` for servers we spawn.
- A spawned `serve` loads its providers/auth **asynchronously (~3s)** — the
  provider list is briefly empty right after startup. T3's inventory already
  retries; don't treat an initial empty list as failure. (This is why the
  background service *looked* required earlier — it wasn't, it was just warm.)

### What still needs doing — live-UI validation
Unit-shape tests + the reducer simulation pass, but the real proof is driving
T3's Electron UI: send a message and watch it stream. Re-capture events and
re-verify `translateEvent` after any opencode2 update — the event stream is the
most drift-prone surface. If streaming looks wrong, diff a freshly captured
turn's event types/payloads against the table above.

---

## Repair playbook — when it breaks after an opencode2 update

1. **Reproduce raw first.** `opencode2 pair` for URL+password, then curl/fetch
   `GET /api/provider`, `POST /api/session`, `POST /api/session/{id}/prompt`
   (see `docs/` scratch scripts or reconstruct from shapes above). If raw chat
   works but T3 doesn't, the break is in the adapter, not opencode2.
2. **Re-pull the live contract.** `GET /openapi.json` (with auth) is the source
   of truth for routes + schemas on the current build. Diff route/operationId
   and request/response schemas against the "Full v2 wire protocol" section;
   update this doc and the adapter together.
3. **Identify the moved layer** using the five-layers list. Version/CLI/service
   layers are in `OpenCodeProvider.ts`/`opencodeRuntime.ts`/`providerMaintenance.ts`;
   route/shape/event layers are in the chat adapter.
4. **Keep transforms fail-open.** Any unrecognized shape should pass through,
   and any probe should fall back rather than hard-error — preview builds will
   surprise you.
5. **Re-apply to the installed desktop app** if testing there: the fix also
   lives as an in-place patch of
   `…/resources/app.asar.unpacked/apps/server/dist/bin.mjs`
   (re-apply script: `~/.local/bin/t3-reapply-opencode2-patch.mjs`), because
   T3's auto-updater overwrites it. The durable home is this fork.

## Commit trail (fork branch `fix/opencode2-beta`)
- version gate + parser; models slug parse + fallbacks; version advisory +
  probe hardening; service auto-start. (See `git log` on this branch.)
- chat adapter: path/auth/response reshaping + SSE `translateEvent`; wired into
  `createOpenCodeSdkClient`; server ready-prefix + password capture. Verified
  against `v0.0.0-next-17086`; live-UI validation pending.
