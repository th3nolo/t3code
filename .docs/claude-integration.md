# Claude Agent SDK integration

> The Claude integration uses the official `@anthropic-ai/claude-agent-sdk` Query API — not raw
> stdio. It was hardened against process leaks in commit `e0117b27` (predates `9df3c640`). All
> file/line references are for `9df3c640`.

---

## 1. Why the SDK Query API

`ClaudeAdapter.ts:8-21` imports from `@anthropic-ai/claude-agent-sdk`. The SDK provides:

- **No bespoke framing** — the SDK marshals JSON; the adapter consumes typed `SDKMessage` values.
- **In-flight control** — `setModel()`, `setPermissionMode()`, `setMaxThinkingTokens()` can be called on a live session without a side-channel.
- **Streaming prompts** — user input arrives via `Stream.fromQueue(promptQueue).toAsyncIterable()` consumed lazily by the SDK.

**`ClaudeQueryRuntime` interface** (`ClaudeAdapter.ts:163-170`):

```typescript
interface ClaudeQueryRuntime extends AsyncIterable<SDKMessage> {
  readonly interrupt: () => Promise<void>;
  readonly setModel: (model?: string) => Promise<void>;
  readonly setPermissionMode: (mode: PermissionMode) => Promise<void>;
  readonly setMaxThinkingTokens: (maxThinkingTokens: number | null) => Promise<void>;
  readonly close: () => void;
}
```

The runtime is both an `AsyncIterable<SDKMessage>` (yields messages during execution) and a control surface.

---

## 2. Session lifecycle

### Start (`ClaudeAdapter.ts:2420-2992`)

1. Validate `provider === "claudeAgent"`.
2. Stop any existing session for the thread (best-effort, non-blocking).
3. Allocate `promptQueue = Queue.unbounded<PromptQueueItem>()`.
4. Construct the lazy async-iterable stream:
   ```typescript
   const prompt = Stream.fromQueue(promptQueue)
     .pipe(Stream.filter((item) => item.type === "message"))
     .pipe(Stream.map((item) => item.message))
     .pipe(Stream.toAsyncIterable);
   ```
5. Parse resume cursor via `readClaudeResumeState(input.resumeCursor)`.
6. Call `query({ prompt, options })` — this starts the SDK runtime.
7. Fork streaming fiber: `Stream.fromAsyncIterable(context.query)` → `handleSdkMessage` for each message.

### Prompt queue (`ClaudeAdapter.ts:2508-2516`, `3077-3080`)

`PromptQueueItem` is `{ type: "message", message: SDKUserMessage } | { type: "terminate" }`. Each `sendTurn` call enqueues a `"message"` item. `Queue.shutdown` on stop terminates the iterable stream.

Both calls to `setModel` and `setPermissionMode` happen **before** `Queue.offer()` enqueues the user message, guaranteeing the mode is set before the turn begins executing.

### Resume cursor (`ClaudeAdapter.ts:358-393`)

`readClaudeResumeState(raw)` validates and extracts:

| Field             | Validation                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------- |
| `resume`          | Must be a valid UUID — this is the SDK session ID to resume                               |
| `threadId`        | Must not match `isSyntheticClaudeThreadId` (rejects IDs starting with `"claude-thread-"`) |
| `resumeSessionAt` | Optional ISO string — last assistant message for re-sync                                  |
| `turnCount`       | Optional non-negative integer                                                             |

The orchestration layer never synthesizes a Claude resume cursor — it only round-trips the opaque value from the adapter.

### Stop (`ClaudeAdapter.ts:2375-2434` — `stopSessionInternal`)

Exact sequence:

1. `context.stopped = true` (idempotency guard)
2. For each pending approval: `Deferred.succeed(decision, "cancel")`, emit `request.resolved`
3. `completeTurn(context, "interrupted", "Session stopped.")` if active turn
4. `Queue.shutdown(context.promptQueue)`
5. `Fiber.interrupt(streamFiber)` if alive
6. `context.query.close()` in try/catch — SDK cleanup failures must not break teardown
7. Set `context.session.status = "closed"`, clear `activeTurnId`
8. Emit `session.exited { exitKind: "graceful" }` (unless suppressed)
9. `sessions.delete(threadId)`

### Layer finalizer (`ClaudeAdapter.ts:3180-3189`)

`Effect.addFinalizer` calls `stopSessionInternal(ctx, { emitExitEvent: false })` for every session, then shuts down `runtimeEventQueue`. This was the structural fix from the `e0117b27` leak commit — sessions cannot survive layer scope exit.

---

## 3. Streaming fiber and message dispatch

`ClaudeAdapter.ts:2329-2335` — `runSdkStream`:

```typescript
Stream.fromAsyncIterable(context.query, toError)
  .pipe(Stream.takeWhile(() => !context.stopped))
  .pipe(Stream.runForEach((message) => handleSdkMessage(context, message)));
```

`handleSdkMessage` (`ClaudeAdapter.ts:2291-2325`) dispatches by `message.type`:

| `message.type`                                                                 | Handler                     |
| ------------------------------------------------------------------------------ | --------------------------- |
| `"stream_event"`                                                               | `handleStreamEvent`         |
| `"user"`                                                                       | `handleUserMessage`         |
| `"assistant"`                                                                  | `handleAssistantMessage`    |
| `"result"`                                                                     | `handleResultMessage`       |
| `"system"`                                                                     | `handleSystemMessage`       |
| `"tool_progress"`, `"tool_use_summary"`, `"auth_status"`, `"rate_limit_event"` | `handleSdkTelemetryMessage` |

---

## 4. SDK message → ProviderRuntimeEvent — complete mapping

| SDK `message.type` | Subtype / condition                                                  | `ProviderRuntimeEvent`                                 |
| ------------------ | -------------------------------------------------------------------- | ------------------------------------------------------ |
| `stream_event`     | `content_block_delta: text_delta`                                    | `content.delta` (streamKind: `"assistant_text"`)       |
| `stream_event`     | `content_block_delta: thinking_delta`                                | `content.delta` (streamKind: `"reasoning_text"`)       |
| `stream_event`     | `content_block_delta: input_json_delta`                              | `item.updated`                                         |
| `stream_event`     | `content_block_delta: input_json_delta` + TodoWrite                  | `turn.plan.updated`                                    |
| `stream_event`     | `content_block_start: text`                                          | `item.started`                                         |
| `stream_event`     | `content_block_start: tool_use` / `server_tool_use` / `mcp_tool_use` | `item.started`                                         |
| `stream_event`     | `content_block_stop`                                                 | `item.completed`                                       |
| `user`             | `tool_result`                                                        | `item.updated` + `content.delta` + `item.completed`    |
| `assistant`        | ExitPlanMode tool_use                                                | `turn.proposed.completed`                              |
| `assistant`        | other content                                                        | `turn.started` (synthetic, once per assistant message) |
| `result`           | success                                                              | `turn.completed`                                       |
| `result`           | `error_during_execution`                                             | `runtime.error` + `turn.completed`                     |
| `system`           | `init`                                                               | `session.configured`                                   |
| `system`           | `status`                                                             | `session.state.changed`                                |
| `system`           | `compact_boundary`                                                   | `thread.state.changed { state: "compacted" }`          |
| `system`           | `hook_started`                                                       | `hook.started`                                         |
| `system`           | `hook_progress`                                                      | `hook.progress`                                        |
| `system`           | `hook_response`                                                      | `hook.completed`                                       |
| `system`           | `task_started`                                                       | `task.started`                                         |
| `system`           | `task_progress`                                                      | `thread.token-usage.updated` + `task.progress`         |
| `system`           | `task_notification`                                                  | `thread.token-usage.updated` + `task.completed`        |
| `system`           | `files_persisted`                                                    | `files.persisted`                                      |
| `tool_progress`    | —                                                                    | `tool.progress`                                        |
| `tool_use_summary` | —                                                                    | `tool.summary`                                         |
| `auth_status`      | —                                                                    | `auth.status`                                          |
| `rate_limit_event` | —                                                                    | `account.rate-limits.updated`                          |

Every emitted event includes `raw: { source: "claude.sdk", method, messageType, payload }`.

---

## 5. Approval handling

`ClaudeAdapter.ts:2598-2750` — `canUseToolEffect`:

The SDK's `canUseTool` callback fires for each tool call. T3 Code converts it to a blocking Effect:

1. Create `Deferred<ProviderApprovalDecision>`.
2. Register in `pendingApprovals` map.
3. Emit `request.opened` — `requestType` from `classifyRequestType(toolName)`, `detail` from `summarizeToolRequest(toolName, toolInput)`.
4. Register `signal.addEventListener("abort", onAbort)` — auto-cancel if the SDK aborts.
5. `Deferred.await(decision)` — blocks the callback.
6. External `respondToRequest(threadId, requestId, decision)` resolves the Deferred.
7. Emit `request.resolved`.
8. Map decision to `PermissionResult`:

| Decision                 | SDK `PermissionResult`                                                 |
| ------------------------ | ---------------------------------------------------------------------- |
| `"accept"`               | `{ behavior: "allow", updatedInput: toolInput }`                       |
| `"acceptForSession"`     | `{ behavior: "allow", updatedInput, updatedPermissions: suggestions }` |
| `"decline"` / `"cancel"` | `{ behavior: "deny", message: "..." }`                                 |

---

## 6. Per-turn model and permission changes

Happen **inside `sendTurn` before `Queue.offer()`**:

**`setModel`** (`ClaudeAdapter.ts:3011-3016`): Calls `context.query.setModel(apiModelId)` only if the API model ID differs from `context.currentApiModelId`. Tracks current model to avoid redundant SDK calls.

**`setPermissionMode`** (`ClaudeAdapter.ts:3027-3037`):

- `interactionMode === "plan"` → `setPermissionMode("plan")`
- `interactionMode === "default"` → restore `context.basePermissionMode`
- `interactionMode` absent → leave mode unchanged

---

## 7. ProviderSessionReaper

`apps/server/src/provider/Layers/ProviderSessionReaper.ts:19-133`:

- **Sweep interval:** 5 minutes (`DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000`)
- **Idle threshold:** 30 minutes (`DEFAULT_INACTIVITY_THRESHOLD_MS = 30 * 60 * 1000`)
- **Skip active turns:** Never reaps a session with a non-null `activeTurnId`
- **Mechanism:** `Schedule.spaced` repeating fiber; compares `binding.lastSeenAt` against `Date.now()`

The reaper is a second line of defence against the Claude leak class — even if a code path forgets to stop a session, it will eventually be collected.

---

## 8. Auth and version probing — `ClaudeProvider.ts`

**Version** (`claude --version`): Parsed via `parseGenericCliVersion`. Gates Opus 4.7 — `MINIMUM_CLAUDE_OPUS_4_7_VERSION = "2.1.111"`.

**Auth status** (`claude auth status`): Parsed best-effort. If auth cannot be determined from the CLI output, a **fallback zero-turn SDK probe** (`ClaudeProvider.ts:567-603`) spawns `query({ maxTurns: 0 })`, reads only `initializationResult()`, and returns `subscriptionType` + `slashCommands`. No tokens consumed.

**Plan/subscription caching:** `Cache.make({ capacity: 1, timeToLive: Duration.minutes(5) })` keyed by binary path. Prevents repeated zero-turn probes on every refresh.

**Model gating:** `getBuiltInClaudeModelsForVersion(version)` excludes `claude-opus-4-7` from the model list if the CLI version predates `2.1.111`.

---

## 9. Text generation

`apps/server/src/git/Layers/ClaudeTextGeneration.ts:50-62`:

```
claude -p --output-format json --json-schema <schema>
       --model <id>
       [--effort <e>]
       [--settings <json>]
       --dangerously-skip-permissions
```

- `-p` — prompt mode (one-shot, non-interactive)
- `--dangerously-skip-permissions` — safe here: stateless, ephemeral, deterministic prompt with no agent loop or tool execution
- Output is decoded through `ClaudeOutputEnvelope` then the caller-supplied `outputSchemaJson`

---

## 10. Tests

`FakeClaudeQuery` (`ClaudeAdapter.test.ts:30-120`) implements `AsyncIterable<SDKMessage>` plus the control surface. Notable contracts locked by tests:

- Provider mismatch → `ProviderAdapterValidationError`
- Full-access sessions use `bypassPermissions` mode
- Resume cursors round-trip without pinning stale assistant checkpoints
