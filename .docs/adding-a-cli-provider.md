# Adding a new CLI provider

> Distilled from the four existing integrations at `9df3c640`. Gemini follows this shape.

---

## 1. Pick a `ProviderKind`

Add it to the `ProviderKind` union in `packages/contracts/src/model.ts`.

## 2. Define `ModelSelection`

Add an `XyzModelSelection` schema to `packages/contracts/src/model.ts` and include it in the
`ModelSelection` discriminated union.

## 3. Add the service tags

- `apps/server/src/provider/Services/XyzAdapter.ts` — `Context.Service` for
  `XyzAdapter extends ProviderAdapterShape<ProviderAdapterError>`.
- `apps/server/src/provider/Services/XyzProvider.ts` — tag + interface for snapshot/refresh.

## 4. Implement the adapter layer

`apps/server/src/provider/Layers/XyzAdapter.ts`. **Transport determines the approach:**

### Option A — ACP transport (CLI speaks JSON-RPC 2.0 over stdio via ACP)

Call `makeAcpAdapter<"xyz", XyzExtra>(config, liveOptions)` from
`apps/server/src/provider/acp/AcpAdapterBase.ts`. The base owns the session map, scopes, deferreds,
notification fiber, interrupt, layer finalizer, and all `ProviderAdapterShape` methods.

Create `apps/server/src/provider/acp/XyzAcpSupport.ts` with:

1. `buildXyzAcpSpawnInput(settings, cwd)` → `AcpSpawnInput` (command, args, env overrides, cwd).
2. `makeXyzAcpRuntime(input)` → calls `AcpSessionRuntime.layer({ spawn, authMethodId, clientCapabilities })`.

**Required `config` fields:**

| Field                              | Contract                                                                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `provider`                         | `"xyz"`                                                                                                                    |
| `capabilities`                     | `{ sessionModelSwitch: "in-session" \| "unsupported" }`                                                                    |
| `buildSession(input)`              | Returns `{ acp: AcpSessionRuntimeShape, extra: XyzExtra }`. Call `makeXyzAcpRuntime(...)` here. Runs inside session scope. |
| `parseResumeCursor(raw)`           | Returns `{ sessionId }` or `undefined`. Validate schema version.                                                           |
| `buildResumeCursor(sessionId)`     | Returns the cursor object to persist.                                                                                      |
| `applySessionConfiguration(input)` | Apply mode + model via ACP RPCs. Called at session start and before each turn.                                             |

**Optional hooks** (implement what your provider needs):

| Hook                              | Purpose                                                                                                   |
| --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `validateStartInput`              | Provider-specific `startSession` validation                                                               |
| `registerExtensionHandlers`       | Register provider-specific ACP extension methods via `acp.handleExtRequest` / `acp.handleExtNotification` |
| `resolveSessionModel`             | Extract display model string from `ModelSelection`                                                        |
| `afterSessionCreated`             | Post-start hook; return `{ seedTurns }` to pre-populate `ctx.turns` on resume                             |
| `onContentDelta`                  | Called on every `ContentDelta` event — parse embedded structured data from text                           |
| `beforeTurn` / `afterTurnSettled` | Turn lifecycle hooks — use for metadata tracking                                                          |
| `beforeStop` / `afterRollback`    | Cleanup hooks — use for file/state truncation                                                             |
| `selectAutoApprovedPermission`    | Override the default full-access auto-approve policy                                                      |

**Common ACP spawn patterns:**

- If the CLI reads credentials from `$HOME`, use a per-thread isolated home (`HOME=<threadDir>` env override) and seed credentials at session start.
- Neutralize keyring discovery env vars (e.g., `DBUS_SESSION_BUS_ADDRESS=""`) to prevent desktop dialogs during headless probing.
- If the ACP flag varies across CLI versions, implement a flavor probe and cache it per binary path.

### Option B — stdio JSON-RPC (like Codex)

- `Effect.acquireRelease` the manager in the layer scope.
- Own the session map, scopes, deferreds for approvals/user inputs, `stopped` flag.
- Map provider-native events → `ProviderRuntimeEvent`. Preserve `raw`.
- `Effect.addFinalizer` for layer-scope cleanup of all sessions.

### Option C — SDK in-process (like Claude)

- Acquire/release the SDK runtime in the layer scope.
- Use `Effect.acquireRelease` + `Effect.addFinalizer` for cleanup.
- Fork a streaming fiber per session. `Queue.shutdown` stops the stream.

### Option D — HTTP server (like OpenCode)

- Spawn or connect to the local server on first session.
- Subscribe to the server's event stream, filter by session ID.
- Tear down the local server (if owned) in the finalizer.

## 5. Implement the provider layer

`apps/server/src/provider/Layers/XyzProvider.ts`:

1. Implement `checkXyzProviderStatus()` using `buildServerProvider(...)` from `providerSnapshot.ts`.
   - Check `settings.enabled` first — return `"warning"` immediately.
   - Use `spawnAndCollect` + `DEFAULT_TIMEOUT_MS` for `--version` probes.
   - Use `isCommandMissingCause` for ENOENT detection.
2. If the provider exposes per-model capabilities via ACP config options, add an `enrichSnapshot`
   callback to `makeManagedServerProvider`. It runs after the initial probe, calls a short-lived ACP
   probe session, and calls `publishSnapshot(enriched)` when discovery finishes. Non-fatal —
   failures are logged and the initial snapshot stays active.
3. Use `EMPTY_CAPABILITIES` for models whose capabilities can't be probed.

## 6. Register in both registries AND `server.ts`

- Add to `ProviderRegistry` (snapshot/refresh/streamChanges).
- Add to `ProviderAdapterRegistry` (adapter dispatch for `startSession`, `sendTurn`, etc.).
- Add `makeXyzAdapterLive(...)` to `ProviderLayerLive` in `apps/server/src/server.ts` — this is
  where the layer is actually wired into the Effect runtime. Both registries are service tags; they
  only work if the underlying layer is provided here.

## 7. Add a text-generation layer

`apps/server/src/git/Layers/XyzTextGeneration.ts`. Wire it into `RoutingTextGeneration.ts:54-69`
(the route dispatch table). Call sites never change — they call
`TextGeneration.generateCommitMessage(input)` and the routing layer picks the implementation.

## 8. Tests

- Pure-function tests for normalization helpers.
- Adapter projection tests with a fake runtime (inject raw events; assert canonical
  `ProviderRuntimeEvent`).
- An env-gated live integration test if a real CLI is available.

## 9. Docs

Add `xyz-integration.md` next to the existing per-provider docs. Link it from
`provider-architecture.md`. Update AGENTS.md Package Roles only if the new provider has packaging
implications.

## 10. For pre-release CLIs

Add a probe script under `apps/server/scripts/` (Cursor-style) and an opt-in integration test. The
script should exercise the full handshake, model selection, a single prompt + cancel, and surface
config-option mismatches as actionable output. See `cursor-integration.md` §21 for the pattern.

---

## ACP synthetic-cancel note

The `AcpAdapterBase` handles `interruptTurn` with a two-stage mechanism:

1. Sends `acp.cancel()` under `acpCancelTimeout` (default 2 s).
2. Forks a grace timer (`syntheticCancelGrace`, default 3 s) that fires a `cancelSignal` Deferred.
3. `sendTurn` races the live prompt against `cancelSignal` via `Effect.raceFirst`.

This ensures the UI unblocks even when the agent process is slow to honor cancel. Providers do not need to implement this — it is built into the base.
