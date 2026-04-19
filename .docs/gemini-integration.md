# Gemini integration

> Gemini is the second ACP-based provider in T3 Code. It shares the
> `AcpAdapterBase` runtime with Cursor, but it differs in three important
> ways: ACP flavor negotiation (`--acp` vs `--experimental-acp`), raw
> `session/set_mode` / `session/set_model` requests, and persisted chat-file
> recovery for resume / rollback / cancel.

## 1. Files

- `apps/server/src/provider/Layers/GeminiAdapter.ts`
- `apps/server/src/provider/Layers/GeminiProvider.ts`
- `apps/server/src/provider/acp/GeminiAcpSupport.ts`
- `apps/server/src/provider/geminiSessionStore.ts`
- `apps/server/src/git/Layers/GeminiTextGeneration.ts`

## 2. ACP flavor negotiation

Gemini CLI does not have a single stable ACP flag across releases. Some
installs expose `--acp`; others only support `--experimental-acp`.

Shared support lives in `GeminiAcpSupport.ts`:

- `initializeGeminiCliHome()` writes locked-down `settings.json` into the
  per-thread home and seeds auth state from the user’s real `~/.gemini/`.
- `resolveGeminiAcpFlavor()` probes the live CLI by actually starting ACP
  sessions against both candidate flags.
- `resolveCachedGeminiFlavor()` memoizes the winning flavor per binary path.

Rules:

- Never guess `"acp"` on probe failure.
- Adapter startup maps probe/setup failures to `ProviderAdapterProcessError`.
- Provider snapshot enrichment treats probe/setup failure as non-fatal, but it
  must skip enrichment rather than silently defaulting to `--acp`.
- Every short-lived probe runtime must receive the resolved flavor, including
  nested per-model capability probes.

## 3. Optional Gemini RPCs

Gemini currently uses raw ACP requests for:

- `session/set_mode`
- `session/set_model`

These are optional capabilities on the CLI side. Shared tolerance lives in
`AcpAdapterSupport.ts` via `tolerateOptionalAcpCall()`, which returns a
structured result:

- `applied`
- `unsupported`
- `failed`

The Gemini adapter must only update `lastAppliedMode`, `lastAppliedModel`, and
`lastAppliedConfigKey` when the change was truly applied or was a true no-op.
Method-not-found and transient failures stay retriable so later turns do not
cache a stale session configuration.

## 4. Chat-file recovery

Gemini persists chat history under:

```text
$HOME/.gemini/tmp/<session-id>/chats/*.json
```

T3 uses that file for:

- resume seeding
- rollback truncation
- cancel cleanup

`geminiSessionStore.ts` stores per-turn metadata:

- `messageCountBefore`
- `messageCountAfter`
- `status` (`completed` or `incomplete`)

Important invariant:

- `GEMINI_ASSUMED_MESSAGES_PER_TURN = 2` is only a temporary fallback when the
  chat file is unreadable at turn-settle time.
- Before the next turn is recorded, and again before rollback/stop truncation,
  Gemini re-reads the authoritative chat file and repairs `messageCount`.
- That bounds drift to the newest unreadable turn instead of compounding the
  estimate across the whole thread.

## 5. Testing

Gemini should keep three test layers:

- Pure support tests in `GeminiAcpSupport.test.ts`
- Adapter tests with the dedicated Gemini ACP mock in
  `GeminiAdapter.test.ts` / `apps/server/scripts/gemini-acp-mock-agent.ts`
- Optional live CLI coverage in `GeminiAcpCliProbe.test.ts`

The dedicated Gemini mock exists because the generic ACP mock does not model
Gemini’s raw `session/set_mode` / `session/set_model` behavior or its persisted
chat-file side effects.

## 6. Developer probe

Use the standalone probe when debugging a real Gemini CLI install:

```bash
node apps/server/scripts/gemini-acp-probe.ts [cwd] [model] [prompt]
```

Useful env overrides:

- `T3_GEMINI_BIN`
- `T3_GEMINI_LAUNCH_ARGS`
- `T3_GEMINI_PROBE_MODE`
- `T3_GEMINI_PROBE_EFFORT`
- `T3_GEMINI_PROBE_CONTEXT`
- `T3_GEMINI_PROBE_THINKING`
- `T3_GEMINI_CANCEL_PROMPT`

Live test entrypoint:

```bash
T3_GEMINI_ACP_PROBE=1 bun run test src/provider/acp/GeminiAcpCliProbe.test.ts
```
