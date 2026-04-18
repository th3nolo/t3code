/**
 * GeminiAdapterLive — Gemini CLI interactive provider over ACP.
 *
 * Uses the Gemini CLI `--acp` flag (falling back to
 * `--experimental-acp` when present) and persists its session
 * metadata in `providerStateDir/gemini/<threadId>/`.
 *
 * @module GeminiAdapterLive
 */
import * as nodePath from "node:path";

import {
  ApprovalRequestId,
  EventId,
  type GeminiModelOptions,
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  RuntimeRequestId,
  type RuntimeMode,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import {
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  PubSub,
  Random,
  Ref,
  Scope,
  Semaphore,
  Stream,
  SynchronizedRef,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { extractProposedPlanMarkdown } from "../proposedPlan.ts";
import { acpPermissionOutcome, mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import { type AcpSessionRuntimeShape } from "../acp/AcpSessionRuntime.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import {
  type AcpSessionMode,
  type AcpSessionModeState,
  parsePermissionRequest,
} from "../acp/AcpRuntimeModel.ts";
import { makeAcpNativeLoggers } from "../acp/AcpNativeLogging.ts";
import {
  applyGeminiAcpModelSelection,
  type GeminiAcpFlavor,
  makeGeminiAcpRuntime,
  resolveGeminiAcpFlavor,
  resolveGeminiAuthMethod,
  seedGeminiCliHomeAuth,
  validateGeminiLaunchArgs,
  writeGeminiCliSettings,
} from "../acp/GeminiAcpSupport.ts";
import { GeminiAdapter, type GeminiAdapterShape } from "../Services/GeminiAdapter.ts";
import {
  appendGeminiTurn,
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
  writeGeminiSessionMetadata,
  type GeminiSessionMetadata,
} from "../session/GeminiSessionStore.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "gemini" as const;

const GEMINI_PLAN_MODE_ALIASES = ["plan", "architect"];
const GEMINI_DEFAULT_MODE_ALIASES = ["default", "code", "chat", "implement"];
const GEMINI_AUTO_EDIT_MODE_ALIASES = ["auto_edit", "auto-edit", "autoedit", "accept-edits"];
const GEMINI_YOLO_MODE_ALIASES = ["yolo", "full-access", "full_access"];

export interface GeminiAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
  readonly kind: string | "unknown";
}

interface PendingUserInput {
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}

interface GeminiSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntimeShape;
  readonly acpSessionId: string;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly metadataPath: string;
  readonly metadataRef: Ref.Ref<GeminiSessionMetadata>;
  readonly home: string;
  readonly acpFlavor: GeminiAcpFlavor;
  messageCount: number;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  lastPlanFingerprint: string | undefined;
  activeTurnId: TurnId | undefined;
  stopped: boolean;
}

function settlePendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void> {
  const pendingEntries = Array.from(pendingApprovals.values());
  return Effect.forEach(
    pendingEntries,
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    { discard: true },
  );
}

function settlePendingUserInputsAsEmptyAnswers(
  pendingUserInputs: ReadonlyMap<ApprovalRequestId, PendingUserInput>,
): Effect.Effect<void> {
  const pendingEntries = Array.from(pendingUserInputs.values());
  return Effect.forEach(
    pendingEntries,
    (pending) => Deferred.succeed(pending.answers, {}).pipe(Effect.ignore),
    { discard: true },
  );
}

function normalizeModeSearchText(mode: AcpSessionMode): string {
  return [mode.id, mode.name, mode.description]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function findModeByAliases(
  modes: ReadonlyArray<AcpSessionMode>,
  aliases: ReadonlyArray<string>,
): AcpSessionMode | undefined {
  const normalizedAliases = aliases.map((alias) => alias.toLowerCase());
  for (const alias of normalizedAliases) {
    const exact = modes.find((mode) => {
      const id = mode.id.toLowerCase();
      const name = mode.name.toLowerCase();
      return id === alias || name === alias;
    });
    if (exact) {
      return exact;
    }
  }
  for (const alias of normalizedAliases) {
    const partial = modes.find((mode) => normalizeModeSearchText(mode).includes(alias));
    if (partial) {
      return partial;
    }
  }
  return undefined;
}

function isPlanMode(mode: AcpSessionMode): boolean {
  return findModeByAliases([mode], GEMINI_PLAN_MODE_ALIASES) !== undefined;
}

/**
 * Map the T3 runtime mode + user-requested interaction mode to a
 * Gemini ACP mode id.
 *
 *   plan           → plan
 *   approval-req.  → default        (T3 intercepts tool approvals)
 *   auto-accept    → auto_edit
 *   full-access    → yolo
 */
function resolveRequestedGeminiModeId(input: {
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly modeState: AcpSessionModeState | undefined;
}): string | undefined {
  const modeState = input.modeState;
  if (!modeState) {
    return undefined;
  }

  if (input.interactionMode === "plan") {
    return findModeByAliases(modeState.availableModes, GEMINI_PLAN_MODE_ALIASES)?.id;
  }

  switch (input.runtimeMode) {
    case "approval-required":
      return (
        findModeByAliases(modeState.availableModes, GEMINI_DEFAULT_MODE_ALIASES)?.id ??
        modeState.availableModes.find((mode) => !isPlanMode(mode))?.id ??
        modeState.currentModeId
      );
    case "auto-accept-edits":
      return (
        findModeByAliases(modeState.availableModes, GEMINI_AUTO_EDIT_MODE_ALIASES)?.id ??
        findModeByAliases(modeState.availableModes, GEMINI_DEFAULT_MODE_ALIASES)?.id ??
        modeState.availableModes.find((mode) => !isPlanMode(mode))?.id ??
        modeState.currentModeId
      );
    case "full-access":
      return (
        findModeByAliases(modeState.availableModes, GEMINI_YOLO_MODE_ALIASES)?.id ??
        findModeByAliases(modeState.availableModes, GEMINI_AUTO_EDIT_MODE_ALIASES)?.id ??
        findModeByAliases(modeState.availableModes, GEMINI_DEFAULT_MODE_ALIASES)?.id ??
        modeState.availableModes.find((mode) => !isPlanMode(mode))?.id ??
        modeState.currentModeId
      );
    default:
      return (
        findModeByAliases(modeState.availableModes, GEMINI_DEFAULT_MODE_ALIASES)?.id ??
        modeState.availableModes.find((mode) => !isPlanMode(mode))?.id ??
        modeState.currentModeId
      );
  }
}

/**
 * Swallow optional ACP-request failures so Gemini session start doesn't
 * die on methods the agent hasn't implemented. JSON-RPC code -32601
 * ("Method not found") gets logged at debug; anything else at warn. Both
 * paths resolve to `void` — we've already tried, move on.
 */
function tolerateOptionalAcpCall(label: string) {
  return (effect: Effect.Effect<unknown, import("effect-acp/errors").AcpError>) =>
    effect.pipe(
      Effect.asVoid,
      Effect.catchCause((cause) => {
        const rendered = String(cause);
        const methodNotFound = rendered.includes("-32601") || /method not found/i.test(rendered);
        const logEffect = methodNotFound
          ? Effect.logDebug(`Gemini ACP ${label}: method not implemented, ignoring`)
          : Effect.logWarning(`Gemini ACP ${label} failed, ignoring`, {
              cause: rendered,
            });
        return logEffect.pipe(Effect.asVoid);
      }),
    );
}

/**
 * Send the standard ACP `session/set_mode` request directly. Gemini CLI
 * implements this natively; the shared AcpSessionRuntime.setMode routes
 * through `setConfigOption("mode", …)` which Gemini rejects as "Method
 * not found". Using the raw request keeps us protocol-correct for agents
 * that follow the standard spec.
 */
function applyRequestedSessionMode(input: {
  readonly runtime: AcpSessionRuntimeShape;
  readonly sessionId: string;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode | undefined;
}): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    const requestedModeId = resolveRequestedGeminiModeId({
      interactionMode: input.interactionMode,
      runtimeMode: input.runtimeMode,
      modeState: yield* input.runtime.getModeState,
    });
    if (!requestedModeId) {
      return;
    }
    yield* input.runtime
      .request("session/set_mode", {
        sessionId: input.sessionId,
        modeId: requestedModeId,
      })
      .pipe(Effect.asVoid, tolerateOptionalAcpCall("session/set_mode"));
  });
}

/**
 * Model selection for Gemini: try the standard `session/set_model` RPC
 * first, then fall back to the helper routine that uses
 * `session/set_config_option` (for agents like Cursor). Both calls are
 * error-tolerant — session start never fails because the agent chose to
 * implement one or the other (or neither).
 */
function applyRequestedSessionModelSelection(input: {
  readonly runtime: AcpSessionRuntimeShape;
  readonly sessionId: string;
  readonly model: string | undefined | null;
  readonly modelOptions: GeminiModelOptions | null | undefined;
}): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    const trimmed = input.model?.trim();
    if (trimmed && trimmed.length > 0 && trimmed !== "auto") {
      yield* input.runtime
        .request("session/set_model", {
          sessionId: input.sessionId,
          modelId: trimmed,
        })
        .pipe(Effect.asVoid, tolerateOptionalAcpCall("session/set_model"));
    }
    // Best-effort apply thinking/effort/context via setConfigOption. If
    // the agent doesn't implement it (Gemini), we swallow the error.
    yield* applyGeminiAcpModelSelection({
      runtime: input.runtime,
      // setModel already handled above via raw RPC — skip the internal
      // setConfigOption("model", …) path that would 404 on Gemini.
      model: undefined,
      modelOptions: input.modelOptions,
      mapError: ({ cause }) => cause,
    }).pipe(
      Effect.catchCause(() =>
        Effect.logDebug("Gemini ACP config-option update failed, ignoring").pipe(Effect.asVoid),
      ),
    );
  });
}

function selectAutoApprovedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  const allowAlways = request.options.find((option) => option.kind === "allow_always");
  if (typeof allowAlways?.optionId === "string" && allowAlways.optionId.trim()) {
    return allowAlways.optionId.trim();
  }
  const allowOnce = request.options.find((option) => option.kind === "allow_once");
  if (typeof allowOnce?.optionId === "string" && allowOnce.optionId.trim()) {
    return allowOnce.optionId.trim();
  }
  return undefined;
}

function makeGeminiAdapter(options?: GeminiAdapterLiveOptions) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const serverSettingsService = yield* ServerSettingsService;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;

    const sessions = new Map<ThreadId, GeminiSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const nextEventId = Effect.map(Random.nextUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing: Option.Option<Semaphore.Semaphore> = Option.fromNullishOr(
          current.get(threadId),
        );
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        });
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const logNative = (threadId: ThreadId, method: string, payload: unknown) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = new Date().toISOString();
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: crypto.randomUUID(),
              kind: "notification",
              provider: PROVIDER,
              createdAt: observedAt,
              method,
              threadId,
              payload,
            },
          },
          threadId,
        );
      });

    const persistMetadata = (ctx: GeminiSessionContext) =>
      Ref.get(ctx.metadataRef).pipe(
        Effect.flatMap((metadata) =>
          fileSystem.writeFileString(ctx.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to persist gemini session metadata", {
            threadId: ctx.threadId,
            cause,
          }).pipe(Effect.asVoid),
        ),
      );

    const emitPlanUpdate = (
      ctx: GeminiSessionContext,
      payload: {
        readonly explanation?: string | null;
        readonly plan: ReadonlyArray<{
          readonly step: string;
          readonly status: "pending" | "inProgress" | "completed";
        }>;
      },
      rawPayload: unknown,
    ) =>
      Effect.gen(function* () {
        const fingerprint = `${ctx.activeTurnId ?? "no-turn"}:${JSON.stringify(payload)}`;
        if (ctx.lastPlanFingerprint === fingerprint) {
          return;
        }
        ctx.lastPlanFingerprint = fingerprint;
        yield* offerRuntimeEvent(
          makeAcpPlanUpdatedEvent({
            stamp: yield* makeEventStamp(),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            payload,
            source: "acp.jsonrpc",
            method: "session/update",
            rawPayload,
          }),
        );
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<GeminiSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const truncateChatToLastCompletedTurn = (ctx: GeminiSessionContext) =>
      Effect.gen(function* () {
        const metadata = yield* Ref.get(ctx.metadataRef);
        if (metadata.turns.length === 0) {
          return;
        }
        const lastTurn = metadata.turns[metadata.turns.length - 1]!;
        if (lastTurn.status !== "incomplete") {
          return;
        }
        const chatFile = yield* resolveGeminiChatFile({
          home: ctx.home,
          sessionId: metadata.sessionId,
          ...(metadata.chatFileRelativePath
            ? { chatFileRelativePath: metadata.chatFileRelativePath }
            : {}),
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.orElseSucceed(() => undefined),
        );
        if (!chatFile) {
          return;
        }
        yield* truncatePersistedGeminiMessages({
          chatFilePath: chatFile.absolutePath,
          messageCount: lastTurn.messageCountBefore,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.orElseSucceed(() => lastTurn.messageCountBefore),
        );
        ctx.messageCount = lastTurn.messageCountBefore;
      });

    const stopSessionInternal = (ctx: GeminiSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
        yield* truncateChatToLastCompletedTurn(ctx);
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const startSession: GeminiAdapterShape["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }

          const cwd = nodePath.resolve(input.cwd.trim());
          const geminiModelSelection =
            input.modelSelection?.provider === "gemini" ? input.modelSelection : undefined;
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const geminiSettings = yield* serverSettingsService.getSettings.pipe(
            Effect.map((settings) => settings.providers.gemini),
            Effect.mapError(
              (error) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: error.message,
                  cause: error,
                }),
            ),
          );

          const launchArgsError = validateGeminiLaunchArgs(geminiSettings.launchArgs);
          if (launchArgsError) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: launchArgsError.message,
            });
          }

          const threadPaths = resolveGeminiThreadPaths({
            providerStateDir: serverConfig.providerStateDir,
            threadId: input.threadId,
          });
          yield* fileSystem.makeDirectory(threadPaths.threadDir, { recursive: true }).pipe(
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
          yield* writeGeminiCliSettings({ home: threadPaths.home }).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: cause instanceof Error ? cause.message : String(cause),
                  cause,
                }),
            ),
          );
          // Copy the user's auth files into the per-thread Gemini home so
          // the spawned `gemini --acp` subprocess inherits `gemini auth
          // login` credentials instead of re-prompting every session.
          yield* seedGeminiCliHomeAuth({ home: threadPaths.home }).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.orElseSucceed(() => [] as ReadonlyArray<string>),
          );

          const persistedMetadata = yield* readGeminiSessionMetadata(threadPaths.metadataPath).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
          );
          const parsedResume = parseGeminiResumeCursor(input.resumeCursor);
          const resumeSessionId =
            parsedResume?.sessionId ?? persistedMetadata?.sessionId ?? undefined;

          // If the persisted last turn is incomplete, roll the chat file back
          // to messageCountBefore before the CLI reads it. Otherwise the
          // resumed session would replay a half-finished turn on top of fresh
          // input — we instead surface the turn as cancelled.
          if (
            persistedMetadata !== undefined &&
            persistedMetadata.turns.length > 0 &&
            persistedMetadata.turns[persistedMetadata.turns.length - 1]!.status === "incomplete"
          ) {
            const lastTurn = persistedMetadata.turns[persistedMetadata.turns.length - 1]!;
            const chatFile = yield* resolveGeminiChatFile({
              home: threadPaths.home,
              sessionId: persistedMetadata.sessionId,
              ...(persistedMetadata.chatFileRelativePath
                ? { chatFileRelativePath: persistedMetadata.chatFileRelativePath }
                : {}),
            }).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.orElseSucceed(() => undefined),
            );
            if (chatFile) {
              yield* truncatePersistedGeminiMessages({
                chatFilePath: chatFile.absolutePath,
                messageCount: lastTurn.messageCountBefore,
              }).pipe(
                Effect.provideService(FileSystem.FileSystem, fileSystem),
                Effect.orElseSucceed(() => lastTurn.messageCountBefore),
              );
            }
          }

          // Decide up-front which ACP flag this CLI accepts. Older builds
          // require `--experimental-acp`; newer ones prefer `--acp`. The
          // probe runs in an isolated temp home so it can't pollute the
          // real thread state.
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
          const resolvedFlavor: GeminiAcpFlavor = yield* resolveGeminiAcpFlavor({
            childProcessSpawner,
            geminiSettings,
            cwd,
            home: probeHome,
            clientInfo: { name: "t3-code-gemini-acp-probe", version: "0.0.0" },
          }).pipe(
            Effect.map((result): GeminiAcpFlavor => result.flavor),
            Effect.catchCause(() => Effect.succeed<GeminiAcpFlavor>("acp")),
          );

          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );
          let ctx!: GeminiSessionContext;

          const acpNativeLoggers = makeAcpNativeLoggers({
            nativeEventLogger,
            provider: PROVIDER,
            threadId: input.threadId,
          });

          const acp = yield* makeGeminiAcpRuntime({
            geminiSettings,
            childProcessSpawner,
            cwd,
            home: threadPaths.home,
            flavor: resolvedFlavor,
            ...(resumeSessionId ? { resumeSessionId } : {}),
            clientInfo: { name: "t3-code", version: "0.0.0" },
            authMethodId: resolveGeminiAuthMethod() ?? "oauth-personal",
            ...acpNativeLoggers,
          }).pipe(
            Effect.provideService(Scope.Scope, sessionScope),
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

          const started = yield* Effect.gen(function* () {
            yield* acp.handleRequestPermission((params) =>
              Effect.gen(function* () {
                yield* logNative(input.threadId, "session/request_permission", params);
                if (input.runtimeMode === "full-access") {
                  const autoApproved = selectAutoApprovedPermissionOption(params);
                  if (autoApproved !== undefined) {
                    return {
                      outcome: {
                        outcome: "selected" as const,
                        optionId: autoApproved,
                      },
                    };
                  }
                }
                const permissionRequest = parsePermissionRequest(params);
                const requestId = ApprovalRequestId.make(crypto.randomUUID());
                const runtimeRequestId = RuntimeRequestId.make(requestId);
                const decision = yield* Deferred.make<ProviderApprovalDecision>();
                pendingApprovals.set(requestId, {
                  decision,
                  kind: permissionRequest.kind,
                });
                yield* offerRuntimeEvent(
                  makeAcpRequestOpenedEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: ctx?.activeTurnId,
                    requestId: runtimeRequestId,
                    permissionRequest,
                    detail: permissionRequest.detail ?? JSON.stringify(params).slice(0, 2000),
                    args: params,
                    source: "acp.jsonrpc",
                    method: "session/request_permission",
                    rawPayload: params,
                  }),
                );
                const resolved = yield* Deferred.await(decision);
                pendingApprovals.delete(requestId);
                yield* offerRuntimeEvent(
                  makeAcpRequestResolvedEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: ctx?.activeTurnId,
                    requestId: runtimeRequestId,
                    permissionRequest,
                    decision: resolved,
                  }),
                );
                return {
                  outcome:
                    resolved === "cancel"
                      ? ({ outcome: "cancelled" } as const)
                      : {
                          outcome: "selected" as const,
                          optionId: acpPermissionOutcome(resolved),
                        },
                };
              }),
            );
            return yield* acp.start();
          }).pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
            ),
          );

          yield* applyRequestedSessionMode({
            runtime: acp,
            sessionId: started.sessionId,
            runtimeMode: input.runtimeMode,
            interactionMode: undefined,
          });
          yield* applyRequestedSessionModelSelection({
            runtime: acp,
            sessionId: started.sessionId,
            model: geminiModelSelection?.model,
            modelOptions: geminiModelSelection?.options,
          });

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model: geminiModelSelection?.model,
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: GEMINI_SESSION_SCHEMA_VERSION,
              sessionId: started.sessionId,
            },
            createdAt: now,
            updatedAt: now,
          };

          const initialMetadata: GeminiSessionMetadata =
            persistedMetadata !== undefined && persistedMetadata.sessionId === started.sessionId
              ? persistedMetadata
              : makeInitialGeminiMetadata({ sessionId: started.sessionId });
          const metadataRef = yield* Ref.make<GeminiSessionMetadata>(initialMetadata);
          const initialMessageCount = initialMetadata.turns.reduce(
            (max, turn) => Math.max(max, turn.messageCountAfter),
            0,
          );

          ctx = {
            threadId: input.threadId,
            session,
            scope: sessionScope,
            acp,
            acpSessionId: started.sessionId,
            notificationFiber: undefined,
            pendingApprovals,
            pendingUserInputs,
            metadataPath: threadPaths.metadataPath,
            metadataRef,
            home: threadPaths.home,
            acpFlavor: resolvedFlavor,
            messageCount: initialMessageCount,
            turns: [],
            lastPlanFingerprint: undefined,
            activeTurnId: undefined,
            stopped: false,
          };

          yield* persistMetadata(ctx);

          const nf = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                switch (event._tag) {
                  case "ModeChanged":
                    return;
                  case "AssistantItemStarted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.started",
                      }),
                    );
                    return;
                  case "AssistantItemCompleted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.completed",
                      }),
                    );
                    return;
                  case "PlanUpdated":
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* emitPlanUpdate(ctx, event.payload, event.rawPayload);
                    return;
                  case "ToolCallUpdated":
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* offerRuntimeEvent(
                      makeAcpToolCallEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        toolCall: event.toolCall,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "ContentDelta": {
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        ...(event.itemId ? { itemId: event.itemId } : {}),
                        text: event.text,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    const planMarkdown = extractProposedPlanMarkdown(event.text);
                    if (planMarkdown) {
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
                          payload: event.rawPayload,
                        },
                      });
                    }
                    return;
                  }
                }
              }),
            ),
          ).pipe(Effect.forkChild);

          ctx.notificationFiber = nf;
          sessions.set(input.threadId, ctx);
          sessionScopeTransferred = true;

          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: started.initializeResult },
          });
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready", reason: "Gemini ACP session ready" },
          });
          yield* offerRuntimeEvent({
            type: "thread.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });

          return session;
        }).pipe(Effect.scoped),
      );

    const sendTurn: GeminiAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        const turnId = TurnId.make(crypto.randomUUID());
        const turnModelSelection =
          input.modelSelection?.provider === "gemini" ? input.modelSelection : undefined;
        const model = turnModelSelection?.model ?? ctx.session.model ?? undefined;

        yield* applyRequestedSessionMode({
          runtime: ctx.acp,
          sessionId: ctx.acpSessionId,
          runtimeMode: ctx.session.runtimeMode,
          interactionMode: input.interactionMode,
        });
        yield* applyRequestedSessionModelSelection({
          runtime: ctx.acp,
          sessionId: ctx.acpSessionId,
          model,
          modelOptions: turnModelSelection?.options,
        });

        ctx.activeTurnId = turnId;
        ctx.lastPlanFingerprint = undefined;
        ctx.session = {
          ...ctx.session,
          activeTurnId: turnId,
          updatedAt: yield* nowIso,
        };

        const messageCountBefore = ctx.messageCount;
        yield* Ref.update(ctx.metadataRef, (metadata) =>
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
        yield* persistMetadata(ctx);

        yield* offerRuntimeEvent({
          type: "turn.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          payload: model ? { model } : {},
        });

        const promptParts: Array<EffectAcpSchema.ContentBlock> = [];
        if (input.input?.trim()) {
          promptParts.push({ type: "text", text: input.input.trim() });
        }
        if (input.attachments && input.attachments.length > 0) {
          for (const attachment of input.attachments) {
            const attachmentPath = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment,
            });
            if (!attachmentPath) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/prompt",
                detail: `Invalid attachment id '${attachment.id}'.`,
              });
            }
            const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session/prompt",
                    detail: cause.message,
                    cause,
                  }),
              ),
            );
            promptParts.push({
              type: "image",
              data: Buffer.from(bytes).toString("base64"),
              mimeType: attachment.mimeType,
            });
          }
        }

        if (promptParts.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Turn requires non-empty text or attachments.",
          });
        }

        const result = yield* ctx.acp
          .prompt({
            prompt: promptParts,
          })
          .pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
            ),
          );

        // One prompt message + at least one assistant reply per turn.
        ctx.messageCount = messageCountBefore + 2;
        const status = result.stopReason === "cancelled" ? "incomplete" : "completed";
        yield* Ref.update(ctx.metadataRef, (metadata) =>
          updateLastGeminiTurnStatus(metadata, status, {
            messageCountAfter: ctx.messageCount,
          }),
        );
        yield* persistMetadata(ctx);

        ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, result }] });
        ctx.session = {
          ...ctx.session,
          activeTurnId: turnId,
          updatedAt: yield* nowIso,
          model: model ?? ctx.session.model,
        };

        yield* offerRuntimeEvent({
          type: "turn.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          payload: {
            state: result.stopReason === "cancelled" ? "cancelled" : "completed",
            stopReason: result.stopReason ?? null,
          },
        });

        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: ctx.session.resumeCursor,
        };
      });

    const interruptTurn: GeminiAdapterShape["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
        yield* Effect.ignore(
          ctx.acp.cancel.pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", error),
            ),
          ),
        );
      });

    const respondToRequest: GeminiAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: GeminiAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/user_input",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.answers, answers);
      });

    const readThread: GeminiAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: GeminiAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        const nextLength = Math.max(0, ctx.turns.length - numTurns);
        ctx.turns.splice(nextLength);

        const truncated = yield* Ref.modify(ctx.metadataRef, (metadata) => {
          const { next, truncated } = truncateGeminiTurns(metadata, numTurns);
          return [truncated, next] as const;
        });
        if (truncated.length > 0) {
          const firstTruncated = truncated[0]!;
          ctx.messageCount = firstTruncated.messageCountBefore;
        }
        const metadataAfter = yield* Ref.get(ctx.metadataRef);
        const chatFile = yield* resolveGeminiChatFile({
          home: ctx.home,
          sessionId: metadataAfter.sessionId,
          ...(metadataAfter.chatFileRelativePath
            ? { chatFileRelativePath: metadataAfter.chatFileRelativePath }
            : {}),
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.orElseSucceed(() => undefined),
        );
        if (chatFile) {
          yield* truncatePersistedGeminiMessages({
            chatFilePath: chatFile.absolutePath,
            messageCount: ctx.messageCount,
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.orElseSucceed(() => ctx.messageCount),
          );
        }
        yield* persistMetadata(ctx);

        return { threadId, turns: ctx.turns };
      });

    const stopSession: GeminiAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: GeminiAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: GeminiAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    const stopAll: GeminiAdapterShape["stopAll"] = () =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true }).pipe(
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents,
    } satisfies GeminiAdapterShape;
  });
}

export const GeminiAdapterLive = Layer.effect(GeminiAdapter, makeGeminiAdapter());

export function makeGeminiAdapterLive(opts?: GeminiAdapterLiveOptions) {
  return Layer.effect(GeminiAdapter, makeGeminiAdapter(opts));
}
