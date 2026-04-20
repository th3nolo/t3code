# Provider architecture

> **Foundational reference.** This document describes the cross-provider scaffolding that every CLI
> integration sits on top of: the Effect Service/Layer split, the registries, the projection pipeline,
> the WebSocket transport, the contracts package, and the cross-cutting best practices that the four
> existing integrations follow.
>
> Per-provider details live in their own docs:
>
> - [`codex-integration.md`](./codex-integration.md) — Codex (primary, JSON-RPC over stdio)
> - [`claude-integration.md`](./claude-integration.md) — Claude Agent (SDK Query API)
> - [`gemini-integration.md`](./gemini-integration.md) — Gemini CLI (ACP with flavor negotiation)
> - [`opencode-integration.md`](./opencode-integration.md) — OpenCode (HTTP SDK over local server)
> - [`cursor-integration.md`](./cursor-integration.md) — Cursor (ACP, pre-release CLI; deep dive)
> - [`adding-a-cli-provider.md`](./adding-a-cli-provider.md) — checklist for new providers
>
> File/line references reflect the tree at commit `9df3c640` (the last commit before the in-progress
> Gemini ACP work). Paths are repo-relative; line numbers may shift slightly in newer commits but the
> layout is stable.

---

## 1. The big picture

T3 Code is an **Effect-TS** server (Node 24 + Bun) that fronts coding-agent CLIs to a React web UI over
WebSocket. Every provider integration sits on top of the same scaffolding:

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Web (React/Vite)  ◄─── WebSocket (RpcServer + push channels) ───►       │
└──────────────────────────────────────────────────────────────────────────┘
                                 │
                       ┌─────────▼──────────┐
                       │ NativeApi (ws.ts)  │
                       └─────────┬──────────┘
                                 │
                ┌────────────────▼────────────────┐
                │  OrchestrationEngine            │
                │  (event-sourced, projects to    │
                │   read-models)                  │
                └────────────────┬────────────────┘
                                 │
                      ┌──────────▼─────────┐
                      │ ProviderService    │
                      │ (unified facade)   │
                      └─────┬─────────┬────┘
                            │         │
                  ┌─────────▼─┐   ┌───▼──────┐
                  │ Provider- │   │ Provider │
                  │ Adapter-  │   │ Session- │
                  │ Registry  │   │ Directory│
                  └─────┬─────┘   └──────────┘
                        │
               ┌────────┼────────┬──────────┐
               ▼        ▼        ▼          ▼
             Codex   Claude   Cursor    OpenCode
```

Provider runtime events flow **back up** this tree via a separate pipeline: each adapter exposes
`streamEvents` (see [§7](#7-projection-pipeline-provider-events--domain-events)), consumed by
`ProviderRuntimeIngestion`, which projects raw events into domain events and feeds
`OrchestrationEngine`.

---

## 2. Effect Service / Layer split

The codebase consistently separates **service interfaces** from **layer implementations**:

- `apps/server/src/<area>/Services/<Name>.ts` — the `Context.Service` tag plus its `Shape` interface.
  Pure types, no runtime logic.
- `apps/server/src/<area>/Layers/<Name>.ts` — the `Layer.effect(Service, makeXxx())` implementation.
  Owns resource acquisition, fibers, finalizers, error mapping.

Example contract — `apps/server/src/git/Services/TextGeneration.ts:88-123`:

```ts
export interface TextGenerationShape {
  readonly generateCommitMessage: (
    input: CommitMessageGenerationInput,
  ) => Effect.Effect<CommitMessageGenerationResult, TextGenerationError>;
  // ...
}
export class TextGeneration extends Context.Service<TextGeneration, TextGenerationShape>()(
  "t3/git/Services/TextGeneration",
) {}
```

**Why this split:**

- **Testability** — tests substitute fakes by providing an alternative layer. The interface never changes.
- **Composability** — `make*Live(options)` factories let callers inject custom managers, loggers, or
  transports without forking code (e.g. `makeClaudeAdapterLive` at the foot of
  `apps/server/src/provider/Layers/ClaudeAdapter.ts`).
- **Scoped lifecycle** — `Effect.acquireRelease` / `Effect.addFinalizer` inside the layer guarantee that
  child processes, queues, and SDK runtimes are torn down when the layer scope exits.
- **Error canonicalization** — provider-native errors are mapped to the typed `ProviderAdapter*Error`
  union (see [§8](#8-error-taxonomy-and-recovery)) at the layer boundary, so callers never see
  SDK-specific exceptions.

---

## 3. Registries: `ProviderRegistry` vs `ProviderAdapterRegistry`

Two independent registries:

| Registry                  | File                                                           | Owns                                                                                                                                     |
| ------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `ProviderRegistry`        | `apps/server/src/provider/Services/ProviderRegistry.ts`        | Static **provider snapshots** for the UI: installed version, supported models, auth status. Push-streamed via `streamChanges()`.         |
| `ProviderAdapterRegistry` | `apps/server/src/provider/Services/ProviderAdapterRegistry.ts` | Maps `ProviderKind` ("codex" \| "claudeAgent" \| "cursor" \| "opencode" \| "gemini") to **adapter instances** for session/turn dispatch. |

The **snapshot** registry feeds the model picker, prerequisites tile, and "install missing CLI" hints in
the UI. The **adapter** registry is the runtime dispatch table for `ProviderService`.

---

## 4. `ProviderService` and `ProviderSessionDirectory`

`apps/server/src/provider/Services/ProviderService.ts:36-108` defines the **single facade** that
orchestration code calls — `startSession`, `sendTurn`, `interruptTurn`, `respondToRequest`, `stopSession`,
`streamEvents`. It looks up the adapter via `ProviderAdapterRegistry`, delegates, and aggregates errors
into the `ProviderServiceError` union.

`ProviderSessionDirectory` persists active sessions to disk so the UI can:

- list resumable sessions immediately after a server restart,
- bind a reconnecting browser tab back to a live session without re-authenticating,
- reap stale sessions whose owning tab/process has gone away (see also `ProviderSessionReaper`,
  `apps/server/src/provider/Layers/ProviderSessionReaper.ts:19-133`).

---

## 5. WebSocket transport

`apps/server/src/ws.ts` mounts an Effect `RpcServer` (from `effect/unstable/rpc`) over WebSocket. Wire
format:

- **Request/Response** — `{ id, method, params }` → `{ id, result }` or `{ id, error }`
- **Push events** — typed envelopes with `channel`, `sequence` (monotonic per connection), and
  channel-specific `data`

**Push channels:** `server.welcome`, `server.configUpdated`, `terminal.event`,
`orchestration.domainEvent`. Payloads are schema-validated at the transport boundary
(`apps/web/src/wsTransport.ts`). Decode failures produce a structured `WsDecodeDiagnostic` with `code`,
`reason`, and path info.

The `NativeApi` namespace (declared in `packages/contracts/src/orchestration.ts:23-31`) exposes:

31 RPC methods, grouped by domain (`ws.ts:1-1090`):

| Group             | Methods                                                                                                                                                                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Orchestration** | `dispatchCommand`, `getTurnDiff`, `getFullThreadDiff`, `replayEvents`, `subscribeShell`†, `subscribeThread`†                                                                                                                                  |
| **Terminal**      | `terminalOpen`, `terminalWrite`, `terminalResize`, `terminalClear`, `terminalRestart`, `terminalClose`, `subscribeTerminalEvents`†                                                                                                            |
| **Git**           | `gitPull`, `gitRefreshStatus`, `gitRunStackedAction`, `gitListBranches`, `gitCreateWorktree`, `gitRemoveWorktree`, `gitCreateBranch`, `gitCheckout`, `gitInit`, `gitResolvePullRequest`, `gitPreparePullRequestThread`, `subscribeGitStatus`† |
| **Server**        | `serverGetConfig`, `serverRefreshProviders`, `serverUpsertKeybinding`, `serverGetSettings`, `serverUpdateSettings`, `subscribeServerConfig`†, `subscribeServerLifecycle`†                                                                     |
| **Workspace**     | `projectsSearchEntries`, `projectsWriteFile`, `shellOpenInEditor`, `filesystemBrowse`                                                                                                                                                         |
| **Auth**          | `subscribeAuthAccess`†                                                                                                                                                                                                                        |

† = streaming subscription (returns long-lived `Stream<…>`).

**Subscription pattern:** Every `subscribe*` method returns an initial snapshot followed by live
events from `orchestrationEngine.streamDomainEvents`, filtered and transformed server-side before
transmission. `subscribeServerConfig` aggregates three streams (keybindings, provider statuses,
settings) into one. Provider status changes are **debounced 200 ms** (`ws.ts:976`) before
broadcasting to reduce chatter.

**Session lifecycle binding:** WebSocket connections are tied to `ServerSession` credentials.
`sessions.markConnected(session.sessionId)` and `markDisconnected` bracket the connection lifetime,
allowing the server to track and revoke active clients.

### 5.1 Client transport

`wsTransport.ts` manages the connection state machine: `connecting` → `open` → `reconnecting` →
`closed` → `disposed`. Outbound requests are queued while disconnected and flushed on reconnect.
Inbound pushes are decoded and validated at the boundary, then cached per channel. Subscribers can opt
into `replayLatest` to receive the last push on subscribe, and the client re-subscribes after reconnect
and replays from the cached last `sequence` so partial-stream interruptions do not produce gaps.

**Why streams over polling:** AGENTS.md ranks reliability and predictability under load above
convenience. A push subscription removes per-tab polling load and gives lossless ordering via
`sequence`.

---

## 6. Contracts package and shared invariants

`packages/contracts/` is **schema-only** (no runtime logic — enforced as a code-review rule by AGENTS.md
§Package Roles). Important members:

| File                 | Defines                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| `baseSchemas.ts`     | Branded ID types — `ThreadId`, `TurnId`, `SessionId`, etc., all non-empty trimmed strings        |
| `orchestration.ts`   | `OrchestrationCommand`, `OrchestrationEvent`, `OrchestrationReadModel`, `NativeApi` method names |
| `providerRuntime.ts` | `ProviderRuntimeEvent` union — the canonical event shape every adapter emits                     |
| `model.ts`           | `ProviderKind`, `ModelSelection` (per-provider unions), `ServerProviderModel`                    |

Invariants encoded by Effect Schema:

- `OrchestrationEvent.sequence` is `NonNegativeInt` → guarantees event ordering on the wire.
- `ModelSelection` is a discriminated union per provider → the type system enforces provider-specific
  options (e.g. Codex's reasoning effort vs. Cursor's parameterized config options).
- All IDs are branded strings → impossible to pass a `ThreadId` where a `SessionId` is expected.

`packages/shared` carries runtime utilities (git, model, shell, concurrency primitives like
`DrainableWorker` and `KeyedCoalescingWorker`) and uses **explicit subpath exports** (e.g.
`@t3tools/shared/git`) — **no barrel `index.ts`** (AGENTS.md §Package Roles).

---

## 7. Projection pipeline (provider events → domain events)

Provider adapters emit **`ProviderRuntimeEvent`** values into a shared `Queue` exposed as
`adapter.streamEvents`. These flow through three layered queue-based workers, each backed by
`DrainableWorker` from `@t3tools/shared/DrainableWorker`. All three expose `drain()` for deterministic
test synchronization.

1. **`ProviderRuntimeIngestion`**
   (`apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`) — consumes runtime events,
   derives orchestration intents (`thread.message-sent`, `turn.completed`, `request.opened`, …).
2. **`ProviderCommandReactor`** — reacts to orchestration intent events, dispatches provider calls
   (the reverse direction: e.g. user approval reply → `respondToRequest`).
3. **`CheckpointReactor`** — captures git checkpoints on turn start/complete, publishes runtime
   receipts.

The full orchestration/event-sourcing architecture — CQRS decider, projector, engine, projection
pipeline, ingestion, and reactors — is documented in
[`orchestration-architecture.md`](./orchestration-architecture.md). Brief summary here:

- **`ProviderRuntimeIngestion`** (1572 lines) converts `ProviderRuntimeEvent`s to
  `OrchestrationCommand`s. It buffers assistant text up to `MAX_BUFFERED_ASSISTANT_CHARS = 24_000`
  and enforces turn-ordering via `T3CODE_STRICT_PROVIDER_LIFECYCLE_GUARD`.
- **`ProjectionPipeline`** (1477 lines) applies `OrchestrationEvent`s to 9 SQL projection tables
  idempotently, enabling crash-safe read-model reconstruction.
- **`OrchestrationEngine`** processes commands serially (one worker, no concurrency), validates
  invariants, runs the decider (22 command types → events), updates both in-memory and SQL models in
  a single transaction, then publishes events to downstream reactors.

---

## 8. Error taxonomy and recovery

`apps/server/src/provider/Errors.ts:1-163` defines a **typed error hierarchy** (all
`Schema.TaggedErrorClass` so they round-trip across the WS boundary):

| Error class                           | Meaning                        | Typical origin                                                    |
| ------------------------------------- | ------------------------------ | ----------------------------------------------------------------- |
| `ProviderAdapterValidationError`      | Bad API input                  | Wrong provider on `startSession`, missing cwd, invalid model slug |
| `ProviderAdapterSessionNotFoundError` | Unknown thread                 | Thread deleted while a turn was in flight                         |
| `ProviderAdapterSessionClosedError`   | Session exists but is closed   | Race between user stop and provider event                         |
| `ProviderAdapterRequestError`         | Protocol-level request failure | JSON-RPC timeout, malformed payload                               |
| `ProviderAdapterProcessError`         | Child-process failure          | Spawn failed, stdio crashed, non-zero exit                        |

`ProviderServiceError` is the union of all of the above plus
`ProviderSessionDirectoryPersistenceError`. Adapters never throw raw SDK errors past their layer
boundary — every catch site maps to one of these tagged errors.

**Recovery patterns shared across all providers:**

- **Reconnect** — WebSocket disconnect cancels per-request Effect scopes; on reconnect the client
  re-subscribes and replays from `sequence`.
- **Resume** — every adapter accepts an opaque `resumeCursor`. The cursor's shape is provider-private
  (see each provider doc). Adapters that fail to resume gracefully fall back to creating a fresh
  session and emit a lifecycle event so the UI can show "could not resume — started new session".
- **Process death** — `ProviderSessionDirectory` carries enough state to surface the dead session in
  the resumable list with a sentinel status; the next `sendTurn` will fail with
  `ProviderAdapterSessionClosedError` and the UI prompts to start fresh.
- **Partial streams** — projection buffering (see §7) prevents half-rendered output. Buffered text on
  a failed turn is discarded, not flushed.

---

## 9. Text-generation routing

`apps/server/src/git/Layers/RoutingTextGeneration.ts:48-112` is the canonical example of the
**routing-layer pattern**:

- Internal service tags (`CodexTextGen`, `ClaudeTextGen`, `CursorTextGen`, `OpenCodeTextGen`) let four
  implementations coexist in the same Effect context.
- `route(provider)` (lines 54-69) dispatches by `modelSelection.provider`.
- Each provider's concrete layer is stacked via `Layer.provide()` (lines 96-112).

This pattern keeps text-generation call-sites (commit message, PR title, branch name, thread title)
provider-agnostic — they call `TextGeneration.generateCommitMessage(input)` and the layer picks the
implementation. Adding Gemini text generation is a one-line addition to the route table plus a new
`GeminiTextGeneration` layer.

---

## 10. Shared provider utilities

These files in `apps/server/src/provider/` are shared across all providers — not Codex-specific
despite some names.

### `makeManagedServerProvider.ts`

Generic Effect factory (lines 13-156) used by every provider to manage a `ServerProvider` snapshot
with auto-refresh and settings reactivity. Produces a `ServerProviderShape` with three methods:
`getSnapshot()`, `refresh()`, `streamChanges()`. Forks a background effect that refreshes every
`refreshInterval` (default 60 s) and applies updated snapshots when settings change.

Input interface:

- `getSettings` / `streamSettings` / `haveSettingsChanged` — settings reactivity
- `initialSnapshot(settings)` — fast initial snapshot before the first probe completes
- `checkProvider` — the actual probe (runs `--version`, auth check, model list)
- `enrichSnapshot?({ settings, snapshot, publishSnapshot })` — **optional** post-probe hook for
  slow background capability discovery. Both Cursor and OpenCode use this to run ACP per-model
  probes after the initial snapshot is already published. Call `publishSnapshot(enriched)` to push
  updated model capabilities without blocking the initial response. A generation counter prevents
  stale enrichments from overwriting newer ones.
- `refreshInterval?` — defaults to `"1 hour"` (providers override as needed)

### `providerSnapshot.ts`

All provider snapshot implementations import from here. Key exports:

- `buildServerProvider(input)` — canonical constructor for `ServerProvider`. Sets `checkedAt`, assembles probe result. Use this instead of building the shape manually.
- `providerModelsFromSettings(builtIn, provider, customModels, defaultCaps)` — merges built-in and user-added custom models; deduplicates by slug; built-in first.
- `orderProviderSnapshots(providers)` — sorts by display rank (codex, claudeAgent, gemini, opencode, cursor).
- `hydrateCachedProvider({ cachedProvider, fallbackProvider })` — on startup, merges cached status/auth/models with a fresh fallback to avoid cold-start CLI spawns.
- `spawnAndCollect(binaryPath, command)` — standard helper for `--version` probes; collects stdout, stderr, exit code.
- `parseGenericCliVersion(output)` — extracts first `\d+\.\d+\.\d+` from CLI output.
- `isCommandMissingCause(error)` — detects ENOENT / command-not-found from spawn errors.
- `detailFromResult(result)` — produces a human-readable error string from a probe result.
- `DEFAULT_TIMEOUT_MS = 4_000` — default timeout for `--version` spawns.

### `providerStatusCache.ts`

On-disk JSON cache for provider status (installed, version, auth, models, skills). No TTL — files
are replaced when the provider refreshes. Read once at startup via `readProviderStatusCache()`;
silently ignores parse errors. Prevents cold-start CLI spawns on every server restart.

### `cliVersion.ts`

**Generic** semver utilities, not Codex-specific despite the name:

- `normalizeCliVersion(version)` — fills missing patch segment ("2.1" → "2.1.0").
- `compareCliVersions(left, right)` — full semver comparison including prerelease ordering
  ("1.0.0-beta" < "1.0.0", per spec).

Used by all four providers for CLI version gating.

### `acp/AcpAdapterBase.ts`

`apps/server/src/provider/acp/AcpAdapterBase.ts` (1220 lines on `feat/gemini-cli-provider`) is the
shared factory for all ACP-based providers (Cursor, Gemini). Call:

```typescript
const base = yield * makeAcpAdapter<"xyz", XyzExtra>(config, liveOptions);
```

The base owns: session map, thread-lock semaphores, runtime event PubSub, permission handling,
notification fiber, turn lifecycle, interrupt with synthetic-cancel, rollback, layer finalizer.

**Required config:** `provider`, `capabilities`, `buildSession`, `parseResumeCursor`,
`buildResumeCursor`, `applySessionConfiguration`.

**Optional hooks:** `validateStartInput`, `registerExtensionHandlers`, `resolveSessionModel`,
`afterSessionCreated` (may return `{ seedTurns }` for resume), `onContentDelta`,
`beforeTurn`, `afterTurnSettled`, `beforeStop`, `afterRollback`, `selectAutoApprovedPermission`.

`TExtra` is the provider's per-session mutable state beyond the base context fields.

**Interrupt and synthetic cancel:** `interruptTurn` sends `acp.cancel()` under `acpCancelTimeout`
(default 2 s), then schedules a grace timer (`syntheticCancelGrace`, default 3 s) that fires a
`cancelSignal` Deferred. `sendTurn` races the live prompt against this via `Effect.raceFirst`,
ensuring the UI unblocks even when the agent is slow to honor cancel.

### `acp/AcpAdapterSupport.ts`

Shared helpers for ACP adapters (60 lines):

- `mapAcpToAdapterError(provider, threadId, method, cause)` — converts `AcpError` to the typed `ProviderAdapterRequestError` or `ProviderAdapterProcessError`.
- `acpPermissionOutcome(decision)` — maps `ProviderApprovalDecision` to ACP outcome string.
- `isAcpMethodNotFound(error)` — detects JSON-RPC `-32601` (method not found). Use to tolerate optional ACP capabilities that may not be implemented in all CLI versions.

### `acp/AcpNativeLogging.ts`

`makeAcpNativeLoggers({ nativeEventLogger, provider, threadId })` (76 lines) — produces the
`nativeLoggers` object that `AcpAdapterBase` passes into the `buildSession` hook. Pass it into
`makeXyzAcpRuntime` so native JSON-RPC events are logged to the same NDJSON stream as other
providers.

### `codexAppServer.ts` (Codex-specific probe)

`probeCodexDiscovery()` spawns `codex app-server`, sends JSON-RPC calls (`initialize`,
`skills/list`, `account/read`), and returns account snapshot + skills. Used once per provider
refresh to populate Codex metadata. Separate from `codexAppServerManager.ts` (which owns the
long-lived session).

### `server.ts` composition root

`apps/server/src/server.ts` assembles provider layers inside `ProviderLayerLive`, a
`Layer.unwrap(Effect.gen(...))` block that:

1. Acquires `nativeEventLogger` and `canonicalEventLogger` once (shared across all adapters).
2. Calls `makeXxxAdapterLive(nativeEventLogger)` for each provider.
3. Provides all adapter layers to `ProviderAdapterRegistryLive`.
4. Returns `makeProviderServiceLive(canonicalEventLogger).pipe(Layer.provide(adapterRegistryLayer))`.

All adapter layers are built **eagerly at server startup** when the `ProviderLayerLive` scope opens.
CLI probes for disabled providers short-circuit in each `checkXxxProviderStatus` (
`enabled === false` returns a warning snapshot immediately) rather than at the layer level.

> **Note on AGENTS.md:** `AGENTS.md` references two stale file paths (`providerManager.ts` and
> `wsServer.ts`) that do not exist. The actual files are
> `apps/server/src/provider/Services/ProviderService.ts` and `apps/server/src/ws.ts`.
> AGENTS.md's "Codex App Server (Important)" section also predates the multi-provider architecture
> and incorrectly describes T3 Code as Codex-first. Read these docs instead.

---

## 11. Architectural WHY: key decisions from .plans/

The `.plans/` directory (20+ documents) explains why the architecture looks the way it does. Key
decisions:

| Plan                                                   | Decision                                                                        | Why                                                                                                                                                                      |
| ------------------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `11-effect.md`, `15-effect-server.md`                  | Adopt Effect-TS for all services                                                | Previous Promise/EventEmitter approach had implicit error propagation and unreliable resource cleanup; Effect provides typed errors, composable layers, scoped lifetimes |
| `14-server-authoritative-event-sourcing-cleanup.md`    | Append-only event store + SQL projections                                       | In-memory polling produced race conditions on provider crash and couldn't replay after restart                                                                           |
| `17-provider-neutral-runtime-determinism.md`           | `ProviderService` / `ProviderRuntimeEvent` are provider-agnostic                | Early code leaked Codex names into shared orchestration; neutrality is required to add providers without touching the core                                               |
| `10-unify-process-session-abstraction.md`              | Single `RuntimeSession` interface for all process backends (PTY, child process) | `ProcessManager` had parallel branch logic that multiplied complexity on every new backend                                                                               |
| `03-split-codex-app-server-manager.md`                 | Split `CodexAppServerManager` into focused modules                              | Mixed concerns (spawn, RPC routing, state transitions, event emission) made it untestable                                                                                |
| `18-server-auth-model.md`                              | Unified `ServerAuth` with `BootstrapCredential` + `SessionCredential`           | Auth was scattered; every privileged surface now uses the same policy engine                                                                                             |
| `spec-contract-matrix.md` + `spec-1-1-cutover-plan.md` | Hard schema cutover (no compatibility shims)                                    | Clean break from legacy persistence schema; all tables redefined against contracts in lockstep                                                                           |
| `13-provider-service-integration-tests.md`             | Real Effect layers + deterministic fake adapter in integration tests            | Full-stack tests (provider events → checkpoints → projections) need real services but stable inputs                                                                      |

See `.plans/README.md` for the full index.

---

## 12. Cross-cutting best practices

Distilled from AGENTS.md and what the four integrations actually do.

### 10.1 Performance and reliability

- **Layer scope owns the resource.** Every long-lived child process, SDK runtime, or HTTP server is
  acquired in `Effect.acquireRelease` (or registered with `Effect.addFinalizer`) on the layer. Layer
  scope exit ⇒ guaranteed teardown. The Claude leak fix in commit `e0117b27` is the empirical evidence
  for why this matters.
- **Never throw raw SDK errors past the layer boundary.** Map to `ProviderAdapter*Error` so the client
  can dispatch deterministically. (`apps/server/src/provider/Errors.ts:1-163`.)
- **Bound every external call.** Codex CLI version check: 4 s. Codex `exec` for text gen: 180 s.
  OpenCode local-server startup: 5 s. Cursor model discovery: 15 s with concurrency 4. Stop-sweep
  reaper: every 5 min, idle threshold 30 min.
- **Filter benign stderr at the source.** `classifyCodexStderrLine` and OpenCode's friendly-error
  formatting prevent log noise from becoming user-facing errors.
- **Two-tier session cleanup.** Adapter-owned `stopSession` plus `ProviderSessionReaper`. Belt and
  suspenders.

### 10.2 Predictability under failure

- **Resume cursors are opaque, schema-versioned, and validated.** The orchestration layer never
  synthesizes one. (Claude: `readClaudeResumeState`. Cursor: `CURSOR_RESUME_VERSION` guard.)
- **Recoverable resume errors fall back to a fresh session and emit a lifecycle event.** The UI always
  has a chance to tell the user "we lost your session".
- **Partial-stream behavior is buffered.** `MAX_BUFFERED_ASSISTANT_CHARS = 24_000` in the projection
  pipeline means a half-finished message is either rendered whole or discarded — never half-rendered.
- **Approvals and user inputs are settled on stop.** Every adapter resolves pending deferreds with
  cancel/empty values before tearing down. No fiber leaks waiting on a dead session.
- **Idempotent stop.** All four adapters guard against double-stop with a `stopped` flag.

### 10.3 Maintainability

- **Service / Layer split** (§2) is universal. New code goes in the same shape.
- **Routing layer for cross-provider concerns.** `RoutingTextGeneration` (§9) is the canonical example.
  Adding a provider is one row in the dispatch table plus one new layer — no edits to call sites.
- **Contracts package is schema-only.** All cross-component types live there. Runtime utilities go in
  `packages/shared` with explicit subpath exports — **no barrel index** (AGENTS.md §Package Roles).
- **Provider-native events preserve `raw`.** Every canonical event carries the original payload, so
  schema evolution doesn't break debugging or future remapping.
- **Probe scripts for pre-release CLIs.** When integrating against an unstable surface (Cursor),
  invest in a developer probe that surfaces mismatches as actionable diffs.

### 10.4 Testing

- **Pure-function tests for parsing/normalization.** No process spawning. (Codex stderr classifier,
  Cursor reasoning normalizer, OpenCode delta merger.)
- **Adapter projection tests with fake managers.** Inject raw events; assert canonical
  `ProviderRuntimeEvent`. This is where the bulk of regression coverage lives.
- **Live integration tests are env-gated.** `CODEX_BINARY_PATH`, `T3_CURSOR_ACP_PROBE=1`. CI runs
  green without the binaries; developers can flip them on locally.
- **`DrainableWorker.drain()` instead of `sleep()`.** Test synchronization is deterministic.

### 10.5 Anti-patterns to avoid

- **Don't introduce per-provider routing in call sites.** Push it into a routing layer (§9).
- **Don't add a barrel `index.ts` to `packages/shared`.** AGENTS.md forbids it.
- **Don't put runtime logic in `packages/contracts`.** Same.
- **Don't bypass the layer boundary with raw exceptions.** Wrap in tagged errors.
- **Don't poll where you can subscribe.** The whole `subscribeThread`/`subscribeShell` design exists
  to remove polling.
