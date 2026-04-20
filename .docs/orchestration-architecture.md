# Orchestration architecture (event-sourcing and CQRS core)

> This document covers the server-side orchestration engine — the CQRS command/event pipeline that
> sits between the WebSocket transport and the provider adapters. Every user action (start turn,
> respond to approval, archive thread) flows through this layer.
>
> Read [`provider-architecture.md`](./provider-architecture.md) for the surrounding scaffolding
> (providers, registries, WS transport). File/line references reflect the tree at `9df3c640`.

---

## Table of contents

1. [Overview: CQRS + event sourcing](#1-overview-cqrs--event-sourcing)
2. [Full command flow: `thread.turn.start` traced end-to-end](#2-full-command-flow-threadturnstart-traced-end-to-end)
3. [Decider — 22 commands, invariants, cascading](#3-decider--22-commands-invariants-cascading)
4. [Projector — 17 events → in-memory read-model](#4-projector--17-events--in-memory-read-model)
5. [OrchestrationEngine — serial worker, idempotency, observability](#5-orchestrationengine--serial-worker-idempotency-observability)
6. [Normalizer — pre-dispatch transformation](#6-normalizer--pre-dispatch-transformation)
7. [HTTP endpoints in the orchestration layer](#7-http-endpoints-in-the-orchestration-layer)
8. [ProjectionPipeline — 8 SQL tables, bootstrap, idempotency](#8-projectionpipeline--8-sql-tables-bootstrap-idempotency)
9. [ProviderRuntimeIngestion — provider events → orchestration commands](#9-providerruntimeingestion--provider-events--orchestration-commands)
10. [Reactors](#10-reactors)
11. [RuntimeReceiptBus — test synchronization milestones](#11-runtimereceiptbus--test-synchronization-milestones)
12. [Runtime layer composition](#12-runtime-layer-composition)
13. [Error taxonomy](#13-error-taxonomy)

---

## 1. Overview: CQRS + event sourcing

The orchestration layer implements **CQRS (Command Query Responsibility Segregation)** with a durable
**event store** and dual read-model strategy:

```
Client (HTTP POST /api/orchestration/dispatch)
    ↓  ClientOrchestrationCommand
Normalizer (attachment materialisation, workspaceRoot validation)
    ↓  OrchestrationCommand
OrchestrationEngine
  ├─ Idempotency check (commandId → receipt)
  ├─ Invariant validation (commandInvariants.ts)
  ├─ Decider (command + readModel → events[])
  ├─ SQL transaction ──────────────────────────────┐
  │     eventStore.append(event)                   │
  │     projectEvent(event) → in-memory readModel  │
  │     projectionPipeline.projectEvent(event)     │ (writes projection tables)
  │     commandReceipt.upsert(commandId, accepted) │
  │  ── commit ─────────────────────────────────────┘
  └─ PubSub.publish(event) → downstream reactors
         ├─ ProviderCommandReactor  (intent events → provider API calls)
         ├─ CheckpointReactor       (turn boundaries → git captures)
         └─ ThreadDeletionReactor   (thread.deleted → cleanup)
```

**Dual read-models:**

| Model                              | Location    | Updated by                                  | Queried by                                    |
| ---------------------------------- | ----------- | ------------------------------------------- | --------------------------------------------- |
| In-memory `OrchestrationReadModel` | Engine heap | `projectEvent` (projector.ts) inside SQL tx | Decider (invariant checks), snapshot read     |
| SQL projection tables              | SQLite      | `ProjectionPipeline` inside SQL tx          | `ProjectionSnapshotQuery` (HTTP/WS snapshots) |

Both are updated in the **same SQL transaction**, guaranteeing consistency on crash/restart.

**Why event sourcing?** Plan 14 (`14-server-authoritative-event-sourcing-cleanup.md`) explains: the
previous in-memory/polling approach produced race conditions when provider sessions crashed mid-turn and
could not replay state after server restart. An append-only event store plus persistent projections
eliminates both problems — restart replays events, and all projection tables are authoritative.

---

## 2. Full command flow: `thread.turn.start` traced end-to-end

Following a single `thread.turn.start` from client to provider:

1. **Client sends** `POST /api/orchestration/dispatch` with `ClientOrchestrationCommand` JSON
   (`apps/server/src/orchestration/http.ts:66-93`).

2. **Auth** — `session.role === "owner"` checked (`http.ts:34-39`).

3. **Decode** — `ClientOrchestrationCommand` schema-decoded (`http.ts:72`).

4. **Normalize** (`Normalizer.ts:66-142`) — for `thread.turn.start`, each attachment base64 data URL is:
   - parsed and MIME-validated (image/\* only)
   - size-checked (≤ `PROVIDER_SEND_TURN_MAX_IMAGE_BYTES`)
   - written to disk under `attachmentDir`
   - replaced in the command with `{ type: "image", id, name, mimeType, sizeBytes }`

5. **Enqueue** — command wrapped in `CommandEnvelope` (command + deferred + startedAtMs) and pushed
   to `OrchestrationEngine`'s unbounded queue (`OrchestrationEngine.ts:82`).

6. **Serial worker** dequeues it (`OrchestrationEngine.ts:275`) — no concurrency; all commands run
   serially.

7. **Idempotency** — if `commandId` seen before, return cached accept/reject
   (`OrchestrationEngine.ts:121-134`).

8. **Invariant check** (`commandInvariants.ts`) — `thread.turn.start` requires:
   - target thread exists and is not deleted (`requireThread`)
   - if `sourceProposedPlan` provided, source thread exists in same project

9. **Decider** (`decider.ts:377-450`) emits **two events**:
   - `thread.message-sent` (role: user, text, attachments)
   - `thread.turn-start-requested` (causationEventId: userMessageEvent.eventId)

10. **SQL transaction** (`OrchestrationEngine.ts:141`):
    - `eventStore.append(event)` → persists with sequence number
    - `projectEvent(readModel, event)` → updates in-memory `OrchestrationReadModel` (projector.ts)
    - `projectionPipeline.projectEvent(event)` → updates SQL projection tables
    - `commandReceipt.upsert(commandId, "accepted", resultSequence)`

11. **PubSub publish** (`OrchestrationEngine.ts:189`) — both events published to all subscribers.

12. **ProviderCommandReactor** receives `thread.turn-start-requested` → calls
    `providerService.sendTurn(...)`.

13. **Provider adapter** sends the turn to the CLI. Responses come back as `ProviderRuntimeEvent`s,
    consumed by `ProviderRuntimeIngestion`, which dispatches further orchestration commands
    (`thread.message.assistant.delta`, `thread.session.set`, etc.).

---

## 3. Decider — 22 commands, invariants, cascading

**File:** `apps/server/src/orchestration/decider.ts` (753 lines)

The decider is a pure function: `(command, readModel) → Effect<OrchestrationEvent[], Error>`. It
**never produces side effects** — only emits event records.

### Commands handled (22)

**Project commands (3):**

| Command               | Event(s) emitted                                       |
| --------------------- | ------------------------------------------------------ |
| `project.create`      | `project.created`                                      |
| `project.meta.update` | `project.meta-updated`                                 |
| `project.delete`      | `thread.deleted`×N (if force=true) + `project.deleted` |

**Thread commands (19):**

| Command                             | Event(s) emitted                                      |
| ----------------------------------- | ----------------------------------------------------- |
| `thread.create`                     | `thread.created`                                      |
| `thread.delete`                     | `thread.deleted`                                      |
| `thread.archive`                    | `thread.archived`                                     |
| `thread.unarchive`                  | `thread.unarchived`                                   |
| `thread.meta.update`                | `thread.meta-updated`                                 |
| `thread.runtime-mode.set`           | `thread.runtime-mode-set`                             |
| `thread.interaction-mode.set`       | `thread.interaction-mode-set`                         |
| `thread.turn.start`                 | `thread.message-sent` + `thread.turn-start-requested` |
| `thread.turn.interrupt`             | `thread.turn-interrupt-requested`                     |
| `thread.approval.respond`           | `thread.approval-response-requested`                  |
| `thread.user-input.respond`         | `thread.user-input-response-requested`                |
| `thread.checkpoint.revert`          | `thread.checkpoint-revert-requested`                  |
| `thread.session.stop`               | `thread.session-stop-requested`                       |
| `thread.session.set`                | `thread.session-set`                                  |
| `thread.message.assistant.delta`    | `thread.message-sent` (streaming=true)                |
| `thread.message.assistant.complete` | `thread.message-sent` (streaming=false)               |
| `thread.proposed-plan.upsert`       | `thread.proposed-plan-upserted`                       |
| `thread.turn.diff.complete`         | `thread.turn-diff-completed`                          |
| `thread.revert.complete`            | `thread.reverted`                                     |
| `thread.activity.append`            | `thread.activity-appended`                            |

### Invariants (`commandInvariants.ts`, 160 lines)

Helpers called by the decider before emitting events:

- `requireProject` — project must exist and not be deleted (lines 41-56)
- `requireProjectAbsent` — project must NOT exist (lines 58-72)
- `requireThread` — thread must exist and not be deleted (lines 74-89)
- `requireThreadArchived` — thread must be archived (lines 91-108)
- `requireThreadNotArchived` — thread must NOT be archived (lines 110-127)
- `requireThreadAbsent` — thread must NOT exist (lines 129-143)

Invariant failures yield `OrchestrationCommandInvariantError` — no events are emitted.

### Cascading commands

`decideCommandSequence` (decider.ts:58-86) lets a single command trigger a chain. Example:
`project.delete` with `force=true` and active threads calls `decideCommandSequence` with N
`thread.delete` sub-commands followed by one `project.delete`. Each sub-command's events are
immediately projected into `nextReadModel` before the next command decides, ensuring internal
consistency within the cascade.

All events carry `commandId`, `correlationId` (= commandId), `causationEventId` — enabling full
causation tracing.

---

## 4. Projector — 17 events → in-memory read-model

**File:** `apps/server/src/orchestration/projector.ts` (654 lines)

A pure function: `(readModel, event) → OrchestrationReadModel`. Applied inside the SQL transaction
to keep the in-memory model synchronized with the event store.

### Events handled (17)

| Event                            | Read-model mutation                                                                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project.created`                | Add project entry, `deletedAt=null`                                                                                                                     |
| `project.meta-updated`           | Update title, workspaceRoot, defaultModelSelection, scripts                                                                                             |
| `project.deleted`                | Set `project.deletedAt`                                                                                                                                 |
| `thread.created`                 | Create thread (messages=[], activities=[], checkpoints=[], session=null, latestTurn=null)                                                               |
| `thread.deleted`                 | Set `thread.deletedAt`                                                                                                                                  |
| `thread.archived` / `unarchived` | Set/clear `thread.archivedAt`                                                                                                                           |
| `thread.meta-updated`            | Update title, modelSelection, branch, worktreePath                                                                                                      |
| `thread.runtime-mode-set`        | Update `runtimeMode`                                                                                                                                    |
| `thread.interaction-mode-set`    | Update `interactionMode`                                                                                                                                |
| `thread.message-sent`            | Create/update `OrchestrationMessage`; if `streaming=true`, **concatenate** text; else **replace**. Cap at MAX_THREAD_MESSAGES = 2000                    |
| `thread.session-set`             | Upsert `OrchestrationSession`; update `latestTurn.activeTurnId` if running                                                                              |
| `thread.proposed-plan-upserted`  | Upsert proposed plan. Cap at 200 plans                                                                                                                  |
| `thread.turn-diff-completed`     | Upsert `OrchestrationCheckpointSummary`. Guard: never overwrite `"ready"` with `"missing"` (lines 535-538). Update `latestTurn`. Cap at 500 checkpoints |
| `thread.reverted`                | Filter messages/activities/proposedPlans/checkpoints to those with turnIds ≤ turnCount                                                                  |
| `thread.activity-appended`       | Upsert activity. Cap at 500 activities                                                                                                                  |
| Unknown                          | Pass through unchanged                                                                                                                                  |

### `OrchestrationReadModel` structure

```typescript
{
  snapshotSequence: number;   // current event sequence
  projects: OrchestrationProject[];
  threads: OrchestrationThread[];  // each has messages, checkpoints, activities, proposedPlans, session, latestTurn
  updatedAt: ISO8601;
}
```

The in-memory model exists for low-latency reads inside the engine (decider invariant checks). SQL
projection tables are its durable mirror, queried by external consumers via
`ProjectionSnapshotQuery`.

---

## 5. OrchestrationEngine — serial worker, idempotency, observability

**Files:** `apps/server/src/orchestration/Layers/OrchestrationEngine.ts` (310 lines),
`apps/server/src/orchestration/Services/OrchestrationEngine.ts`

### Core internals

```typescript
// OrchestrationEngine.ts:80-83
let readModel = createEmptyReadModel(...);
const commandQueue = yield* Queue.unbounded<CommandEnvelope>();
const eventPubSub = yield* PubSub.unbounded<OrchestrationEvent>();
```

- **One mutable variable** (`readModel`) — updated serially, no locking needed.
- **Unbounded command queue** — back-pressure not enforced here; callers get deferred results.
- **Unbounded PubSub** — events published after commit to all active subscribers.

### Serial worker

```typescript
// OrchestrationEngine.ts:275
Effect.forever(Queue.take(commandQueue).pipe(Effect.flatMap(processEnvelope)));
```

Processes exactly one command at a time. Prevents concurrent read-model mutation and command ordering
issues.

### Idempotency

Every command can carry a `commandId` (UUID). The engine checks
`OrchestrationCommandReceiptRepository` before processing (lines 121-134):

- Previously accepted → return cached `resultSequence`.
- Previously rejected → return cached error without re-executing.
- New → process, then upsert receipt.

### SQL transaction (lines 141-185)

```typescript
sql.withTransaction(() => {
  for (const event of events) {
    eventStore.append(event); // append to event log
    readModel = projectEvent(readModel, event); // update in-memory model
    projectionPipeline.projectEvent(event); // update SQL projection tables
  }
  commandReceipt.upsert(commandId, "accepted", resultSequence);
});
```

### Startup rehydration (lines 272-279)

```typescript
const snapshot = yield * projectionSnapshotQuery.getSnapshot();
readModel = snapshot;
```

On startup the engine reloads the in-memory read-model from projection tables (no event replay needed
at runtime — projections are the read-model cache).

### Observability

- Metrics: `orchestrationCommandAckDuration`, `orchestrationCommandDuration`,
  `orchestrationCommandsTotal` (lines 190-229).
- Spans: per command type and event type.
- Logs: reconciliation failures, debug startup.

### Error handling

| Error                   | Read-model reconciled?         | Outcome                                                           |
| ----------------------- | ------------------------------ | ----------------------------------------------------------------- |
| Invariant failure       | No (nothing was written)       | Deferred fails with `OrchestrationCommandInvariantError`          |
| Previously rejected     | No (nothing new written)       | Deferred fails with `OrchestrationCommandPreviouslyRejectedError` |
| SQL transaction failure | Yes (reconcile from event log) | Deferred fails with persistence error                             |

---

## 6. Normalizer — pre-dispatch transformation

**File:** `apps/server/src/orchestration/Normalizer.ts` (143 lines)

Runs **before** the command reaches the engine. Converts client-supplied file content to server-managed
references.

- **`project.create` / `project.meta.update`** — normalizes `workspaceRoot` (validates path, optionally
  creates it).
- **`thread.turn.start`** — for each attachment:
  1. Parse base64 data URL → raw bytes (line 74).
  2. Validate MIME type is `image/*` (line 75).
  3. Validate 0 < size ≤ `PROVIDER_SEND_TURN_MAX_IMAGE_BYTES` (line 82).
  4. Write to `attachmentDir` (lines 113-129).
  5. Replace in command with `{ type: "image", id, name, mimeType, sizeBytes }` (line 130).
- **All other commands** — pass through unchanged.

Failures yield `OrchestrationDispatchCommandError` (line 25), rejecting the command before it touches
the engine.

---

## 7. HTTP endpoints in the orchestration layer

**File:** `apps/server/src/orchestration/http.ts` (94 lines)

Two endpoints, both require `session.role === "owner"` (line 34):

| Endpoint                           | Handler                                 | Returns                       |
| ---------------------------------- | --------------------------------------- | ----------------------------- |
| `POST /api/orchestration/dispatch` | Decode → normalize → engine.dispatch    | `{ sequence: number }`        |
| `GET /api/orchestration/snapshot`  | `ProjectionSnapshotQuery.getSnapshot()` | Full `OrchestrationReadModel` |

Error → status code mapping (lines 15-28):

- `OrchestrationDispatchCommandError` → 400
- `OrchestrationGetSnapshotError` → 500

**Why HTTP (not WS) for dispatch?** Commands are request-response by nature (caller needs the sequence
number to correlate with events). WebSocket subscriptions handle the async event stream.

---

## 8. ProjectionPipeline — 8 SQL tables, bootstrap, idempotency

**Files:** `apps/server/src/orchestration/Layers/ProjectionPipeline.ts` (1477 lines),
`apps/server/src/orchestration/Services/ProjectionPipeline.ts`

The pipeline materialises the event log into **8 SQL projection tables** (the durable read-model).

### Service interface

```typescript
readonly bootstrap: Effect<void, ProjectionRepositoryError>;
readonly projectEvent: (event: OrchestrationEvent) => Effect<void, ProjectionRepositoryError>;
```

### The 9 projectors and their events

| Projector             | SQL table                          | Key events handled                                                                                                                                                                                |
| --------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| projects              | `projection_projects`              | `project.created`, `project.meta-updated`, `project.deleted`                                                                                                                                      |
| threads               | `projection_threads`               | All thread lifecycle + message, plan, activity, session, checkpoint events                                                                                                                        |
| thread-messages       | `projection_thread_messages`       | `thread.message-sent`, `thread.reverted`                                                                                                                                                          |
| thread-proposed-plans | `projection_thread_proposed_plans` | `thread.proposed-plan-upserted`, `thread.reverted`                                                                                                                                                |
| thread-activities     | `projection_thread_activities`     | `thread.activity-appended`, `thread.reverted`                                                                                                                                                     |
| thread-sessions       | `projection_thread_sessions`       | `thread.session-set`                                                                                                                                                                              |
| thread-turns          | `projection_turns`                 | `thread.turn-start-requested`, `thread.session-set`, `thread.message-sent`, `thread.turn-interrupt-requested`, `thread.turn-diff-completed`, `thread.reverted` (checkpoint summaries stored here) |
| pending-approvals     | `projection_pending_approvals`     | `thread.activity-appended`, `thread.approval-response-requested`                                                                                                                                  |

### Idempotency and bootstrap

`projection_state` table tracks `lastAppliedSequence` per projector. On `bootstrap()`, each projector
reads its `lastAppliedSequence` and replays only events from that sequence forward — enabling safe
server restarts without full replay. On per-event projection, the sequence is committed inside the
transaction alongside the SQL writes.

**Determinism:** All 8 projectors run sequentially per event (`concurrency: 1`, line 1426) to preserve
ordering invariants.

### Attachment side effects

Attachment writes (physical files) happen **outside the SQL transaction** (lines 1397-1406). This is a
known tradeoff: file writes cannot be part of a DB transaction, so a crash between DB commit and file
write leaves a stale file but the DB reflects the correct state. The projector never reads stale files
— it only writes metadata references.

### Notable invariant: checkpoint `"ready"` guard

When projecting `thread.turn-diff-completed`, the pipeline never overwrites a `"ready"` status
checkpoint with `"missing"` (lines 535-538 of the projection). Multiple diff-completion events can
race; the guard ensures that once a diff is ready, it stays ready.

---

## 9. ProviderRuntimeIngestion — provider events → orchestration commands

**Files:** `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` (1572 lines),
`apps/server/src/orchestration/Services/ProviderRuntimeIngestion.ts`

This is the bridge from provider adapters to the orchestration engine. It consumes
`ProviderRuntimeEvent` streams (from all active sessions) and converts them to `OrchestrationCommand`s
dispatched to the engine.

### Event-to-command mapping (complete table)

| `ProviderRuntimeEvent` type          | `OrchestrationCommand(s)` dispatched               | Notes                                                                |
| ------------------------------------ | -------------------------------------------------- | -------------------------------------------------------------------- |
| `session.started`                    | `thread.session.set` (status="ready" or "running") | Lines 1143-1221                                                      |
| `session.state.changed`              | `thread.session.set`                               | Maps runtime state to session status                                 |
| `session.exited`                     | `thread.session.set` (status="stopped")            | Triggers `clearTurnStateForSession()`                                |
| `thread.started`                     | `thread.session.set`                               | Preserves active turn state                                          |
| `turn.started`                       | `thread.session.set`                               | Sets activeTurnId; marks source proposed-plan as implemented         |
| `turn.completed`                     | `thread.session.set` + finalizations               | Flushes buffered assistant text, completes proposed plans            |
| `content.delta` (assistant_text)     | `thread.message.assistant.delta`                   | Buffered or streamed depending on `enableAssistantStreaming` setting |
| `request.opened`                     | `thread.activity.append`                           | Flushes buffered text before recording approval event                |
| `request.resolved`                   | `thread.activity.append`                           | Records decision                                                     |
| `turn.proposed.delta`                | (buffering only, no command yet)                   | Accumulates into `bufferedProposedPlanById`                          |
| `turn.proposed.completed`            | `thread.proposed-plan.upsert`                      | Flushes buffered plan markdown                                       |
| `item.completed` (assistant_message) | `thread.message.assistant.complete`                | Finalizes streaming segment                                          |
| `runtime.error`                      | `thread.session.set` (status="error")              | Lines 1443-1467                                                      |
| `thread.metadata.updated`            | `thread.meta.update`                               | Updates thread title                                                 |
| `turn.diff.updated`                  | `thread.turn.diff.complete`                        | Creates placeholder checkpoint                                       |
| All activity-mapped events           | `thread.activity.append`                           | Via `runtimeEventToActivities()`, lines 180-521                      |

### Internal per-turn state

```typescript
// State caches keyed by (threadId, turnId)
turnMessageIdsByTurnKey: Cache<TurnKey, Set<MessageId>>; // messages in this turn
assistantSegmentStateByTurnKey: Cache<TurnKey, SegmentState>; // active streaming segment
bufferedAssistantTextByMessageId: Cache<MessageId, string>; // accumulated text
bufferedProposedPlanById: Cache<PlanId, BufferedPlan>; // accumulated plan markdown
```

All caches are TTL-bound (120 minutes per turn key, line 42-46). On `session.exited`,
`clearTurnStateForSession()` (lines 977-1019) invalidates all entries for that session immediately.

### Buffering logic

When `enableAssistantStreaming=false` (default), text is accumulated in
`bufferedAssistantTextByMessageId`. When accumulated text exceeds `MAX_BUFFERED_ASSISTANT_CHARS =
24_000` (line 47), the buffer overflows and the excess chunk is dispatched immediately to prevent
unbounded memory growth.

**Flush points:**

- Explicit `request.opened` / `user-input.requested` — flushes before recording the approval event
  (lines 1282-1293) so the UI sees the complete assistant text before the approval prompt.
- `turn.completed` — flushes all buffered messages for the turn (lines 1407-1424).
- `session.exited` — discards all buffers (state cleared, no flush).

### `T3CODE_STRICT_PROVIDER_LIFECYCLE_GUARD`

Enabled unless `T3CODE_STRICT_PROVIDER_LIFECYCLE_GUARD=0`. Enforces ordering invariants (lines
1111-1136):

- A turn cannot start if another is already active (`conflictsWithActiveTurn`).
- A turn cannot complete if missing turn ID while another is active.
- Only the active turn may close the lifecycle.

When the guard fires, the session lifecycle event is dropped and a warning is logged. When disabled,
all lifecycle events are accepted regardless — useful for replaying or recovering from edge cases.

### DrainableWorker

`makeDrainableWorker(processInputSafely)` (line 1544). Two input sources:

1. Provider runtime stream — all `ProviderRuntimeEvent`s from `providerService.streamEvents`.
2. Orchestration domain events — only `thread.turn-start-requested` events (to update internal
   proposed-plan tracking, lines 1554-1559).

Processing is sequential (`concurrency: 1`, line 806). Non-interrupt errors are logged and processing
continues (lossy-but-continue). `drain()` resolves when both queues are empty.

---

## 10. Reactors

The **`OrchestrationReactor`** (`Layers/OrchestrationReactor.ts`) is a coordinator that starts four
independent workers:

### 10.1 ProviderCommandReactor

Subscribes to `orchestrationEngine.streamDomainEvents`, filters for provider-intent event types, and
dispatches to `providerService`:

| Event type                             | Provider action                           |
| -------------------------------------- | ----------------------------------------- |
| `thread.turn-start-requested`          | `providerService.sendTurn(...)`           |
| `thread.turn-interrupt-requested`      | `providerService.interruptTurn(...)`      |
| `thread.approval-response-requested`   | `providerService.respondToRequest(...)`   |
| `thread.user-input-response-requested` | `providerService.respondToUserInput(...)` |
| `thread.checkpoint-revert-requested`   | `providerService.rollbackThread(...)`     |
| `thread.session-stop-requested`        | `providerService.stopSession(...)`        |

Has `drain()` for deterministic test synchronization.

### 10.2 CheckpointReactor

Consumes orchestration domain events + provider runtime events (dual queue):

1. On `thread.turn-start-requested` — captures git baseline ref, publishes
   `checkpoint.baseline.captured` receipt.
2. On `turn.completed` — computes diff between baseline and current HEAD, dispatches
   `thread.turn.diff.complete` command, publishes `checkpoint.diff.finalized` receipt.
3. On queue drain — publishes `turn.processing.quiesced` receipt.

Has `drain()`. Publishes to `RuntimeReceiptBus`.

### 10.3 ThreadDeletionReactor

Filters domain events for `thread.deleted`:

1. `providerService.stopSession({ threadId })` — stops any running session.
2. `terminalManager.close({ threadId, deleteHistory: true })` — closes terminal history.

Best-effort cleanup: non-interrupt failures are logged but do not stop the reactor
(`logCleanupCauseUnlessInterrupted`, lines 15-34).

Has `drain()`.

---

## 11. RuntimeReceiptBus — test synchronization milestones

**Files:** `apps/server/src/orchestration/Services/RuntimeReceiptBus.ts` (65 lines),
`apps/server/src/orchestration/Layers/RuntimeReceiptBus.ts` (37 lines)

Internal milestone events for test coordination, not exposed to clients.

### Receipt types

- `checkpoint.baseline.captured` — git baseline captured (from CheckpointReactor).
- `checkpoint.diff.finalized` — diff computed and stored.
- `turn.processing.quiesced` — turn processing queue empty.

### Two implementations

| Implementation          | `publish()`           | Used in    |
| ----------------------- | --------------------- | ---------- |
| `RuntimeReceiptBusLive` | `Effect.void` (no-op) | Production |
| `RuntimeReceiptBusTest` | PubSub-backed         | Tests      |

In tests, `streamEventsForTest` returns a hot PubSub subscription. Tests can await specific receipt
types to synchronize without `sleep()` calls, eliminating timing-sensitive flakes.

**Only CheckpointReactor publishes.** Receipts are never visible outside the server process.

---

## 12. Runtime layer composition

**File:** `apps/server/src/orchestration/runtimeLayer.ts` (28 lines)

```
OrchestrationEventInfrastructureLayerLive
  = OrchestrationEventStoreLive + OrchestrationCommandReceiptRepositoryLive

OrchestrationProjectionPipelineLayerLive
  = OrchestrationProjectionPipelineLive (with OrchestrationEventStoreLive)

OrchestrationInfrastructureLayerLive
  = OrchestrationProjectionSnapshotQueryLive
  + OrchestrationEventInfrastructureLayerLive
  + OrchestrationProjectionPipelineLayerLive

OrchestrationLayerLive
  = OrchestrationInfrastructureLayerLive + OrchestrationEngineLive
```

The event store is shared by both the pipeline (for bootstrap replay) and the engine (for appends).
The snapshot query bootstraps the engine's in-memory model at startup.

---

## 13. Error taxonomy

**File:** `apps/server/src/orchestration/Errors.ts` (124 lines)

All are `Schema.TaggedErrorClass` (Effect-native, round-trippable across process boundaries):

```
OrchestrationDispatchError
  = ProjectionRepositoryError
  | OrchestrationCommandInvariantError    (commandType, detail)
  | OrchestrationCommandPreviouslyRejectedError (commandId, detail)
  | OrchestrationProjectorDecodeError     (eventType, issue)
  | OrchestrationListenerCallbackError

OrchestrationEngineError
  = OrchestrationDispatchError
  | OrchestrationCommandJsonParseError
  | OrchestrationCommandDecodeError
```

HTTP layer maps these to status codes (see §7). WebSocket clients receive the tagged error union
schema-decoded at the transport boundary.

---

## Key design decisions

1. **Serial command processing** — one worker, no concurrency. Prevents read-model corruption and
   ordering bugs at the cost of throughput (acceptable: commands are infrequent, turns are long).
2. **In-memory + SQL duality** — in-memory for decider invariant checks (fast), SQL for external
   queries and crash recovery (authoritative).
3. **Transactional atomicity** — event append, read-model update, receipt upsert all in one
   transaction. No partial state.
4. **Causation chains** — `commandId`, `correlationId`, `causationEventId` on every event. Full
   traceability from user action to provider side effect.
5. **RuntimeReceiptBus as production no-op** — test infrastructure does not pay for receipt storage
   in production.
6. **Normalizer at the boundary** — file I/O happens before the command reaches the domain, keeping
   the decider pure.
