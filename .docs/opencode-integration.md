# OpenCode integration

> OpenCode is the only provider that runs as a separate HTTP server (its own daemon, accessible via
> the `@opencode-ai/sdk/v2` TypeScript SDK) rather than a child process speaking stdio. File/line
> references are for `9df3c640`.

---

## 1. Two server modes

`opencodeRuntime.ts`:

### Local spawn — `startOpenCodeServerProcess` (lines 352-449)

```
opencode serve --hostname=127.0.0.1 --port=<auto>
```

- Parses stdout for the line matching `OPENCODE_SERVER_READY_PREFIX = "opencode server listening"` (line 85) and extracts URL via `/on\s+(https?:\/\/[^\s]+)/`.
- **5-second startup timeout** (`DEFAULT_OPENCODE_SERVER_TIMEOUT_MS = 5_000`, line 27). ENOENT or timeout → error snapshot.
- Returns `OpenCodeServerProcess { url, process, close() }`.

### External server — `connectToOpenCodeServer` (lines 451-481)

If `settings.serverUrl.trim()` is non-empty, returns a connection object pointing at that URL with `process: null` and `external: true`. No spawn. HTTP Basic auth applies when `serverPassword` is set and `external: true`.

### Binary discovery — `resolveOpenCodeBinaryPath` (lines 303-311)

Absolute path → return as-is. Relative name → resolve via `which opencode` (3-second timeout).

---

## 2. Session lifecycle

### Start (`OpenCodeAdapter.ts:855-982`)

1. Retrieve settings (binaryPath, serverUrl, serverPassword).
2. Stop any existing session for the thread.
3. `connectToOpenCodeServer(...)` → `createOpenCodeSdkClient(...)`.
4. `client.session.create({ permissionRules: buildOpenCodePermissionRules(runtimeMode) })` — permission rules set once at session creation.
5. Guard against concurrent `startSession` for the same thread (discard the latecomer).
6. Build `OpenCodeSessionContext`.
7. Fork event pump via `startEventPump(context)`.
8. Emit `session.started`, `thread.started`.

### Stop

`stopOpenCodeContext(context)` (`OpenCodeAdapter.ts:372-381`):

```typescript
context.stopped = true;
context.eventsAbortController.abort();
await client.session.abort({ sessionID: context.openCodeSessionId }).catch(() => undefined);
context.server.close();
```

The adapter only closes the server if it owns it (spawned locally); external servers are left running.

---

## 3. Event pump

`OpenCodeAdapter.ts:516-853` — `startEventPump`:

```typescript
const subscription = await client.event.subscribe(undefined, {
  signal: context.eventsAbortController.signal,
});

for await (const event of subscription.stream) {
  const payloadSessionId = event.properties?.sessionID;
  if (payloadSessionId !== context.openCodeSessionId) continue;
  // ... dispatch by event.type
}
```

**Filtering by sessionID** (lines 524-530): Events from other sessions are discarded. All 11 event types are handled in a single switch.

**Process death monitoring** (lines 844-852): If the locally-spawned server process exits unexpectedly (while the pump is running), `runtime.error` + `session.exited` are emitted.

---

## 4. Event mapping — complete table

| OpenCode event         | Condition                             | `ProviderRuntimeEvent`                                                      |
| ---------------------- | ------------------------------------- | --------------------------------------------------------------------------- |
| `message.updated`      | role = `"assistant"`                  | calls `mergeOpenCodeAssistantText` → `content.delta` for new portion        |
| `message.removed`      | any                                   | (internal: removes from `messageRoleById` map)                              |
| `message.part.delta`   | role = `"assistant"`, delta non-empty | `content.delta` (deduplicated via `appendOpenCodeAssistantTextDelta`)       |
| `message.part.updated` | role = `"assistant"`, text/reasoning  | `content.delta` + `item.completed`                                          |
| `message.part.updated` | role = `"assistant"`, tool            | `item.started` / `item.updated` / `item.completed` (by `tool.state.status`) |
| `permission.asked`     | any                                   | `request.opened`                                                            |
| `permission.replied`   | any                                   | `request.resolved`                                                          |
| `question.asked`       | any                                   | `user-input.requested`                                                      |
| `question.replied`     | any                                   | `user-input.resolved`                                                       |
| `question.rejected`    | any                                   | `user-input.resolved { answers: {} }`                                       |
| `session.status`       | `type === "busy"`                     | (internal: `activeTurnId` set)                                              |
| `session.status`       | `type === "retry"`                    | `runtime.warning`                                                           |
| `session.status`       | `type === "idle"` + turnId exists     | `turn.completed { state: "completed" }`                                     |
| `session.error`        | any                                   | `turn.completed { state: "failed" }` (if activeTurn) + `runtime.error`      |

---

## 5. Text delta deduplication

OpenCode sometimes resends overlapping windows — the same text arrives in successive events.

**`mergeOpenCodeAssistantText`** (`OpenCodeAdapter.ts:266-278`):

1. If `nextText` is shorter and is a prefix of `previousText`, keep `previousText` (regression guard).
2. Else use `nextText`.
3. Emit only `latestText.slice(commonPrefixLength(previousText, latestText))`.

**`appendOpenCodeAssistantTextDelta`** (`OpenCodeAdapter.ts:280-292`): For incremental deltas — finds the longest overlap between the end of `previousText` and the start of `delta`, emits only the non-overlapping tail.

---

## 6. Permission rules

`opencodeRuntime.ts` — `buildOpenCodePermissionRules(runtimeMode)`:

**`"full-access"`** → `[{ permission: "*", pattern: "*", action: "allow" }]`

**All other modes** → ask for: `*`, `bash`, `edit`, `webfetch`, `websearch`, `codesearch`, `external_directory`, `doom_loop` — all patterns. Auto-allow `question`.

Rules are passed to `client.session.create()` once at session creation. OpenCode applies them server-side; there is no per-request approval protocol — `permission.asked` / `permission.replied` events carry the final outcome.

---

## 7. Provider snapshot

`OpenCodeProvider.ts:173-309` — `checkOpenCodeProviderStatus`:

| State                                       | Trigger                  | `status`                                 |
| ------------------------------------------- | ------------------------ | ---------------------------------------- |
| `enabled === false`                         | settings                 | `"warning"`                              |
| External server: ECONNREFUSED / ENOTFOUND   | connection attempt       | `"error"` with "Couldn't reach server"   |
| External server: 401 / 403                  | connection attempt       | `"error"` with "rejected authentication" |
| Local: ENOENT                               | `which opencode`         | `"error"` with "not installed"           |
| Local: macOS quarantine                     | spawn error              | `"error"` with xattr instructions        |
| `loadOpenCodeInventory` returns 0 providers | `client.provider.list()` | `"warning"`                              |
| `loadOpenCodeInventory` returns ≥1 provider | `client.provider.list()` | `"ready"`                                |

`loadOpenCodeInventory` (`opencodeRuntime.ts:533-545`): Calls `client.provider.list()` and `client.app.agents()` in parallel; returns `{ providerList, agents }`. ≥1 provider in the list → ready.

---

## 8. Text generation — shared server pool

`OpenCodeTextGeneration.ts`:

- **Lazy creation:** Server spawned on first call; reused across subsequent calls.
- **30-second idle TTL** (`OPENCODE_TEXT_GENERATION_IDLE_TTL_MS = 30_000`): On release, if `activeRequests === 0`, fork a fiber that sleeps 30 s then closes the server. Cancelled if a new request arrives.
- **External server bypass:** If `settings.serverUrl` is set, uses it directly without spawning.

**Structured output path** (`OpenCodeTextGeneration.ts:238-258`):

```typescript
client.session.prompt({
  sessionID: session.data.id,
  model: parsedModel,
  format: { type: "json_schema", schema: toJsonSchemaObject(outputSchemaJson) },
  parts: [{ type: "text", text: prompt }, ...fileParts],
});
const structured = result.data?.info?.structured;
```

Supported operations: `generateCommitMessage`, `generatePrContent`, `generateBranchName`, `generateThreadTitle`.

The shared-server pool trades startup latency for reuse — spawning per-call would dominate short tasks like commit message generation.

---

## 9. Differences from Codex/Claude

| Aspect           | OpenCode                                | Codex / Claude                              |
| ---------------- | --------------------------------------- | ------------------------------------------- |
| Transport        | HTTP + SDK                              | stdio (Codex) / SDK in-proc (Claude)        |
| Session location | Remote, in OpenCode server              | Local                                       |
| Events           | Continuous SSE/poll subscription        | Per-message stdio frames or SDK iteration   |
| Model selection  | `provider/model` slug + agent + variant | Flat model slug + provider-specific options |
| Permissions      | One ruleset at session creation         | Inline per-request approvals                |
| Text generation  | Shared server pool with idle TTL        | One-shot spawn per call                     |

---

## 10. Tests

- `OpenCodeAdapter.test.ts:174-486`: fake server at `http://127.0.0.1:4301`, call counters for every side effect. Covers external-server reuse, graceful stop without owning the server, `stopAll` cleanup failures, `sendTurn` failure rollback, thread rollback, text delta dedup, and NDJSON event logging.
- `OpenCodeProvider.test.ts:71-138`: friendly error formatting, auth/network failure paths for external servers.
- `OpenCodeTextGeneration.test.ts:107-148`: server reuse, idle close, external-server bypass, schema validation failures.
