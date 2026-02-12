# Unified Provider WebSocket API

This document is the canonical spec for the provider WebSocket API in T3 Code.

## Status

- `providers.stream` is the only provider push channel.
- Stream model is `snapshot + delta` with cursor replay (`afterSeq`).
- Server normalizes provider-native events (currently Codex app-server raw events) into canonical UI events.
- Debug/raw provider events are opt-in.

## Source-of-Truth Files

These files define behavior and must stay in sync with this document:

- Contracts:
  - `packages/contracts/src/providerStream.ts`
  - `packages/contracts/src/ws.ts`
  - `packages/contracts/src/ipc.ts`
  - `packages/contracts/src/provider.ts`
- Server:
  - `apps/server/src/providerEventNormalizer.ts`
  - `apps/server/src/providerStreamStore.ts`
  - `apps/server/src/providerStreamSubscriptionManager.ts`
  - `apps/server/src/wsServer.ts`
- Web client:
  - `apps/web/src/wsNativeApi.ts`
  - `apps/web/src/store.ts`
  - `apps/web/src/session-logic.ts`

## Synchronization Policy (Required)

Any change to provider WS contracts or behavior must update this doc in the same PR.

Changes that require doc updates include:

- New/removed/renamed provider RPC methods.
- New/removed channels or frame shapes.
- Changes to canonical event union or snapshot state fields.
- Normalization mapping changes.
- Replay retention or backpressure threshold changes.
- Client apply/dedupe/resync behavior changes.

If code and docs diverge, treat it as a bug.

## Wire Surface

### Request Methods

- `providers.startSession`
- `providers.sendTurn`
- `providers.interruptTurn`
- `providers.respondToApproval`
- `providers.stopSession`
- `providers.listSessions`
- `providers.openStream`
- `providers.closeStream`

### Push Channels

- `providers.stream`
- `server.welcome` (non-provider channel)

`providers.event` is removed.

## Stream Contracts

### `providers.openStream` Input

```ts
type ProvidersOpenStreamInput = {
  afterSeq?: number;
  sessionIds?: string[];
  eventKinds?: Array<
    | "session"
    | "turn"
    | "message"
    | "approval"
    | "activity"
    | "error"
    | "debug.raw"
  >;
  includeExtensions?: string[];
  includeDebugRaw?: boolean;
};
```

Defaults:

- `afterSeq`: not set
- `sessionIds`: all sessions
- `eventKinds`: all kinds
- `includeExtensions`: none
- `includeDebugRaw`: `false`

### `providers.openStream` Result

```ts
type ProvidersOpenStreamResult = {
  mode: "snapshot" | "replay" | "snapshot_resync";
  currentSeq: number;
  oldestSeq: number;
  replayedCount: number;
};
```

### `providers.stream` Frames

```ts
type ProviderStreamFrame =
  | { kind: "snapshot"; seq: number; at: string; data: ProviderSnapshot }
  | { kind: "event"; seq: number; at: string; data: ProviderCoreEvent }
  | {
      kind: "gap";
      seq: number;
      at: string;
      data: {
        reason: "cursor_too_old" | "cursor_ahead" | "replay_limit_exceeded";
        oldestSeq: number;
        currentSeq: number;
      };
    };
```

## Canonical Snapshot

```ts
type ProviderSnapshot = {
  sessions: CanonicalSessionState[];
  activeTurns: CanonicalTurnState[];
  activeMessages: CanonicalMessageState[];
  pendingApprovals: CanonicalApprovalState[];
};
```

## Canonical Events

`ProviderCoreEvent` variants:

- `session.updated`
- `turn.started`
- `turn.completed`
- `message.delta`
- `message.completed`
- `approval.requested`
- `approval.resolved`
- `activity`
- `error`
- `debug.raw`

### Event Invariants

- Stream ordering is by increasing `seq`.
- `snapshot` is authoritative baseline state.
- `message.delta` and `message.completed` are assistant-only.
- `approval.resolved.decision` is snake_case:
  - `accept`
  - `accept_for_session`
  - `decline`
  - `cancel`
  - `timed_out`
- `debug.raw` is never required for primary UI behavior.

## Server Pipeline

### Flow

1. `CodexAppServerManager` emits `ProviderRawEvent`.
2. `ProviderEventNormalizer` maps raw -> canonical allowlist events.
3. `ProviderStreamStore` assigns global `seq`, applies snapshot state, stores replay log.
4. `ProviderStreamSubscriptionManager` filters and pushes frames per socket.
5. `wsServer` exposes open/close RPC methods and broadcasts stream frames.

### Unmapped Raw Methods

- Unmapped methods produce no core canonical event.
- For unmapped methods, server emits `debug.raw` into the canonical stream pipeline.
- Subscribers only receive `debug.raw` if `includeDebugRaw=true` and filters allow it.

## Codex Normalization Map

Implemented in `apps/server/src/providerEventNormalizer.ts`.

- `thread/started` -> `session.updated`
- `turn/started` -> `turn.started` + `session.updated(status=running)`
- `turn/completed` -> `turn.completed` + `session.updated(status=ready|error)`
- `item/agentMessage/delta` -> `message.delta`
- `item/completed` with `item.type=agentMessage` -> `message.completed`
- `item/commandExecution/requestApproval` -> `approval.requested(approvalKind=command)`
- `item/fileChange/requestApproval` -> `approval.requested(approvalKind=file_change)`
- `item/tool/requestUserInput` -> `approval.requested(approvalKind=user_input)`
- `item/requestApproval/decision` -> `approval.resolved`
- actionable `item/started` / `item/completed` -> `activity`
- `turn/plan/updated` -> `activity(activityKind=plan)` + `extensions["codex.turn.plan"]`
- provider/runtime/protocol/process error signals -> `error`

Notes:

- `requestKind` raw values can be legacy (`file-change`) and are normalized at canonical layer (`file_change`).
- User-input requests are auto-answered in Codex manager and represented canonically as approval request/resolution semantics.

## Replay and Cursor Semantics

Implemented in `apps/server/src/providerStreamStore.ts` and `apps/server/src/providerStreamSubscriptionManager.ts`.

### Sequence Rules

- `seq` is global, process-local, monotonic.
- First emitted event has `seq=1`.
- `currentSeq=0` before first event.

### Retention Limits

- Max replay events: `20_000`
- Max replay bytes: `64MB`
- Max replay age: `60m`
- Max replay delivery per `openStream`: `10_000`

### Cursor Validation

Given `afterSeq`:

- `afterSeq > currentSeq` -> `gap(reason=cursor_ahead)` + snapshot resync
- `afterSeq < oldestSeq - 1` -> `gap(reason=cursor_too_old)` + snapshot resync
- missing events count `> 10_000` -> `gap(reason=replay_limit_exceeded)` + snapshot resync
- otherwise -> replay only missing events (`seq > afterSeq`)

### `openStream` Modes

- `snapshot`: no cursor provided
- `replay`: valid cursor replay path
- `snapshot_resync`: invalid/stale/ahead/excessive cursor

### Push Order on Resync

For resync paths server sends:

1. `gap`
2. `snapshot`

## Filtering and Extensions

Per-socket filters (set by `openStream` input):

- `sessionIds`: include only events/snapshot state for listed sessions
- `eventKinds`: include only selected canonical kinds
- `includeDebugRaw`: additionally required for `debug.raw`
- `includeExtensions`: allowlist of extension keys to keep

Extension behavior:

- Events with `extensions` drop all extensions by default.
- If `includeExtensions` is set, only requested keys are retained.

## Backpressure Behavior

Per socket:

- If `bufferedAmount > 2MB` for more than `5s`, server closes socket with `1013`.
- Server does not silently drop canonical events for active subscribers.
- Client is expected to reconnect and resume via `afterSeq`.

## Client Behavior

Implemented in:

- `apps/web/src/wsNativeApi.ts`
- `apps/web/src/store.ts`

### Transport + Stream Lifecycle

- Web client subscribes to `providers.stream` push channel.
- On connection open, it auto-opens stream if there are stream listeners.
- It reuses `lastAppliedSeq` for resume (`afterSeq`).

### Dedupe and Apply Rules

- Ignore frames with `seq <= lastAppliedSeq`.
- Apply `snapshot` as authoritative state reset for matching sessions.
- Apply `event` deltas in `seq` order.
- `gap` is a signal frame; subsequent snapshot is authoritative.

## Process Restart Semantics

- Replay guarantees are process-lifetime scoped.
- On server restart, `seq` and replay log reset.
- Clients recover by opening stream and applying snapshot baseline.

## Claude Compatibility Contract

Future Claude adapter requirements:

- Adapter emits only canonical `ProviderCoreEvent`.
- No UI protocol changes for adding Claude support.

## Testing Expectations

Required coverage when changing the API:

- Contracts parse tests (`providerStream`, method/channel constants).
- Server tests for:
  - open snapshot path
  - replay path
  - stale/ahead/excessive cursor -> gap + snapshot
  - session/event/debug filtering
  - backpressure close behavior
  - normalizer mapping coverage
- Web tests for:
  - stream reducer/snapshot behavior
  - reconnect/dedupe logic
  - approvals/messages/turn lifecycle from canonical events

## Change Checklist (PR Gate)

For any provider WS API change:

1. Update contracts in `packages/contracts`.
2. Update this doc (`docs/provider-ws-api.md`).
3. Update server normalizer/store/subscriptions as needed.
4. Update client stream/reducer logic as needed.
5. Update tests in contracts/server/web.
6. Run `bun run typecheck` and `bun run test`.
