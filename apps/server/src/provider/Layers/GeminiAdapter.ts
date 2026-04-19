/**
 * GeminiAdapterLive — Gemini CLI interactive provider over ACP.
 *
 * Built on top of `AcpAdapterBase`. Only Gemini-specific machinery
 * lives here: per-thread home setup, auth seeding, ACP-flavor probe
 * (cached per binary path), session-metadata persistence, chat-file
 * truncation, native `session/set_mode` + `session/set_model`
 * routing, and `<proposed_plan>` parsing out of ContentDelta.
 *
 * @module GeminiAdapterLive
 */
import * as nodePath from "node:path";

import {
  type GeminiModelOptions,
  type GeminiSettings,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Effect, FileSystem, Layer, Ref, Scope, SynchronizedRef } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpErrors from "effect-acp/errors";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderAdapterProcessError, ProviderAdapterValidationError } from "../Errors.ts";
import { extractProposedPlanMarkdown } from "../proposedPlan.ts";
import { isAcpMethodNotFound } from "../acp/AcpAdapterSupport.ts";
import {
  findModeByAliases,
  isPlanMode as baseIsPlanMode,
  makeAcpAdapter,
  type AcpAdapterLiveOptions,
} from "../acp/AcpAdapterBase.ts";
import { type AcpSessionMode, type AcpSessionModeState } from "../acp/AcpRuntimeModel.ts";
import { type AcpSessionRuntimeShape } from "../acp/AcpSessionRuntime.ts";
import {
  applyGeminiAcpConfigOptions,
  type GeminiAcpFlavor,
  makeGeminiAcpRuntime,
  resolveCachedGeminiFlavor,
  resolveGeminiAcpFlavor,
  resolveGeminiAuthMethod,
  seedGeminiCliHomeAuth,
  validateGeminiLaunchArgs,
  writeGeminiCliSettings,
} from "../acp/GeminiAcpSupport.ts";
import { GeminiAdapter, type GeminiAdapterShape } from "../Services/GeminiAdapter.ts";
import {
  appendGeminiTurn,
  countPersistedGeminiMessages,
  GEMINI_SESSION_SCHEMA_VERSION,
  makeGeminiTurnRecord,
  makeInitialGeminiMetadata,
  parseGeminiResumeCursor,
  readGeminiSessionMetadata,
  resolveGeminiChatFile,
  resolveGeminiThreadPaths,
  truncateGeminiTurns,
  truncatePersistedGeminiMessages,
  updateLastGeminiTurnStatus,
  withGeminiChatFileRelativePath,
  writeGeminiSessionMetadata,
  type GeminiSessionMetadata,
} from "../geminiSessionStore.ts";

export type { AcpAdapterLiveOptions as GeminiAdapterLiveOptions };

const PROVIDER = "gemini" as const;

const GEMINI_PLAN_MODE_ALIASES = ["plan", "architect"];
const GEMINI_DEFAULT_MODE_ALIASES = ["default", "code", "chat", "implement"];
const GEMINI_AUTO_EDIT_MODE_ALIASES = ["auto_edit", "auto-edit", "autoedit", "accept-edits"];
const GEMINI_YOLO_MODE_ALIASES = ["yolo", "full-access", "full_access"];

interface GeminiExtra {
  readonly metadataPath: string;
  readonly metadataRef: Ref.Ref<GeminiSessionMetadata>;
  readonly home: string;
  messageCount: number;
  /**
   * Last-applied per-turn ACP configuration. We compare against this
   * before issuing `session/set_mode`, `session/set_model`, and any
   * downstream `setConfigOption` calls so we don't pay 3+ RPC roundtrips
   * on every prompt for state that hasn't changed.
   */
  lastAppliedMode: string | undefined;
  lastAppliedModel: string | undefined;
  lastAppliedConfigKey: string | undefined;
}

function geminiModelOptionsKey(options: GeminiModelOptions | null | undefined): string {
  if (!options) return "";
  return JSON.stringify({
    thinking: options.thinking ?? null,
    effort: options.effort ?? null,
    contextWindow: options.contextWindow ?? null,
  });
}

/**
 * Map T3's runtime-mode + interaction-mode to a Gemini ACP mode id.
 *   plan           → plan
 *   approval-req.  → default  (T3 intercepts tool approvals)
 *   auto-accept    → auto_edit
 *   full-access    → yolo
 */
function resolveRequestedGeminiModeId(input: {
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly modeState: AcpSessionModeState | undefined;
}): string | undefined {
  const modeState = input.modeState;
  if (!modeState) return undefined;

  if (input.interactionMode === "plan") {
    return findModeByAliases(modeState.availableModes, GEMINI_PLAN_MODE_ALIASES)?.id;
  }
  const nonPlanFallback = (mode: AcpSessionMode) => !baseIsPlanMode(mode, GEMINI_PLAN_MODE_ALIASES);

  switch (input.runtimeMode) {
    case "approval-required":
      return (
        findModeByAliases(modeState.availableModes, GEMINI_DEFAULT_MODE_ALIASES)?.id ??
        modeState.availableModes.find(nonPlanFallback)?.id ??
        modeState.currentModeId
      );
    case "auto-accept-edits":
      return (
        findModeByAliases(modeState.availableModes, GEMINI_AUTO_EDIT_MODE_ALIASES)?.id ??
        findModeByAliases(modeState.availableModes, GEMINI_DEFAULT_MODE_ALIASES)?.id ??
        modeState.availableModes.find(nonPlanFallback)?.id ??
        modeState.currentModeId
      );
    case "full-access":
      return (
        findModeByAliases(modeState.availableModes, GEMINI_YOLO_MODE_ALIASES)?.id ??
        findModeByAliases(modeState.availableModes, GEMINI_AUTO_EDIT_MODE_ALIASES)?.id ??
        findModeByAliases(modeState.availableModes, GEMINI_DEFAULT_MODE_ALIASES)?.id ??
        modeState.availableModes.find(nonPlanFallback)?.id ??
        modeState.currentModeId
      );
    default:
      return (
        findModeByAliases(modeState.availableModes, GEMINI_DEFAULT_MODE_ALIASES)?.id ??
        modeState.availableModes.find(nonPlanFallback)?.id ??
        modeState.currentModeId
      );
  }
}

/**
 * Swallow optional ACP-request failures so Gemini session start doesn't
 * die on methods the agent hasn't implemented. -32601 ("Method not
 * found") is logged at debug; any other AcpError at warn. Both resolve
 * to void.
 */
function tolerateOptionalAcpCall(label: string) {
  return (effect: Effect.Effect<unknown, EffectAcpErrors.AcpError>) =>
    effect.pipe(
      Effect.asVoid,
      Effect.catchIf(isAcpMethodNotFound, () =>
        Effect.logDebug(`Gemini ACP ${label}: method not implemented, ignoring`).pipe(
          Effect.asVoid,
        ),
      ),
      Effect.catch((error) =>
        Effect.logWarning(`Gemini ACP ${label} failed, ignoring`, {
          error: error.message,
        }).pipe(Effect.asVoid),
      ),
    );
}

/**
 * Use raw `session/set_mode`: the shared `AcpSessionRuntime.setMode`
 * helper routes through `setConfigOption("mode", …)`, which Gemini
 * rejects as -32601.
 */
function applyRequestedSessionMode(input: {
  readonly runtime: AcpSessionRuntimeShape;
  readonly sessionId: string;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly lastAppliedMode: string | undefined;
}): Effect.Effect<string | undefined, never> {
  return Effect.gen(function* () {
    const requestedModeId = resolveRequestedGeminiModeId({
      interactionMode: input.interactionMode,
      runtimeMode: input.runtimeMode,
      modeState: yield* input.runtime.getModeState,
    });
    if (!requestedModeId) return undefined;
    if (input.lastAppliedMode === requestedModeId) return requestedModeId;
    yield* input.runtime
      .request("session/set_mode", {
        sessionId: input.sessionId,
        modeId: requestedModeId,
      })
      .pipe(Effect.asVoid, tolerateOptionalAcpCall("session/set_mode"));
    return requestedModeId;
  });
}

/**
 * Both calls are tolerated so session start never fails when the agent
 * implements only one of `session/set_model` or `setConfigOption`.
 */
function applyRequestedSessionModelSelection(input: {
  readonly runtime: AcpSessionRuntimeShape;
  readonly sessionId: string;
  readonly model: string | undefined | null;
  readonly modelOptions: GeminiModelOptions | null | undefined;
  readonly lastAppliedModel: string | undefined;
  readonly lastAppliedConfigKey: string | undefined;
}): Effect.Effect<
  { readonly appliedModel: string | undefined; readonly appliedConfigKey: string },
  never
> {
  return Effect.gen(function* () {
    const trimmed = input.model?.trim();
    const resolvedModel = trimmed && trimmed.length > 0 && trimmed !== "auto" ? trimmed : undefined;
    if (resolvedModel && input.lastAppliedModel !== resolvedModel) {
      yield* input.runtime
        .request("session/set_model", {
          sessionId: input.sessionId,
          modelId: resolvedModel,
        })
        .pipe(Effect.asVoid, tolerateOptionalAcpCall("session/set_model"));
    }
    const configKey = geminiModelOptionsKey(input.modelOptions);
    if (input.lastAppliedConfigKey !== configKey) {
      yield* applyGeminiAcpConfigOptions({
        runtime: input.runtime,
        modelOptions: input.modelOptions,
        mapError: ({ cause }) => cause,
      }).pipe(
        Effect.catch(() =>
          Effect.logDebug("Gemini ACP config-option update failed, ignoring").pipe(Effect.asVoid),
        ),
      );
    }
    return { appliedModel: resolvedModel ?? input.lastAppliedModel, appliedConfigKey: configKey };
  });
}

function makeGeminiAdapterEffect(options?: AcpAdapterLiveOptions) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const serverConfig = yield* Effect.service(ServerConfig);
    const serverSettingsService = yield* ServerSettingsService;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const flavorCacheRef = yield* SynchronizedRef.make(new Map<string, GeminiAcpFlavor>());

    /**
     * Per-thread "last-applied configuration" cache. Keyed by threadId so
     * sequential turns on the same thread don't re-issue identical
     * `session/set_mode`, `session/set_model`, or `setConfigOption` RPCs.
     * Cleared in beforeStop. The hook surface for applySessionConfiguration
     * doesn't carry ctx.extra, so we use a map keyed by threadId instead
     * of widening the hook signature.
     */
    const appliedConfigByThread = new Map<
      ThreadId,
      {
        mode: string | undefined;
        model: string | undefined;
        configKey: string | undefined;
      }
    >();

    /**
     * Resolve the Gemini ACP flavor (`--acp` vs `--experimental-acp`) and
     * cache the result per binary path. First session pays the probe
     * cost (~<8s); subsequent sessions read from cache.
     */
    const resolveFlavorCached = (input: {
      geminiSettings: GeminiSettings;
      cwd: string;
      threadId: ThreadId;
    }): Effect.Effect<GeminiAcpFlavor, ProviderAdapterProcessError, Scope.Scope> =>
      resolveCachedGeminiFlavor({
        cacheRef: flavorCacheRef,
        binaryPath: input.geminiSettings.binaryPath,
        probe: Effect.gen(function* () {
          const probeHome = yield* fileSystem
            .makeTempDirectoryScoped({ prefix: "t3-gemini-acp-probe-" })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterProcessError({
                    provider: PROVIDER,
                    threadId: input.threadId,
                    detail: cause.message,
                    cause,
                  }),
              ),
            );
          yield* writeGeminiCliSettings({ home: probeHome }).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.orElseSucceed(() => probeHome),
          );
          yield* seedGeminiCliHomeAuth({ home: probeHome }).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.orElseSucceed(() => [] as ReadonlyArray<string>),
          );
          return yield* resolveGeminiAcpFlavor({
            childProcessSpawner,
            geminiSettings: input.geminiSettings,
            cwd: input.cwd,
            home: probeHome,
            clientInfo: { name: "t3-code-gemini-acp-probe", version: "0.0.0" },
          }).pipe(
            Effect.map((result): GeminiAcpFlavor => result.flavor),
            Effect.catchCause(() => Effect.succeed<GeminiAcpFlavor>("acp")),
          );
        }),
      });

    const persistMetadata = (extra: GeminiExtra) =>
      Ref.get(extra.metadataRef).pipe(
        Effect.flatMap((metadata) =>
          writeGeminiSessionMetadata({ metadataPath: extra.metadataPath, metadata }).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
          ),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to persist gemini session metadata", {
            cause,
          }).pipe(Effect.asVoid),
        ),
      );

    const recordChatFileRelativePath = (extra: GeminiExtra, relativePath: string) =>
      Effect.gen(function* () {
        const changed = yield* Ref.modify(extra.metadataRef, (metadata) => {
          const next = withGeminiChatFileRelativePath(metadata, relativePath);
          return [next !== metadata, next] as const;
        });
        if (changed) {
          yield* persistMetadata(extra);
        }
      });

    /**
     * If the metadata's last turn is `incomplete`, locate the persisted chat
     * file and truncate it back to `messageCountBefore`. Returns the resolved
     * count + relativePath so callers can update their in-memory state. The
     * truncate is best-effort — failures are swallowed and the assumed count
     * is returned.
     */
    const resolveAndTruncateIfIncomplete = (input: {
      readonly home: string;
      readonly sessionId: string;
      readonly metadata: GeminiSessionMetadata;
    }): Effect.Effect<
      | {
          readonly nextMessageCount: number;
          readonly chatFileRelativePath: string | undefined;
        }
      | undefined,
      never
    > =>
      Effect.gen(function* () {
        const { metadata } = input;
        if (metadata.turns.length === 0) return undefined;
        const lastTurn = metadata.turns[metadata.turns.length - 1]!;
        if (lastTurn.status !== "incomplete") return undefined;
        const chatFile = yield* resolveGeminiChatFile({
          home: input.home,
          sessionId: input.sessionId,
          ...(metadata.chatFileRelativePath
            ? { chatFileRelativePath: metadata.chatFileRelativePath }
            : {}),
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.orElseSucceed(() => undefined),
        );
        if (!chatFile) {
          return {
            nextMessageCount: lastTurn.messageCountBefore,
            chatFileRelativePath: metadata.chatFileRelativePath,
          };
        }
        yield* truncatePersistedGeminiMessages({
          chatFilePath: chatFile.absolutePath,
          messageCount: lastTurn.messageCountBefore,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.orElseSucceed(() => lastTurn.messageCountBefore),
        );
        return {
          nextMessageCount: lastTurn.messageCountBefore,
          chatFileRelativePath: chatFile.relativePath,
        };
      });

    const truncateChatIfIncomplete = (extra: GeminiExtra, acpSessionId: string) =>
      Effect.gen(function* () {
        const metadata = yield* Ref.get(extra.metadataRef);
        const result = yield* resolveAndTruncateIfIncomplete({
          home: extra.home,
          sessionId: acpSessionId,
          metadata,
        });
        if (!result) return;
        extra.messageCount = result.nextMessageCount;
        if (result.chatFileRelativePath) {
          yield* recordChatFileRelativePath(extra, result.chatFileRelativePath);
        }
      });

    const base = yield* makeAcpAdapter<"gemini", GeminiExtra>(
      {
        provider: PROVIDER,
        capabilities: { sessionModelSwitch: "in-session" },

        parseResumeCursor: (raw) => parseGeminiResumeCursor(raw),
        buildResumeCursor: (sessionId) => ({
          schemaVersion: GEMINI_SESSION_SCHEMA_VERSION,
          sessionId,
        }),

        resolveSessionModel: (modelSelection: ModelSelection | undefined) => {
          if (modelSelection?.provider !== "gemini") return undefined;
          return modelSelection.model;
        },

        validateStartInput: () =>
          Effect.gen(function* () {
            const settings = yield* serverSettingsService.getSettings.pipe(
              Effect.map((s) => s.providers.gemini),
              Effect.mapError(
                (error) =>
                  new ProviderAdapterValidationError({
                    provider: PROVIDER,
                    operation: "startSession",
                    issue: error.message,
                  }),
              ),
            );
            const launchArgsError = validateGeminiLaunchArgs(settings.launchArgs);
            if (launchArgsError) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "startSession",
                issue: launchArgsError.message,
              });
            }
          }),

        buildSession: ({ startInput, cwd, resumeSessionId, nativeLoggers }) =>
          Effect.gen(function* () {
            const geminiSettings = yield* serverSettingsService.getSettings.pipe(
              Effect.map((s) => s.providers.gemini),
              Effect.mapError(
                (error) =>
                  new ProviderAdapterProcessError({
                    provider: PROVIDER,
                    threadId: startInput.threadId,
                    detail: error.message,
                    cause: error,
                  }),
              ),
            );
            const resolvedCwd = nodePath.resolve(cwd);
            const threadPaths = resolveGeminiThreadPaths({
              providerStateDir: serverConfig.providerStateDir,
              threadId: startInput.threadId,
            });
            yield* fileSystem.makeDirectory(threadPaths.threadDir, { recursive: true }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterProcessError({
                    provider: PROVIDER,
                    threadId: startInput.threadId,
                    detail: cause.message,
                    cause,
                  }),
              ),
            );
            yield* writeGeminiCliSettings({ home: threadPaths.home }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterProcessError({
                    provider: PROVIDER,
                    threadId: startInput.threadId,
                    detail: cause instanceof Error ? cause.message : String(cause),
                    cause,
                  }),
              ),
            );
            // One-shot copy: external `gemini auth login` during a live
            // session won't propagate until the next startSession.
            // See seedGeminiCliHomeAuth's JSDoc for the full trade-off.
            yield* seedGeminiCliHomeAuth({ home: threadPaths.home }).pipe(
              Effect.orElseSucceed(() => [] as ReadonlyArray<string>),
            );

            const persistedMetadataRaw = yield* readGeminiSessionMetadata(threadPaths.metadataPath);

            // If the persisted last turn is incomplete, roll the chat
            // file back before the CLI reads it on resume. Otherwise the
            // resumed session would replay a half-finished turn. Reuse the
            // helper so this logic stays in lockstep with the in-session
            // truncate path.
            const persistedMetadata: GeminiSessionMetadata | undefined =
              persistedMetadataRaw !== undefined
                ? yield* Effect.gen(function* () {
                    const result = yield* resolveAndTruncateIfIncomplete({
                      home: threadPaths.home,
                      sessionId: persistedMetadataRaw.sessionId,
                      metadata: persistedMetadataRaw,
                    });
                    if (result?.chatFileRelativePath) {
                      return withGeminiChatFileRelativePath(
                        persistedMetadataRaw,
                        result.chatFileRelativePath,
                      );
                    }
                    return persistedMetadataRaw;
                  })
                : undefined;

            const resolvedFlavor = yield* resolveFlavorCached({
              geminiSettings,
              cwd: resolvedCwd,
              threadId: startInput.threadId,
            });

            const acp = yield* makeGeminiAcpRuntime({
              geminiSettings,
              childProcessSpawner,
              cwd: resolvedCwd,
              home: threadPaths.home,
              flavor: resolvedFlavor,
              ...(resumeSessionId ? { resumeSessionId } : {}),
              clientInfo: { name: "t3-code", version: "0.0.0" },
              authMethodId: resolveGeminiAuthMethod() ?? "oauth-personal",
              ...nativeLoggers,
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterProcessError({
                    provider: PROVIDER,
                    threadId: startInput.threadId,
                    detail: cause.message,
                    cause,
                  }),
              ),
            );

            // Pre-populate metadataRef with persistedMetadata if its
            // sessionId will match what ACP returns (resume path), else
            // a fresh metadata with a placeholder sessionId that
            // afterSessionCreated will reconcile against the real one.
            const initialMetadata: GeminiSessionMetadata =
              persistedMetadata !== undefined &&
              persistedMetadata.sessionId === (resumeSessionId ?? persistedMetadata.sessionId)
                ? persistedMetadata
                : makeInitialGeminiMetadata({
                    sessionId: resumeSessionId ?? "pending",
                  });
            const metadataRef = yield* Ref.make<GeminiSessionMetadata>(initialMetadata);
            const messageCount = initialMetadata.turns.reduce(
              (max, turn) => Math.max(max, turn.messageCountAfter),
              0,
            );
            return {
              acp,
              extra: {
                metadataPath: threadPaths.metadataPath,
                metadataRef,
                home: threadPaths.home,
                messageCount,
                lastAppliedMode: undefined,
                lastAppliedModel: undefined,
                lastAppliedConfigKey: undefined,
              } satisfies GeminiExtra,
            };
          }),

        applySessionConfiguration: ({
          acp,
          sessionId,
          runtimeMode,
          interactionMode,
          modelSelection,
          threadId,
        }) =>
          Effect.gen(function* () {
            const cached = appliedConfigByThread.get(threadId) ?? {
              mode: undefined,
              model: undefined,
              configKey: undefined,
            };
            const appliedMode = yield* applyRequestedSessionMode({
              runtime: acp,
              sessionId,
              runtimeMode,
              interactionMode,
              lastAppliedMode: cached.mode,
            });
            const geminiModelSelection =
              modelSelection?.provider === "gemini" ? modelSelection : undefined;
            const appliedModel = yield* applyRequestedSessionModelSelection({
              runtime: acp,
              sessionId,
              model: geminiModelSelection?.model,
              modelOptions: geminiModelSelection?.options,
              lastAppliedModel: cached.model,
              lastAppliedConfigKey: cached.configKey,
            });
            appliedConfigByThread.set(threadId, {
              mode: appliedMode ?? cached.mode,
              model: appliedModel.appliedModel,
              configKey: appliedModel.appliedConfigKey,
            });
          }),

        afterSessionCreated: (ctx) =>
          Effect.gen(function* () {
            const current = yield* Ref.get(ctx.extra.metadataRef);
            if (current.sessionId !== ctx.acpSessionId) {
              yield* Ref.set(
                ctx.extra.metadataRef,
                makeInitialGeminiMetadata({ sessionId: ctx.acpSessionId }),
              );
              ctx.extra.messageCount = 0;
              yield* persistMetadata(ctx.extra);
              return;
            }
            yield* persistMetadata(ctx.extra);
            // Resume hit: seed ctx.turns from persisted metadata so
            // readThread + rollbackThread don't lie about an empty thread
            // before any new in-process turn happens. Items stay empty
            // because we don't persist message bodies — readThread is
            // only used internally for in-process replay today.
            if (current.turns.length === 0) return;
            return {
              seedTurns: current.turns.map((turn) => ({
                id: TurnId.make(turn.turnId),
                items: [] as Array<unknown>,
              })),
            };
          }),

        beforeTurn: ({ ctx, turnId }) =>
          Effect.gen(function* () {
            const messageCountBefore = ctx.extra.messageCount;
            yield* Ref.update(ctx.extra.metadataRef, (metadata) =>
              appendGeminiTurn(
                metadata,
                makeGeminiTurnRecord({
                  turnId,
                  messageCountBefore,
                  messageCountAfter: messageCountBefore,
                  status: "incomplete",
                }),
              ),
            );
            yield* persistMetadata(ctx.extra);
          }),

        afterTurnSettled: ({ ctx, stopReason }) =>
          Effect.gen(function* () {
            const messageCountBefore = ctx.extra.messageCount;
            const metadataAfterPrompt = yield* Ref.get(ctx.extra.metadataRef);
            const chatFileAfterPrompt = yield* resolveGeminiChatFile({
              home: ctx.extra.home,
              sessionId: ctx.acpSessionId,
              ...(metadataAfterPrompt.chatFileRelativePath
                ? { chatFileRelativePath: metadataAfterPrompt.chatFileRelativePath }
                : {}),
            }).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.orElseSucceed(() => undefined),
            );
            if (chatFileAfterPrompt) {
              yield* Ref.update(ctx.extra.metadataRef, (metadata) =>
                withGeminiChatFileRelativePath(metadata, chatFileAfterPrompt.relativePath),
              );
            }
            const countedMessages = chatFileAfterPrompt
              ? yield* countPersistedGeminiMessages(chatFileAfterPrompt.absolutePath).pipe(
                  Effect.provideService(FileSystem.FileSystem, fileSystem),
                  Effect.orElseSucceed(() => messageCountBefore + 2),
                )
              : messageCountBefore + 2;

            if (stopReason === "cancelled") {
              if (chatFileAfterPrompt && countedMessages > messageCountBefore) {
                yield* truncatePersistedGeminiMessages({
                  chatFilePath: chatFileAfterPrompt.absolutePath,
                  messageCount: messageCountBefore,
                }).pipe(
                  Effect.provideService(FileSystem.FileSystem, fileSystem),
                  Effect.orElseSucceed(() => messageCountBefore),
                );
              }
              ctx.extra.messageCount = messageCountBefore;
              yield* Ref.update(ctx.extra.metadataRef, (metadata) =>
                updateLastGeminiTurnStatus(metadata, "incomplete", {
                  messageCountAfter: messageCountBefore,
                }),
              );
              yield* persistMetadata(ctx.extra);
              return;
            }

            ctx.extra.messageCount =
              countedMessages >= messageCountBefore ? countedMessages : messageCountBefore + 2;
            yield* Ref.update(ctx.extra.metadataRef, (metadata) =>
              updateLastGeminiTurnStatus(metadata, "completed", {
                messageCountAfter: ctx.extra.messageCount,
              }),
            );
            yield* persistMetadata(ctx.extra);
          }),

        onContentDelta: ({ ctx, text, rawPayload, offerRuntimeEvent, makeEventStamp }) =>
          Effect.gen(function* () {
            const planMarkdown = extractProposedPlanMarkdown(text);
            if (!planMarkdown) return;
            yield* offerRuntimeEvent({
              type: "turn.proposed.completed",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: ctx.threadId,
              turnId: ctx.activeTurnId,
              payload: { planMarkdown },
              raw: {
                source: "acp.jsonrpc",
                method: "session/update",
                payload: rawPayload,
              },
            });
          }),

        beforeStop: (ctx) =>
          Effect.gen(function* () {
            yield* truncateChatIfIncomplete(ctx.extra, ctx.acpSessionId);
            appliedConfigByThread.delete(ctx.threadId);
          }),

        afterRollback: ({ ctx, numTurns }) =>
          Effect.gen(function* () {
            const truncated = yield* Ref.modify(ctx.extra.metadataRef, (metadata) => {
              const { next, truncated } = truncateGeminiTurns(metadata, numTurns);
              return [truncated, next] as const;
            });
            if (truncated.length > 0) {
              const firstTruncated = truncated[0]!;
              ctx.extra.messageCount = firstTruncated.messageCountBefore;
            }
            const metadataAfter = yield* Ref.get(ctx.extra.metadataRef);
            const chatFile = yield* resolveGeminiChatFile({
              home: ctx.extra.home,
              sessionId: metadataAfter.sessionId,
              ...(metadataAfter.chatFileRelativePath
                ? { chatFileRelativePath: metadataAfter.chatFileRelativePath }
                : {}),
            }).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.orElseSucceed(() => undefined),
            );
            if (chatFile) {
              yield* Ref.update(ctx.extra.metadataRef, (metadata) =>
                withGeminiChatFileRelativePath(metadata, chatFile.relativePath),
              );
              yield* truncatePersistedGeminiMessages({
                chatFilePath: chatFile.absolutePath,
                messageCount: ctx.extra.messageCount,
              }).pipe(
                Effect.provideService(FileSystem.FileSystem, fileSystem),
                Effect.orElseSucceed(() => ctx.extra.messageCount),
              );
            }
            yield* persistMetadata(ctx.extra);
          }),
      },
      options,
    );

    return base as unknown as GeminiAdapterShape;
  });
}

export const GeminiAdapterLive = Layer.effect(GeminiAdapter, makeGeminiAdapterEffect());

export function makeGeminiAdapterLive(opts?: AcpAdapterLiveOptions) {
  return Layer.effect(GeminiAdapter, makeGeminiAdapterEffect(opts));
}
