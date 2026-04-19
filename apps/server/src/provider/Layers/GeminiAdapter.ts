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

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderAdapterProcessError, ProviderAdapterValidationError } from "../Errors.ts";
import { extractProposedPlanMarkdown } from "../proposedPlan.ts";
import { tolerateOptionalAcpCall } from "../acp/AcpAdapterSupport.ts";
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
  initializeGeminiCliHome,
  makeGeminiAcpRuntime,
  resolveCachedGeminiFlavor,
  resolveGeminiAcpFlavor,
  resolveGeminiAuthMethod,
  validateGeminiLaunchArgs,
} from "../acp/GeminiAcpSupport.ts";
import { GeminiAdapter, type GeminiAdapterShape } from "../Services/GeminiAdapter.ts";
import {
  appendGeminiTurn,
  canReusePersistedGeminiMetadata,
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

/**
 * Fallback estimate for how many messages a single turn writes to the
 * chat file (one user prompt + one assistant reply). Used only when the
 * persisted chat file can't be read at turn-settle time; otherwise
 * `countPersistedGeminiMessages` is authoritative. Turns with multiple
 * tool calls write more than 2. We intentionally keep the fallback
 * coarse and repair it on the next authoritative pre-turn / rollback /
 * stop read so only the newest unreadable turn can drift.
 */
const GEMINI_ASSUMED_MESSAGES_PER_TURN = 2;

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
    const result = yield* tolerateOptionalAcpCall({
      label: "session/set_mode",
      effect: input.runtime
        .request("session/set_mode", {
          sessionId: input.sessionId,
          modeId: requestedModeId,
        })
        .pipe(Effect.asVoid),
    });
    return result._tag === "applied" ? requestedModeId : undefined;
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
  {
    readonly appliedModel: string | undefined;
    readonly shouldCacheModel: boolean;
    readonly appliedConfigKey: string;
    readonly shouldCacheConfigKey: boolean;
  },
  never
> {
  return Effect.gen(function* () {
    const trimmed = input.model?.trim();
    const resolvedModel = trimmed && trimmed.length > 0 && trimmed !== "auto" ? trimmed : undefined;
    const configKey = geminiModelOptionsKey(input.modelOptions);
    let modelResult: { readonly shouldCache: boolean; readonly value: string | undefined };
    if (resolvedModel === undefined || input.lastAppliedModel === resolvedModel) {
      modelResult = { shouldCache: resolvedModel !== undefined, value: resolvedModel };
    } else {
      const result = yield* tolerateOptionalAcpCall({
        label: "session/set_model",
        effect: input.runtime
          .request("session/set_model", {
            sessionId: input.sessionId,
            modelId: resolvedModel,
          })
          .pipe(Effect.asVoid),
      });
      modelResult = {
        shouldCache: result._tag === "applied",
        value: result._tag === "applied" ? resolvedModel : undefined,
      };
    }

    let configResult: { readonly shouldCache: boolean; readonly value: string };
    if (input.lastAppliedConfigKey === configKey) {
      configResult = { shouldCache: true, value: configKey };
    } else {
      const result = yield* tolerateOptionalAcpCall({
        label: "session/set_config_option",
        effect: applyGeminiAcpConfigOptions({
          runtime: input.runtime,
          modelOptions: input.modelOptions,
        }),
      });
      configResult = {
        shouldCache: result._tag === "applied",
        value: configKey,
      };
    }

    return {
      appliedModel: modelResult.value,
      shouldCacheModel: modelResult.shouldCache,
      appliedConfigKey: configResult.value,
      shouldCacheConfigKey: configResult.shouldCache,
    };
  });
}

function makeGeminiAdapterEffect(options?: AcpAdapterLiveOptions) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const serverConfig = yield* Effect.service(ServerConfig);
    const serverSettingsService = yield* ServerSettingsService;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const flavorCacheRef = yield* SynchronizedRef.make(new Map<string, GeminiAcpFlavor>());
    const toProcessError = (threadId: ThreadId, cause: { readonly message: string }) =>
      new ProviderAdapterProcessError({
        provider: PROVIDER,
        threadId,
        detail: cause.message,
        cause,
      });

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
            .pipe(Effect.mapError((cause) => toProcessError(input.threadId, cause)));
          yield* initializeGeminiCliHome({ home: probeHome }).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.mapError((cause) => toProcessError(input.threadId, cause)),
          );
          return yield* resolveGeminiAcpFlavor({
            childProcessSpawner,
            geminiSettings: input.geminiSettings,
            cwd: input.cwd,
            home: probeHome,
            clientInfo: { name: "t3-code-gemini-acp-probe", version: "0.0.0" },
          }).pipe(
            Effect.map((result): GeminiAcpFlavor => result.flavor),
            Effect.mapError((cause) => toProcessError(input.threadId, cause)),
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
     * Drift recovery invariant:
     * - A turn may temporarily fall back to `+2` when the chat file is unreadable.
     * - The next authoritative read before a new turn, rollback, or stop repairs
     *   `extra.messageCount` and the last completed turn's `messageCountAfter`.
     * - That bounds uncertainty to the newest unreadable turn instead of letting
     *   the estimate compound across the whole thread.
     */
    const refreshAuthoritativeMessageCount = (extra: GeminiExtra, sessionId: string) =>
      Effect.gen(function* () {
        const metadata = yield* Ref.get(extra.metadataRef);
        const chatFile = yield* resolveGeminiChatFile({
          home: extra.home,
          sessionId,
          ...(metadata.chatFileRelativePath
            ? { chatFileRelativePath: metadata.chatFileRelativePath }
            : {}),
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.orElseSucceed(() => undefined),
        );
        if (!chatFile) return undefined;
        const countedMessages = yield* countPersistedGeminiMessages(chatFile.absolutePath).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.orElseSucceed(() => undefined),
        );
        if (countedMessages === undefined) return undefined;

        extra.messageCount = countedMessages;
        const changed = yield* Ref.modify(extra.metadataRef, (current) => {
          let next = withGeminiChatFileRelativePath(current, chatFile.relativePath);
          const lastTurn = next.turns.at(-1);
          if (lastTurn?.status === "completed" && lastTurn.messageCountAfter !== countedMessages) {
            next = updateLastGeminiTurnStatus(next, "completed", {
              messageCountAfter: countedMessages,
            });
          }
          return [next !== current, next] as const;
        });
        if (changed) {
          yield* persistMetadata(extra);
        }
        return {
          countedMessages,
          chatFileRelativePath: chatFile.relativePath,
          chatFilePath: chatFile.absolutePath,
        } as const;
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
        yield* refreshAuthoritativeMessageCount(extra, acpSessionId);
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
              Effect.mapError((error) => toProcessError(startInput.threadId, error)),
            );
            const resolvedCwd = nodePath.resolve(cwd);
            const threadPaths = resolveGeminiThreadPaths({
              providerStateDir: serverConfig.providerStateDir,
              threadId: startInput.threadId,
            });
            yield* fileSystem
              .makeDirectory(threadPaths.threadDir, { recursive: true })
              .pipe(Effect.mapError((cause) => toProcessError(startInput.threadId, cause)));
            yield* initializeGeminiCliHome({ home: threadPaths.home }).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.mapError((cause) => toProcessError(startInput.threadId, cause)),
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
              authMethodId: (yield* resolveGeminiAuthMethod()) ?? "oauth-personal",
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

            // Pre-populate metadataRef when the persisted metadata is
            // safe to reuse (see canReusePersistedGeminiMetadata's
            // docstring for the resume-vs-fresh-start semantics).
            const initialMetadata: GeminiSessionMetadata = canReusePersistedGeminiMetadata(
              persistedMetadata,
              resumeSessionId,
            )
              ? persistedMetadata!
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
          extra,
        }) =>
          Effect.gen(function* () {
            const appliedMode = yield* applyRequestedSessionMode({
              runtime: acp,
              sessionId,
              runtimeMode,
              interactionMode,
              lastAppliedMode: extra.lastAppliedMode,
            });
            const geminiModelSelection =
              modelSelection?.provider === "gemini" ? modelSelection : undefined;
            const appliedModel = yield* applyRequestedSessionModelSelection({
              runtime: acp,
              sessionId,
              model: geminiModelSelection?.model,
              modelOptions: geminiModelSelection?.options,
              lastAppliedModel: extra.lastAppliedModel,
              lastAppliedConfigKey: extra.lastAppliedConfigKey,
            });
            if (appliedMode !== undefined) {
              extra.lastAppliedMode = appliedMode;
            }
            if (appliedModel.shouldCacheModel) {
              extra.lastAppliedModel = appliedModel.appliedModel;
            }
            if (appliedModel.shouldCacheConfigKey) {
              extra.lastAppliedConfigKey = appliedModel.appliedConfigKey;
            }
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
            yield* refreshAuthoritativeMessageCount(ctx.extra, ctx.acpSessionId);
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
                  Effect.orElseSucceed(() => messageCountBefore + GEMINI_ASSUMED_MESSAGES_PER_TURN),
                )
              : messageCountBefore + GEMINI_ASSUMED_MESSAGES_PER_TURN;

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

            if (countedMessages < messageCountBefore) {
              // Chat file moved backwards between before/after — likely a
              // Gemini CLI version that rewrote the file out from under
              // us. Log loudly instead of papering over with a +2 guess
              // so drift is visible.
              yield* Effect.logWarning(
                "Gemini chat file message count regressed; using messageCountBefore",
                {
                  threadId: ctx.threadId,
                  messageCountBefore,
                  countedMessages,
                },
              );
            }
            ctx.extra.messageCount = Math.max(countedMessages, messageCountBefore);
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

        beforeStop: (ctx) => truncateChatIfIncomplete(ctx.extra, ctx.acpSessionId),

        afterRollback: ({ ctx, numTurns }) =>
          Effect.gen(function* () {
            yield* refreshAuthoritativeMessageCount(ctx.extra, ctx.acpSessionId);
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

    return base satisfies GeminiAdapterShape;
  });
}

export const GeminiAdapterLive = Layer.effect(GeminiAdapter, makeGeminiAdapterEffect());

export function makeGeminiAdapterLive(opts?: AcpAdapterLiveOptions) {
  return Layer.effect(GeminiAdapter, makeGeminiAdapterEffect(opts));
}
