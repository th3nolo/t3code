# Codex CLI integration

> Codex is the primary provider. The server starts `codex app-server` (JSON-RPC over stdio) per
> session and streams structured events to the browser through WebSocket push. File/line references
> are for `9df3c640`.

---

## 1. Process spawn

`codexAppServerManager.ts:497-523`:

```typescript
const child = spawn(codexBinaryPath, ["app-server"], {
  cwd: resolvedCwd,
  env: { ...process.env, ...(codexHomePath ? { CODEX_HOME: codexHomePath } : {}) },
  stdio: ["pipe", "pipe", "pipe"],
  shell: process.platform === "win32",
});
const output = readline.createInterface({ input: child.stdout });
```

- Binary arg: `"app-server"`
- Stdio: all three piped
- Shell: Windows only
- Stdout framed line-by-line via `readline.createInterface`

---

## 2. JSON-RPC framing

**Write path** (`codexAppServerManager.ts:1640-1648`):

```typescript
context.child.stdin.write(`${JSON.stringify(message)}\n`);
```

**Read path** (`codexAppServerManager.ts:1460-1500`): Each stdout line is parsed as JSON, then dispatched:

| Message shape  | Has `id`? | Has `method`? | Dispatch target                                 |
| -------------- | --------- | ------------- | ----------------------------------------------- |
| Response       | ✓         | ✗             | `handleResponse` — resolves pending request     |
| Server request | ✓         | ✓             | `handleServerRequest` — approval/input request  |
| Notification   | ✗         | ✓             | `handleServerNotification` — lifecycle/progress |

Parse failures emit an internal `protocol/parseError` event.

---

## 3. Session context (`CodexSessionContext`)

`codexAppServerManager.ts:71-88`:

| Field                 | Type                                     | Purpose                                 |
| --------------------- | ---------------------------------------- | --------------------------------------- |
| `session`             | `ProviderSession`                        | Mutable session state                   |
| `account`             | `CodexAccountSnapshot`                   | Account type, plan, spark enablement    |
| `child`               | `ChildProcessWithoutNullStreams`         | Spawned process handle                  |
| `output`              | `readline.Interface`                     | Stdout line reader                      |
| `pending`             | `Map<PendingRequestKey, PendingRequest>` | In-flight RPC request callbacks         |
| `pendingApprovals`    | `Map<...>`                               | In-flight tool approval requests        |
| `pendingUserInputs`   | `Map<...>`                               | In-flight user-input requests           |
| `collabReceiverTurns` | `Map<string, TurnId>`                    | Child conversation thread → parent turn |
| `nextRequestId`       | `number`                                 | JSON-RPC request ID counter             |
| `stopping`            | `boolean`                                | Graceful shutdown flag                  |

---

## 4. Session startup sequence

`codexAppServerManager.ts:477-636`:

1. Spawn process, attach readline on stdout.
2. Initialize `CodexSessionContext`.
3. `attachProcessListeners(context)` — wire stderr, error, exit handlers.
4. Emit `session/connecting`.
5. Send `"initialize"` request with `buildCodexInitializeParams()`.
6. Send `"initialized"` notification.
7. `"model/list"` request (best-effort).
8. `"account/read"` request → `readCodexAccountSnapshot(response)` → `context.account`.
9. If `resumeCursor` provided: attempt `"thread/resume"`. On recoverable error, fall back to `"thread/start"` and emit `session/threadResumeFallback`.
10. Else: `"thread/start"`.
11. Extract `providerThreadId` from response, update session to `status: "ready"`, emit `session/ready`.

---

## 5. Resume logic

**Cursor field**: `{ threadId: string }` — the Codex provider thread ID.

**`isRecoverableThreadResumeError`** (`codexAppServerManager.ts:412-426`): Checks the error message for any of `["not found", "missing thread", "no such thread", "unknown thread", "does not exist"]`. Non-recoverable errors propagate; recoverable ones trigger the silent fallback.

**Fallback emission** (`codexAppServerManager.ts:599`): `session/threadResumeFallback` with message `"Could not resume thread {id}; started a new thread instead."` — the UI can show a warning.

---

## 6. Turn lifecycle

**`sendTurn`** (`codexAppServerManager.ts:649-740`):

1. Clear `collabReceiverTurns`.
2. Build `turnInput` array: `[{ type: "text", text, text_elements: [] }]` + image attachments.
3. Assemble `turn/start` params: `threadId`, `input`, optional `model`, `effort`, `serviceTier`, `collaborationMode`.
4. Send `"turn/start"` request, extract `turnId` from response.
5. Update session to `status: "running"`, `activeTurnId: turnId`.

**`interruptTurn`** (`codexAppServerManager.ts:742-757`): Send `"turn/interrupt"` with `threadId` + `turnId`. Completion notification arrives normally.

**`turn/started` notification** (`codexAppServerManager.ts:1393-1403`): Suppressed for child conversation threads. Updates session to `status: "running"`.

**`turn/completed` notification** (`codexAppServerManager.ts:1405-1418`): Clears `collabReceiverTurns`. Sets `status: "error"` for `"failed"`, else `"ready"`. Clears `activeTurnId`.

---

## 7. Event mapping — complete table

`CodexAdapter.ts:574-1343` — `mapToRuntimeEvents`:

| Codex method                                                                                                                                                 | `ProviderRuntimeEvent`                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| `session/connecting`                                                                                                                                         | `session.state.changed { state: "starting" }` |
| `session/ready`                                                                                                                                              | `session.state.changed { state: "ready" }`    |
| `session/started`                                                                                                                                            | `session.started`                             |
| `session/exited`, `session/closed`                                                                                                                           | `session.exited`                              |
| `thread/started`                                                                                                                                             | `thread.started`                              |
| `thread/status/changed`, `thread/archived`, `thread/unarchived`, `thread/closed`, `thread/compacted`                                                         | `thread.state.changed`                        |
| `thread/name/updated`                                                                                                                                        | `thread.metadata.updated`                     |
| `thread/tokenUsage/updated`                                                                                                                                  | `thread.token-usage.updated`                  |
| `turn/started`                                                                                                                                               | `turn.started`                                |
| `turn/completed`                                                                                                                                             | `turn.completed`                              |
| `turn/aborted`                                                                                                                                               | `turn.aborted`                                |
| `turn/plan/updated`                                                                                                                                          | `turn.plan.updated`                           |
| `turn/diff/updated`                                                                                                                                          | `turn.diff.updated`                           |
| `item/started`                                                                                                                                               | `item.started`                                |
| `item/completed` (plan)                                                                                                                                      | `turn.proposed.completed`                     |
| `item/completed` (other)                                                                                                                                     | `item.completed`                              |
| `item/reasoning/summaryPartAdded`, `item/commandExecution/terminalInteraction`                                                                               | `item.updated`                                |
| `item/plan/delta`                                                                                                                                            | `turn.proposed.delta`                         |
| `item/agentMessage/delta`, `item/commandExecution/outputDelta`, `item/fileChange/outputDelta`, `item/reasoning/summaryTextDelta`, `item/reasoning/textDelta` | `content.delta`                               |
| `item/mcpToolCall/progress`                                                                                                                                  | `tool.progress`                               |
| `item/tool/requestUserInput` (request)                                                                                                                       | `user-input.requested`                        |
| `item/commandExecution/requestApproval`, `item/fileRead/requestApproval`, `item/fileChange/requestApproval`                                                  | `request.opened`                              |
| `item/requestApproval/decision`                                                                                                                              | `request.resolved`                            |
| `item/tool/requestUserInput/answered`                                                                                                                        | `user-input.resolved`                         |
| `codex/event/task_started`                                                                                                                                   | `task.started`                                |
| `codex/event/task_complete`                                                                                                                                  | `turn.proposed.completed` + `task.completed`  |
| `codex/event/agent_reasoning`                                                                                                                                | `task.progress`                               |
| `codex/event/reasoning_content_delta`                                                                                                                        | `content.delta`                               |
| `error` (willRetry=true)                                                                                                                                     | `runtime.warning`                             |
| `error` (willRetry=false)                                                                                                                                    | `runtime.error`                               |
| `process/stderr` (fatal)                                                                                                                                     | `runtime.error`                               |
| `process/stderr` (other)                                                                                                                                     | `runtime.warning`                             |
| `model/rerouted`                                                                                                                                             | `model.rerouted`                              |
| `account/updated`                                                                                                                                            | `account.updated`                             |
| `account/rateLimits/updated`                                                                                                                                 | `account.rate-limits.updated`                 |
| `deprecationNotice`                                                                                                                                          | `deprecation.notice`                          |
| `configWarning`                                                                                                                                              | `config.warning`                              |
| `mcpServer/oauthLogin/completed`                                                                                                                             | `mcp.oauth.completed`                         |
| `thread/realtime/*`                                                                                                                                          | `thread.realtime.*`                           |

Every emitted event preserves the original Codex payload in a `raw` field.

---

## 8. Stderr classification

`codexAppServerManager.ts:408-427` — `classifyCodexStderrLine`:

1. Strip ANSI escape codes.
2. Skip empty lines.
3. Match `YYYY-MM-DDTHH:MM:SS LEVEL TAG: MESSAGE` pattern:
   - Non-`ERROR` levels → ignored
   - Lines containing `"state db missing rollout path for thread"` or `"state db record_discrepancy"` → ignored (known-benign)
4. All other non-empty lines → `{ message: line }`

**Fatal patterns** (`CodexAdapter.ts:108-113`): `"failed to connect to websocket"` → `isFatalCodexProcessStderrMessage` → `runtime.error` (vs. `runtime.warning` for non-fatal stderr).

---

## 9. CLI version check

`codexAppServerManager.ts:1620-1670` — `assertSupportedCodexCliVersion`:

- Uses `spawnSync` with a 4-second timeout (`CODEX_VERSION_CHECK_TIMEOUT_MS = 4_000`)
- Calls `codex --version`, parses via `parseCodexCliVersion`
- Minimum version: `MINIMUM_CODEX_CLI_VERSION = "0.37.0"` (`codexCliVersion.ts:5`)
- On unsupported version: throws with `formatCodexCliUpgradeMessage(version)` — surfaces as startup error, not a mid-session surprise

---

## 10. Account and model

`codexAccount.ts` — `readCodexAccountSnapshot`:

**Account types:**

- `"apiKey"` — OpenAI API key (spark disabled)
- `"chatgpt"` — ChatGPT subscription (`sparkEnabled` iff `planType === "pro"`)
- `"unknown"` — unrecognized type

**Model downgrade** — `resolveCodexModelForAccount` (`codexAccount.ts:117-124`): If user requests `gpt-5.3-codex-spark` but `account.sparkEnabled === false`, downgrades to `gpt-5.3-codex`. Account read failures default to `sparkEnabled: false`.

---

## 11. Collaboration child conversations

`codexAppServerManager.ts:1520-1566`:

`collabReceiverTurns: Map<string, TurnId>` maps child conversation thread IDs to their parent turn ID. Populated from `collabAgentToolCall` item notifications; cleared on turn start and completion.

Inbound notifications from child threads are **re-routed** to the parent turn ID (`effectiveTurnId = childParentTurnId ?? rawRoute.turnId`). Thread-level lifecycle events for child threads (e.g. `thread/started`, `turn/started`, `turn/completed`) are suppressed entirely — `shouldSuppressChildConversationNotification()` returns true for 14 notification types.

---

## 12. Discovery probe

`codexAppServer.ts:103-253` — `probeCodexDiscovery`:

Spawns a short-lived `codex app-server` session and sends three RPC calls:

1. `initialize` (id=1)
2. On initialize response: `skills/list` (id=2) and `account/read` (id=3) in parallel
3. Returns `{ account: CodexAccountSnapshot, skills: ReadonlyArray<ServerProviderSkill> }`

Used once per provider refresh to populate the Codex snapshot in `ProviderRegistry`.

---

## 13. Text generation

`CodexTextGeneration.ts:141-162` — exact flags:

```
codex exec
  --ephemeral               # Temporary session, no history
  --skip-git-repo-check     # Skip git validation
  -s read-only              # Read-only sandbox
  --model <id>
  --config model_reasoning_effort="<e>"
  [--config service_tier="fast"]
  --output-schema <path>    # JSON schema file
  --output-last-message <path>  # Output file
  [--image <path> ...]
  -                         # Prompt from stdin
```

- 180-second timeout (`CODEX_TIMEOUT_MS = 180_000`)
- Schema and output files are temp files cleaned via `Effect.ensuring(cleanup)`
- Output decoded by parsing the output file against caller-supplied `outputSchemaJson` via Effect Schema

---

## 14. `CodexAdapter` layer

`CodexAdapter.ts` wraps `CodexAppServerManager` in an `Effect.acquireRelease` layer:

- **Acquire:** `new CodexAppServerManager(services)` (or use injected instance for tests)
- **Release:** `manager.stopAll()` — stops all active sessions on layer teardown
- **Event bridge:** Registers `manager.on("event", listener)` to transform `ProviderEvent` → `ProviderRuntimeEvent` via `mapToRuntimeEvents`, then `Queue.offerAll(runtimeEventQueue, runtimeEvents)`
- **Session errors:** `toSessionError(cause)` maps message substrings `"unknown session"` → `ProviderAdapterSessionNotFoundError`, `"session is closed"` → `ProviderAdapterSessionClosedError`

---

## 15. Tests

- **Pure-function tests** (`codexAppServerManager.test.ts:178-369`): stderr classification, resume-error recoverability, model-slug normalization, account/model resolvers. No process spawning.
- **Harness fakes** (`codexAppServerManager.test.ts:22-176`): `createSendTurnHarness` and `createThreadControlHarness` spy on private methods without JSON-RPC framing.
- **Adapter projection tests** (`CodexAdapter.test.ts:290-874`): Inject raw events into `FakeCodexManager`, assert mapped `ProviderRuntimeEvent`. Bulk of regression coverage.
- **Live integration test** (`codexAppServerManager.test.ts:1147-1217`): Gated on `CODEX_BINARY_PATH`. Exercises `thread/resume` end-to-end across spawn-stop-respawn.
