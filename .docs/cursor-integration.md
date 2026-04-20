# Cursor ACP integration

> **Why this doc is the longest.** Cursor's ACP CLI (`agent acp`) is a pre-release binary. Most of
> the design encodes workarounds for things that aren't pinned by spec yet: capability discovery,
> fuzzy config-option matching, model-id annotation stripping, plan dedup, parameterized model
> picker negotiation, and a developer probe. File/line references are for commit `9df3c640`.

---

## Table of contents

1. [ACP protocol overview](#1-acp-protocol-overview)
2. [CLI discovery and spawn](#2-cli-discovery-and-spawn)
3. [Handshake](#3-handshake)
4. [CursorSessionContext](#4-cursorsessioncontext)
5. [Session start sequence](#5-session-start-sequence)
6. [Turn loop](#6-turn-loop)
7. [Notification fiber and event mapping](#7-notification-fiber-and-event-mapping)
8. [ACP method strings — full inventory](#8-acp-method-strings--full-inventory)
9. [Extension handlers](#9-extension-handlers)
10. [Permission handler](#10-permission-handler)
11. [Model selection and config application](#11-model-selection-and-config-application)
12. [Resume cursor](#12-resume-cursor)
13. [Capability negotiation](#13-capability-negotiation)
14. [Provider snapshot and model discovery](#14-provider-snapshot-and-model-discovery)
15. [Stop sequence](#15-stop-sequence)
16. [AcpSessionRuntime internals](#16-acpsessionruntime-internals)
17. [AcpRuntimeModel.ts](#17-acpruntimemodelts)
18. [AcpCoreRuntimeEvents.ts](#18-acpcoreruntimeeventsts)
19. [CursorAcpExtension.ts](#19-cursoracpextensiondts)
20. [effect-acp library](#20-effect-acp-library)
21. [Probe script](#21-probe-script)
22. [Workarounds catalog](#22-workarounds-catalog)
23. [Tests](#23-tests)

---

## 1. ACP protocol overview

ACP (Agent Client Protocol) is **JSON-RPC 2.0 over stdio** with newline-delimited framing. The
shared implementation lives in `packages/effect-acp/`.

Key files:

| File                                               | Role                                                     |
| -------------------------------------------------- | -------------------------------------------------------- |
| `packages/effect-acp/src/client.ts`                | `AcpClient` service — sends requests, registers handlers |
| `packages/effect-acp/src/agent.ts`                 | Typed wrappers for every agent-side RPC method           |
| `packages/effect-acp/src/terminal.ts`              | `AcpTerminal` interface for terminal I/O                 |
| `packages/effect-acp/src/_generated/schema.gen.ts` | Effect Schema types for every payload                    |

**Wire format:**

- Outbound (client → agent): `{id, method, params}\n` (requests) or `{method, params}\n` (notifications)
- Inbound (agent → client): `{id, result}\n` / `{id, error}\n` (responses) or `{method, params}\n` (server-initiated requests/notifications)

The `AcpClient` wraps a `ChildProcessSpawner`-spawned process and exposes typed Effect operations for each RPC call. Extension methods (Cursor-specific) are registered via `handleExtRequest` / `handleExtNotification`.

---

## 2. CLI discovery and spawn

`apps/server/src/provider/acp/CursorAcpSupport.ts:32-44` — `buildCursorAcpSpawnInput`:

```typescript
export function buildCursorAcpSpawnInput(
  cursorSettings: CursorAcpRuntimeCursorSettings | null | undefined,
  cwd: string,
): AcpSpawnInput {
  return {
    command: cursorSettings?.binaryPath || "agent", // default binary name
    args: [
      ...(cursorSettings?.apiEndpoint ? (["-e", cursorSettings.apiEndpoint] as const) : []),
      "acp",
    ],
    cwd,
  };
}
```

**Defaults:**

- Binary: `"agent"` (the Cursor pre-release agent binary)
- Args: `["acp"]`; prepended with `["-e", endpoint]` when `apiEndpoint` is configured
- Shell: `process.platform === "win32"` — set at spawn time in `AcpSessionRuntime.ts:166`
- Env: `process.env` merged with any optional spawn-time overrides

`makeCursorAcpRuntime` (`CursorAcpSupport.ts:48-65`) wraps `AcpSessionRuntime.layer(...)` with Cursor's spawn input and `parameterizedModelPicker` client capability, and returns an `AcpSessionRuntimeShape`.

---

## 3. Handshake

`AcpSessionRuntime.ts:551-620`. Three steps, in order:

### Step 1 — `initialize`

RPC method: `"initialize"`. Payload:

```typescript
{
  protocolVersion: 1,
  clientCapabilities: {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
    _meta: { parameterizedModelPicker: true },   // Cursor-specific flag
  },
  clientInfo: { name: string, version: string },
}
```

Response (`InitializeResponse`) is stored as `initializeResult`.

### Step 2 — `authenticate`

RPC method: `"authenticate"`. Payload:

```typescript
{
  methodId: "cursor_login";
}
```

The CLI handles the actual auth flow (browser / token). Any error propagates immediately.

### Step 3 — `session/load` → fallback `session/new`

When `resumeSessionId` is provided, `session/load` is attempted first (`AcpSessionRuntime.ts:604-625`):

```typescript
const resumed =
  yield *
  runLoggedRequest(
    "session/load",
    loadPayload,
    acp.agent.loadSession({ sessionId: options.resumeSessionId, cwd, mcpServers: [] }),
  ).pipe(Effect.exit);

if (Exit.isSuccess(resumed)) {
  sessionId = options.resumeSessionId;
  sessionSetupResult = resumed.value;
} else {
  // Silently fall back — session expiry is expected in pre-release
  const created =
    yield *
    runLoggedRequest(
      "session/new",
      createPayload,
      acp.agent.createSession({ cwd, mcpServers: [] }),
    );
  sessionId = created.sessionId;
  sessionSetupResult = created;
}
```

If no `resumeSessionId`, `session/new` is called directly.

After session setup, `parseSessionModeState(sessionSetupResult)` and `sessionConfigOptionsFromSetup(sessionSetupResult)` populate internal Ref cells for mode and config state.

**`AcpSessionRuntimeStartResult`** carries:

- `sessionId` — assigned ACP session ID
- `initializeResult` — server capabilities
- `sessionSetupResult` — the full `NewSessionResponse` / `LoadSessionResponse` (contains `configOptions`)
- `modelConfigId` — extracted from config options where `category === "model"`, or `undefined`

---

## 4. CursorSessionContext

`CursorAdapter.ts:99-111`:

```typescript
interface CursorSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntimeShape;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  lastPlanFingerprint: string | undefined;
  activeTurnId: TurnId | undefined;
  stopped: boolean;
}
```

| Field                 | Purpose                                                                             |
| --------------------- | ----------------------------------------------------------------------------------- |
| `threadId`            | T3 Code thread identifier                                                           |
| `session`             | Mutable `ProviderSession` — updated on each turn (model, runtimeMode, resumeCursor) |
| `scope`               | Effect scope that owns the ACP subprocess — closing it kills the process            |
| `acp`                 | Live `AcpSessionRuntimeShape` for sending RPC calls                                 |
| `notificationFiber`   | Background fiber draining `acp.getEvents()` — started after `acp.start()`           |
| `pendingApprovals`    | In-flight `session/request_permission` requests waiting for user decision           |
| `pendingUserInputs`   | In-flight `cursor/ask_question` requests waiting for user answers                   |
| `turns`               | History of completed turns — each `{ id, items: [{ prompt, result }] }`             |
| `lastPlanFingerprint` | `"${activeTurnId}:${JSON.stringify(plan)}"` — deduplicates plan update events       |
| `activeTurnId`        | Set at turn start, cleared at turn end and session stop                             |
| `stopped`             | Idempotency guard — `requireSession()` rejects stopped contexts                     |

---

## 5. Session start sequence

`CursorAdapter.ts:425-695` — `startSession`:

1. Validate `input.provider === "cursor"` and `input.cwd` non-empty.
2. If a session already exists for `input.threadId` and is not stopped, call `stopSessionInternal(existing)`.
3. Create `sessionScope`, `pendingApprovals`, `pendingUserInputs` Maps.
4. Extract `resumeSessionId = parseCursorResume(input.resumeCursor)?.sessionId`.
5. Call `makeCursorAcpRuntime(...)` — builds ACP runtime, which spawns the process and holds the scope.
6. Register `cursor/ask_question`, `cursor/create_plan`, `cursor/update_todos` extension handlers (before `acp.start()` so no request arrives unhandled).
7. Register `session/request_permission` handler.
8. Call `acp.start()` — runs the handshake (§3). Returns `AcpSessionRuntimeStartResult`.
9. Build `ProviderSession` with `resumeCursor: { schemaVersion: 1, sessionId: started.sessionId }`.
10. Construct `CursorSessionContext` (ctx).
11. Call `applyRequestedSessionConfiguration(...)` to set initial model/mode.
12. Fork notification fiber via `Stream.runDrain(Stream.mapEffect(acp.getEvents(), ...)).pipe(Effect.forkChild)`.
13. Store `ctx.notificationFiber = nf`.
14. Add ctx to `sessions` map.
15. Emit `session.started`, `session.state.changed { state: "ready" }`, `thread.started`.
16. Return `ProviderSession`.

---

## 6. Turn loop

`CursorAdapter.ts:813-931` — `sendTurn`:

1. **Validate** — `requireSession(input.threadId)` (fails if `ctx.stopped`).
2. **Generate** `turnId = TurnId.make(crypto.randomUUID())`.
3. **Resolve model** — strip bracket annotations: `resolveCursorAcpBaseModelId(model)`.
4. **Apply config** — `applyRequestedSessionConfiguration(...)` (see §11).
5. **Update context** — `ctx.activeTurnId = turnId`, `ctx.lastPlanFingerprint = undefined`.
6. **Emit** `turn.started { model: resolvedModel }`.
7. **Build prompt** — text block + base64-encoded image blocks for attachments.
8. **Call `acp.prompt({ prompt: promptParts })`** — RPC method `"session/prompt"`. Blocks until agent finishes the turn. While waiting, the notification fiber streams events.
9. **afterTurn** — push `{ id: turnId, items: [{ prompt, result }] }` to `ctx.turns`.
10. **Update session** — clear `activeTurnId`, set `model: resolvedModel`.
11. **Emit** `turn.completed { state: "cancelled" | "completed", stopReason }`.
12. **Return** `{ threadId, turnId, resumeCursor }`.

**`interruptTurn`** (`CursorAdapter.ts:933-945`):

1. Settle all `pendingApprovals` as `"cancel"`.
2. Settle all `pendingUserInputs` as empty answers.
3. Call `ctx.acp.cancel` — RPC notification `"session/cancel"`.

---

## 7. Notification fiber and event mapping

`CursorAdapter.ts:696-781`. The fiber drains `acp.getEvents()` — a stream of `AcpParsedSessionEvent` — and translates each to a `ProviderRuntimeEvent` emitted to the runtime PubSub.

| `AcpParsedSessionEvent._tag` | `ProviderRuntimeEvent` emitted     | Notes                                                        |
| ---------------------------- | ---------------------------------- | ------------------------------------------------------------ |
| `ModeChanged`                | _(none)_                           | Mode state updated internally, not surfaced to UI            |
| `AssistantItemStarted`       | `item.started`                     | `itemType: "assistant_message"`, `status: "inProgress"`      |
| `AssistantItemCompleted`     | `item.completed`                   | `itemType: "assistant_message"`, `status: "completed"`       |
| `PlanUpdated`                | `turn.plan.updated`                | Deduplicated via `lastPlanFingerprint`; also logged natively |
| `ToolCallUpdated`            | `item.updated` or `item.completed` | Tool kind normalized — see `AcpCoreRuntimeEvents.ts`         |
| `ContentDelta`               | `content.delta`                    | `streamKind: "assistant_text"`, text payload from delta      |

**Empty deltas** (`ContentDelta` with empty `text`) are dropped before emission.

**Native event logging:** `PlanUpdated`, `ToolCallUpdated`, `ContentDelta` are written to the NDJSON native event log via `logNative(...)` before their canonical events are emitted.

---

## 8. ACP method strings — full inventory

### Agent methods (client → agent)

| Method                        | Where called               | Purpose                                      |
| ----------------------------- | -------------------------- | -------------------------------------------- |
| `"initialize"`                | `AcpSessionRuntime.ts:590` | Protocol handshake                           |
| `"authenticate"`              | `AcpSessionRuntime.ts:600` | Identity auth (`"cursor_login"`)             |
| `"session/new"`               | `AcpSessionRuntime.ts:613` | Create new session                           |
| `"session/load"`              | `AcpSessionRuntime.ts:606` | Resume from `sessionId`                      |
| `"session/set_config_option"` | `AcpSessionRuntime.ts:543` | Set model, effort, context, fast, thinking   |
| `"session/set_mode"`          | `AcpSessionRuntime.ts`     | Set interaction mode (plan, implement, etc.) |
| `"session/prompt"`            | `AcpSessionRuntime.ts:467` | Send turn                                    |
| `"session/cancel"`            | `AcpSessionRuntime.ts:563` | Interrupt running turn (notification)        |

### Client methods (agent → client, registered as handlers)

| Method                         | Handler file           | Purpose                       |
| ------------------------------ | ---------------------- | ----------------------------- |
| `"session/request_permission"` | `CursorAdapter.ts:584` | Tool approval request         |
| `"session/elicitation"`        | effect-acp (sink)      | User input                    |
| `"fs/read_text_file"`          | effect-acp (sink)      | File read                     |
| `"fs/write_text_file"`         | effect-acp (sink)      | File write                    |
| `"terminal/create"`            | effect-acp (sink)      | Terminal creation             |
| `"terminal/output"`            | effect-acp (sink)      | Read buffered terminal output |
| `"terminal/wait_for_exit"`     | effect-acp (sink)      | Wait for process exit         |
| `"terminal/kill"`              | effect-acp (sink)      | Terminate terminal process    |
| `"terminal/release"`           | effect-acp (sink)      | Release terminal handle       |

### Cursor extension methods (agent → client, extension hooks)

| Method                  | Type         | Handler                | Purpose                  |
| ----------------------- | ------------ | ---------------------- | ------------------------ |
| `"cursor/ask_question"` | request      | `CursorAdapter.ts:498` | User input elicitation   |
| `"cursor/create_plan"`  | request      | `CursorAdapter.ts:538` | Plan markdown delivery   |
| `"cursor/update_todos"` | notification | `CursorAdapter.ts:562` | Plan step status updates |

### CLI commands (spawned for discovery)

| Command                     | File                    | Purpose                                                |
| --------------------------- | ----------------------- | ------------------------------------------------------ |
| `agent about --format json` | `CursorProvider.ts:942` | Version + auth status (JSON; falls back to plain text) |
| `agent about`               | `CursorProvider.ts:947` | Plain text fallback for older CLIs                     |

---

## 9. Extension handlers

### `cursor/ask_question` (`CursorAdapter.ts:498-537`)

**Request schema** (`CursorAcpExtension.ts`): `{ toolCallId, title?, questions: [{ id, prompt, options: [{ id, label }], allowMultiple? }] }`

**Flow:**

1. Allocate `Deferred<ProviderUserInputAnswers>`, store in `pendingUserInputs`.
2. Emit `user-input.requested` with `{ questions: extractAskQuestions(params) }`.
3. `Deferred.await(answers)` — blocks the RPC callback.
4. External `respondToUserInput(threadId, requestId, answers)` resolves the Deferred.
5. Emit `user-input.resolved`.
6. Return `{ answers }` to the agent.

### `cursor/create_plan` (`CursorAdapter.ts:538-561`)

**Request schema**: `{ toolCallId, name?, overview?, plan: string, todos: [...], isProject?, phases? }`

**Flow:**

1. Emit `turn.proposed.completed { planMarkdown: extractPlanMarkdown(params) }`.
2. Always return `{ accepted: true }` — T3 Code does not gate continuation on explicit user acceptance.

### `cursor/update_todos` (`CursorAdapter.ts:562-583`)

**Request schema**: `{ toolCallId, todos: [{ id?, content?, title?, status? }], merge: boolean }`

**Flow:**

1. Convert todos via `extractTodosAsPlan(params)` → `{ plan: [{ step, status }] }`.
2. Deduplicate by `lastPlanFingerprint` (`CursorAdapter.ts:357-388`): `"${activeTurnId}:${JSON.stringify(payload)}"`.
3. If not a duplicate, emit `turn.plan.updated`.

---

## 10. Permission handler

`CursorAdapter.ts:584-649` — `acp.handleRequestPermission(...)`:

### Full-access auto-approve path (`runtimeMode === "full-access"`)

`selectAutoApprovedPermissionOption(params)` (`CursorAdapter.ts:267-281`):

1. Look for an option with `kind === "allow_always"` → return its `optionId`.
2. Else look for `kind === "allow_once"` → return its `optionId`.
3. If neither exists → fall through to deferred approval.

Response: `{ outcome: { outcome: "selected", optionId } }`.

### Deferred approval path (all other modes)

1. Create `Deferred<ProviderApprovalDecision>`.
2. Store `{ decision, kind }` in `pendingApprovals` keyed by new `requestId`.
3. Emit `request.opened` with `requestType`, `detail`, `args`.
4. `Deferred.await(decision)` — blocks the ACP callback fiber.
5. `respondToRequest(threadId, requestId, decision)` resolves it.
6. Delete from `pendingApprovals`.
7. Emit `request.resolved`.
8. Map decision to ACP outcome:

| `ProviderApprovalDecision` | ACP outcome                                          |
| -------------------------- | ---------------------------------------------------- |
| `"cancel"`                 | `{ outcome: "cancelled" }`                           |
| `"accept"`                 | `{ outcome: "selected", optionId: allow_once_id }`   |
| `"acceptForSession"`       | `{ outcome: "selected", optionId: allow_always_id }` |
| `"decline"`                | `{ outcome: "selected", optionId: reject_once_id }`  |

---

## 11. Model selection and config application

Two-level structure:

### Level 1 — `applyRequestedSessionConfiguration` (`CursorAdapter.ts:218-265`)

Called at session start (after `acp.start()`) and again at the top of every `sendTurn`.

1. If `modelSelection` is provided, call `applyCursorAcpModelSelection(...)`.
2. Resolve `requestedModeId` from `interactionMode` / `runtimeMode` using fuzzy `findModeByAliases`:
   - `interactionMode === "plan"` → search `["plan", "architect"]`
   - `runtimeMode === "approval-required"` → search `["ask"]`
   - otherwise → search `["code", "agent", "default", "chat", "implement"]`
3. Call `runtime.setMode(requestedModeId)` — RPC `"session/set_mode"`.

### Level 2 — `applyCursorAcpModelSelection` (`CursorAcpSupport.ts:75-99`)

1. **Set model** — `runtime.setModel(resolveCursorAcpBaseModelId(model))`. `resolveCursorAcpBaseModelId` strips everything after the first `[` to remove bracket annotations (e.g., `"gpt-5.4[reasoning=medium]"` → `"gpt-5.4"`).
2. **Resolve config updates** — `resolveCursorAcpConfigUpdates(configOptions, modelOptions)` (see below).
3. **Apply updates** — for each `{ configId, value }`, call `runtime.setConfigOption(configId, value)` — RPC `"session/set_config_option"`.

**Re-application is idempotent** — calling with the same values is a no-op at the protocol level, but is necessary because Cursor may mutate config internally (mode switches, plan mode) without notifying the client.

### Config update resolution (`CursorProvider.ts:388-449`)

For each of the four option categories, fuzzy-match the requested value against what the current session exposes in `configOptions`:

| Option category      | Finder                         | Match logic                                                                                          |
| -------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------- |
| **Reasoning/effort** | `findCursorEffortConfigOption` | id/name contains `"thought_level"` or related; values normalized via `normalizeCursorReasoningValue` |
| **Context window**   | `isCursorContextConfigOption`  | id/name is `"context"`, `"context_size"`, or name includes `"context"`                               |
| **Fast mode**        | `isCursorFastConfigOption`     | id `"fast"` or name `"fast"` / `"fast mode"`                                                         |
| **Thinking toggle**  | `isCursorThinkingConfigOption` | id/name includes `"thinking"`; boolean type or select with `"true"`/`"false"` values                 |

**Reasoning value normalization** (`CursorProvider.ts:116-131`):

- `"xhigh"`, `"extra-high"`, `"extra high"` → `"xhigh"`
- `"low"`, `"medium"`, `"high"`, `"max"` → unchanged
- anything else → `undefined` (not applied)

**Boolean option detection** (`CursorProvider.ts:195-199`): An option is "boolean-like" if it has `type: "boolean"` OR is a select with values `"true"` and `"false"`. Boolean requests are passed as the JS boolean `true`/`false` for native boolean options, or matched to the corresponding select value.

**Token normalization** for string matching: `toLowerCase().replace(/[\s_-]+/g, "-")`.

---

## 12. Resume cursor

**Schema version:** `CURSOR_RESUME_VERSION = 1` (`CursorAdapter.ts:80`)

**Cursor stored** (line 674-677):

```typescript
resumeCursor: {
  schemaVersion: CURSOR_RESUME_VERSION,   // 1
  sessionId: started.sessionId,
}
```

**Validation** (`parseCursorResume`, `CursorAdapter.ts:143-148`):

```typescript
function parseCursorResume(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== CURSOR_RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim() };
}
```

A schema-version mismatch silently returns `undefined` — treated as no cursor. This makes cursor format changes non-breaking.

**Fallback behavior:** If `session/load` fails (session expired, model changed, etc.), `AcpSessionRuntime` falls back to `session/new` without surfacing an error. See §3.

---

## 13. Capability negotiation

**`parameterizedModelPicker` capability** (`CursorProvider.ts:45-49`):

```typescript
export const CURSOR_PARAMETERIZED_MODEL_PICKER_CAPABILITIES = {
  _meta: { parameterizedModelPicker: true },
} satisfies NonNullable<EffectAcpSchema.InitializeRequest["clientCapabilities"]>;
```

Sent in the `initialize` request. Tells Cursor that T3 Code can handle dynamic model pickers — Cursor then includes `configOptions` in the `session/new` and `session/load` responses.

**Minimum version required:** `CURSOR_PARAMETERIZED_MODEL_PICKER_MIN_VERSION_DATE = 2026_04_08`. Channel must be `"lab"`. Older CLIs or non-lab channels return an unsupported message rather than attempting discovery.

**What `configOptions` provides:**

- A select option whose `category === "model"` → the model picker
- Per-model options (effort/reasoning, context window, fast mode, thinking toggle)
- `configOptions` array is read by `buildCursorCapabilitiesFromConfigOptions` to produce `ModelCapabilities`

---

## 14. Provider snapshot and model discovery

### `checkCursorProviderStatus` (`CursorProvider.ts:949-1075`)

1. Run `agent about` (or `agent about --format json`) with an 8-second timeout.
2. If unavailable → `status: "error"`.
3. Check `parameterizedModelPicker` minimum version date — fail early if unsupported.
4. If authenticated, call `discoverCursorModelsViaAcp` (15-second timeout).
5. Build `ServerProvider` snapshot.

**`agent about` JSON format fallback** (`CursorProvider.ts:941-947`): Try `--format json` first; if the flag is unsupported (older CLI), fall back to plain text parsing. Prevents version-dependent breakage.

### `discoverCursorModelsViaAcp` (`CursorProvider.ts:451-456`)

Spins up a short-lived ACP session, runs the handshake, reads `configOptions`, extracts model choices with current-model capabilities. Returns `ReadonlyArray<ServerProviderModel>`.

### `discoverCursorModelCapabilitiesViaAcp` (`CursorProvider.ts:458-562`)

After initial discovery, models without capabilities are probed individually:

```
For each model needing capabilities:
  → spawn new short-lived ACP session
  → if not already on the model: setConfigOption(modelOption.id, modelSlug)
  → read updated configOptions
  → buildCursorCapabilitiesFromConfigOptions(configOptions)
```

Bounded by:

- Per-model timeout: `"4 seconds"` with `Effect.retry({ times: 3 })`
- Concurrency: `CURSOR_ACP_MODEL_DISCOVERY_CONCURRENCY = 4`
- Overall discovery timeout (in `checkCursorProviderStatus`): 15 seconds

### `enrichSnapshot` callback (`CursorProvider.ts:1099-1132`)

Registered with `makeManagedServerProvider`. Runs **after** the initial probe snapshot publishes. Only runs when:

- Provider is enabled
- User is authenticated
- At least one built-in model lacks capabilities

Calls `discoverCursorModelCapabilitiesViaAcp`, then publishes an enriched snapshot. Non-fatal — failures are logged and the earlier snapshot stays active.

---

## 15. Stop sequence

`CursorAdapter.ts:402-420` — `stopSessionInternal`:

```
1. if (ctx.stopped) return;          // idempotency guard
2. ctx.stopped = true;
3. settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
4. settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
5. Fiber.interrupt(ctx.notificationFiber);
6. Scope.close(ctx.scope, Exit.void); // kills the ACP subprocess
7. sessions.delete(ctx.threadId);
8. emit session.exited { exitKind: "graceful" }
```

**Invoked by:**

- `stopSession(threadId)` — user-initiated, runs inside thread lock
- New `startSession` for the same thread — replaces old session
- Layer finalizer (`CursorAdapter.ts:1025-1030`) — adapter teardown stops all sessions

---

## 16. AcpSessionRuntime internals

`apps/server/src/provider/acp/AcpSessionRuntime.ts`

**Spawn** (`AcpSessionRuntime.ts:150-168`): Uses Effect's `ChildProcessSpawner`. Shell flag set for Windows. Env inherits `process.env` merged with optional overrides.

**Message framing**: Handled inside `packages/effect-acp/src/_internal/stdio.ts`. Outbound: serialize to JSON, append `\n`. Inbound: read line-by-line, parse JSON per line.

**`AcpSessionRuntimeShape`** exposes:

- `start()` — runs handshake, returns `AcpSessionRuntimeStartResult`
- `getEvents()` — `Stream<AcpParsedSessionEvent>` from inbound notifications
- `prompt(payload)` — sends `session/prompt`, awaits `PromptResponse`
- `cancel` — sends `session/cancel` notification
- `setModel(modelId)` — `session/set_model` RPC
- `setConfigOption(id, value)` — `session/set_config_option` RPC
- `setMode(modeId)` — `session/set_mode` via setConfigOption internally
- `getConfigOptions` — reads current session config options from internal Ref
- `getModeState` — reads current mode state from internal Ref
- `handleRequestPermission(handler)` — registers the `session/request_permission` handler
- `handleExtRequest(method, schema, handler)` — typed extension request registration
- `handleExtNotification(method, schema, handler)` — typed extension notification registration
- 8 more handler slots: `handleElicitation`, `handleReadTextFile`, `handleWriteTextFile`, `handleCreateTerminal`, `handleTerminalOutput`, `handleTerminalWaitForExit`, `handleTerminalKill`, `handleTerminalRelease`, `handleSessionUpdate`, `handleElicitationComplete`, `handleUnknownExtRequest`, `handleUnknownExtNotification`

**Process exit**: When `Scope.close(ctx.scope, Exit.void)` fires in `stopSessionInternal`, all resources bound to `runtimeScope` (including the child process) are finalized. Any pending RPC requests error out.

---

## 17. AcpRuntimeModel.ts

`apps/server/src/provider/acp/AcpRuntimeModel.ts`

### `AcpParsedSessionEvent` union

```typescript
type AcpParsedSessionEvent =
  | { _tag: "ModeChanged"; modeId: string }
  | { _tag: "AssistantItemStarted"; itemId: string }
  | { _tag: "AssistantItemCompleted"; itemId: string }
  | { _tag: "PlanUpdated"; payload: AcpPlanUpdate; rawPayload: unknown }
  | { _tag: "ToolCallUpdated"; toolCall: AcpToolCallState; rawPayload: unknown }
  | { _tag: "ContentDelta"; itemId?: string; text: string; rawPayload: unknown };
```

Produced by parsing `session/update` notifications from the ACP event stream.

### `parsePermissionRequest`

Converts a raw `RequestPermissionRequest` into `AcpPermissionRequest`:

- Extracts `kind` from `toolCall.kind` via `normalizeToolKind`
- Builds `detail` from `toolCall.command ?? toolCall.title ?? toolCall.detail`
- Includes the structured `toolCall` if present

### `mergeToolCallState`

Merges incremental `AcpToolCallState` updates preserving previous values: `next ?? previous ?? undefined` for each field. Needed because ACP sends partial updates.

### Assistant item segmentation

`AcpSessionRuntime` auto-creates synthetic `AssistantItemStarted` / `AssistantItemCompleted` events for content delta boundaries. Tracks `nextSegmentIndex` and `activeItemId` in a Ref; new delta → emit `AssistantItemStarted` if no active item; `session/update` with new item context → emit `AssistantItemCompleted` for prior.

---

## 18. AcpCoreRuntimeEvents.ts

`apps/server/src/provider/acp/AcpCoreRuntimeEvents.ts`

Factory functions that produce `ProviderRuntimeEvent` values. Each preserves `raw: { source, method, payload }`.

| Factory                       | Output `type`                      | Key payload fields                                           |
| ----------------------------- | ---------------------------------- | ------------------------------------------------------------ |
| `makeAcpRequestOpenedEvent`   | `request.opened`                   | `requestType`, `detail`, `args`                              |
| `makeAcpRequestResolvedEvent` | `request.resolved`                 | `requestType`, `decision`                                    |
| `makeAcpPlanUpdatedEvent`     | `turn.plan.updated`                | `explanation?`, `plan: [{ step, status }]`                   |
| `makeAcpToolCallEvent`        | `item.updated` or `item.completed` | `itemType` (normalized), `status`, `title`, `detail`, `data` |
| `makeAcpAssistantItemEvent`   | `item.started` or `item.completed` | `itemType: "assistant_message"`, `status`                    |
| `makeAcpContentDeltaEvent`    | `content.delta`                    | `streamKind: "assistant_text"`, `delta`                      |

**Tool kind normalization** in `makeAcpToolCallEvent`:

- `"execute"` → `"command_execution"`
- `"edit"`, `"delete"`, `"move"` → `"file_change"`
- `"search"`, `"fetch"` → `"web_search"`
- anything else → `"dynamic_tool_call"`

---

## 19. CursorAcpExtension.ts

`apps/server/src/provider/acp/CursorAcpExtension.ts`

### `extractAskQuestions(params)`

Transforms `CursorAskQuestionRequest` → `UserInputQuestion[]`:

- Each question maps: `{ id, header: "Question", question: prompt, multiSelect: allowMultiple, options }`
- If `options` is empty, inserts `[{ label: "OK", description: "Continue" }]` as a safe default.

### `extractPlanMarkdown(params)`

Returns `params.plan` if non-empty, else `"# Plan\n\n(Cursor did not supply plan text.)"`.

### `extractTodosAsPlan(params)`

Converts `todos` array to `{ plan: [{ step, status }] }`:

- `step = todo.content?.trim() ?? todo.title?.trim() ?? ""` — skips empty
- `status` mapping: `"completed"` → `"completed"`, `"in_progress"` / `"inProgress"` → `"inProgress"`, anything else → `"pending"`

---

## 20. effect-acp library

`packages/effect-acp/`

### `AcpClient` methods surface

**Agent-side (client → agent):** `initialize`, `authenticate`, `logout`, `createSession`, `loadSession`, `listSessions`, `forkSession`, `resumeSession`, `closeSession`, `setSessionModel`, `setSessionConfigOption`, `prompt`, `cancel`.

**Handler registration:** `handleRequestPermission`, `handleElicitation`, `handleReadTextFile`, `handleWriteTextFile`, `handleCreateTerminal`, `handleTerminalOutput`, `handleTerminalWaitForExit`, `handleTerminalKill`, `handleTerminalRelease`, `handleSessionUpdate`, `handleElicitationComplete`, `handleUnknownExtRequest`, `handleUnknownExtNotification`, `handleExtRequest`, `handleExtNotification`.

**Raw access:** `raw.notifications: Stream<AcpIncomingNotification>`, `raw.request(method, payload)`, `raw.notify(method, payload)`.

### `AcpTerminal` (`terminal.ts:1-24`)

```typescript
interface AcpTerminal {
  readonly sessionId: string;
  readonly terminalId: string;
  readonly output: Effect<TerminalOutputResponse, AcpError>;
  readonly waitForExit: Effect<WaitForTerminalExitResponse, AcpError>;
  readonly kill: Effect<KillTerminalResponse, AcpError>;
  readonly release: Effect<ReleaseTerminalResponse, AcpError>;
}
```

T3 Code declares `terminal: false` in `clientCapabilities` — the protocol is wired but not actively used at this snapshot.

### Reference client

`packages/effect-acp/test/examples/cursor-acp-client.example.ts:1-81` — executable example: spawn `cursor-agent acp`, layer `AcpClient.layerChildProcess()`, register permission handler, `initialize`, create session, set config option, `prompt`, `cancel`. Both documentation and smoke test.

---

## 21. Probe script

`apps/server/scripts/cursor-acp-model-mismatch-probe.ts` — developer diagnostic, not CI.

### How to run

```bash
node apps/server/scripts/cursor-acp-model-mismatch-probe.ts [cwd] [model] [prompt]
```

**Environment variables:**

| Variable                    | Default   | Purpose                                 |
| --------------------------- | --------- | --------------------------------------- |
| `CURSOR_AGENT_BIN`          | `"agent"` | Binary to spawn                         |
| `CURSOR_REASONING`          | —         | Reasoning level to set (e.g., `"high"`) |
| `CURSOR_CONTEXT`            | —         | Context window to set (e.g., `"32k"`)   |
| `CURSOR_FAST`               | —         | Fast mode (`"true"` or `"false"`)       |
| `CURSOR_PROMPT_WAIT_MS`     | `4000`    | Wait time after prompt before cancel    |
| `CURSOR_REQUEST_TIMEOUT_MS` | `20000`   | RPC request timeout                     |

### What it validates

1. CLI binary is available and `initialize` succeeds.
2. `authenticate` with `"cursor_login"` succeeds.
3. `configOptions` includes a model select option.
4. Requested model is in the advertised values.
5. `setConfigOption` works for reasoning, context, and fast mode.
6. `session/prompt` can be sent and `session/cancel` works.

Run this when adding a new Cursor model release or when the `agent` binary version changes config-option naming — it surfaces mismatches as actionable output.

---

## 22. Workarounds catalog

Pre-release Cursor ships an unstable protocol surface. These are the load-bearing special cases:

| #   | Workaround                                                 | File                           | Why                                                                                |
| --- | ---------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------- |
| 1   | `session/load` failure → silent fallback to `session/new`  | `AcpSessionRuntime.ts:604-625` | Pre-release Cursor expires sessions aggressively                                   |
| 2   | Plan fingerprint dedup                                     | `CursorAdapter.ts:357-388`     | Cursor emits duplicate `cursor/update_todos` notifications                         |
| 3   | Fuzzy config-option category matching                      | `CursorProvider.ts:156-199`    | Config option names are not pinned across releases                                 |
| 4   | Boolean-as-select detection                                | `CursorProvider.ts:195-199`    | "fast mode" and "thinking" exposed as select `["true","false"]` not native boolean |
| 5   | Model id bracket stripping (`resolveCursorAcpBaseModelId`) | `CursorProvider.ts:382-386`    | UI packs config snapshot into model id; only base id is valid for ACP              |
| 6   | Per-turn re-application of model/config                    | `CursorAdapter.ts:821`         | Cursor doesn't echo internal config mutations back                                 |
| 7   | Auto-approve in full-access mode                           | `CursorAdapter.ts:592-601`     | Avoid prompting users who already granted full access                              |
| 8   | Resume cursor schema versioning                            | `CursorAdapter.ts:80, 143`     | Session-id format may change in future CLI releases                                |
| 9   | 15s discovery timeout + concurrency 4                      | `CursorProvider.ts:40-41`      | Some models are slow to initialize; bound the probe                                |
| 10  | Reasoning value normalization                              | `CursorProvider.ts:116-131`    | CLI reports `"xhigh"`, `"extra-high"`, `"extra high"` interchangeably              |
| 11  | Token normalization for matching                           | `CursorProvider.ts:350-357`    | Option values use spaces, dashes, or underscores inconsistently                    |
| 12  | `agent about` JSON format fallback                         | `CursorProvider.ts:941-947`    | Older CLIs don't support `--format json`                                           |
| 13  | `parameterizedModelPicker` version gate                    | `CursorProvider.ts:44, 764`    | Feature only available on `lab` channel + minimum version date `2026_04_08`        |
| 14  | Tool call state merging                                    | `AcpRuntimeModel.ts:343-363`   | ACP sends incremental partial updates; must preserve prior fields                  |
| 15  | Synthetic assistant item segmentation                      | `AcpSessionRuntime.ts:705-776` | ContentDelta has no item association; auto-segment for the UI                      |

---

## 23. Tests

### Mock agent approach

`apps/server/scripts/acp-mock-agent.ts` — returns fixed responses (session ID, plan, content delta, tool calls). Wrapped via `makeMockAgentWrapper` (injects delays and env vars). Argv and request logs written to temp directory keyed off `T3_ACP_REQUEST_LOG_PATH`.

`ServerSettingsService.layerTest()` and `ServerConfig.layerTest()` provide test-mode config layers.

### Coverage at `9df3c640`

| Test                               | What it locks in                                                                         |
| ---------------------------------- | ---------------------------------------------------------------------------------------- |
| `CursorAdapter.test.ts:106-186`    | 9 canonical events on session start + first turn                                         |
| `CursorAdapter.test.ts:188-218`    | SIGTERM on stop                                                                          |
| `CursorAdapter.test.ts:220-270`    | Concurrent startSession serializes; second start kills first                             |
| `CursorAdapter.test.ts:272-286`    | Wrong provider → `ProviderAdapterValidationError`                                        |
| `CursorAdapter.test.ts:288-340`    | `interactionMode: "plan"` → correct mode id                                              |
| `CursorAdapter.test.ts:342-404`    | Config application order: model → reasoning → context → fast → mode                      |
| `CursorAcpExtension.test.ts:1-108` | `extractAskQuestions`, `extractPlanMarkdown`, `extractTodosAsPlan` against real payloads |
| `CursorAcpSupport.test.ts:53-123`  | Spawn-input building, model-selection ordering                                           |
| `CursorAcpCliProbe.test.ts:13-147` | Real `agent acp` integration (opt-in, `T3_CURSOR_ACP_PROBE=1`)                           |

**Known coverage gaps at this snapshot:**

- `respondToUserInput` round-trip in adapter test
- Permission-request flow with `runtimeMode !== "full-access"`
- `rollbackThread` / `readThread` specific tests
- ACP error responses and network failures
