/**
 * AcpAdapterBase — shared machinery for ACP-based provider adapters.
 *
 * Cursor and Gemini both speak the Agent-Client Protocol. Before this
 * module, each re-implemented the same session map, thread-lock map,
 * pubsub wiring, permission/user-input settling, notification-fiber
 * loop, and generic shape methods (~400 lines each). This base
 * factory collapses that into one place; providers supply only the
 * parts that genuinely differ through a small hook surface.
 *
 * @module AcpAdapterBase
 */
import {
  ApprovalRequestId,
  EventId,
  type ModelSelection,
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  type ProviderKind,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderUserInputAnswers,
  type RuntimeMode,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import {
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Option,
  PubSub,
  Random,
  Scope,
  Semaphore,
  Stream,
  SynchronizedRef,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "./AcpCoreRuntimeEvents.ts";
import { type AcpSessionMode, parsePermissionRequest } from "./AcpRuntimeModel.ts";
import { type AcpSessionRuntimeShape } from "./AcpSessionRuntime.ts";
import { acpPermissionOutcome, mapAcpToAdapterError } from "./AcpAdapterSupport.ts";
import { makeAcpNativeLoggers } from "./AcpNativeLogging.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "../Layers/EventNdjsonLogger.ts";
import type {
  ProviderAdapterCapabilities,
  ProviderAdapterShape,
  ProviderThreadSnapshot,
} from "../Services/ProviderAdapter.ts";

export interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
  readonly kind: string | "unknown";
}

export interface PendingUserInput {
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}

export interface BaseAcpSessionContext<TExtra> {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntimeShape;
  readonly acpSessionId: string;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  lastPlanFingerprint: string | undefined;
  activeTurnId: TurnId | undefined;
  stopped: boolean;
  readonly extra: TExtra;
  /**
   * Deferred signalled by `interruptTurn`'s grace timer to tell
   * `sendTurn` to synthesize a cancelled `turn.completed` event
   * without waiting for the real prompt reply. Set in `sendTurn`
   * before the prompt race; cleared after the race resolves.
   */
  cancelSignal: Deferred.Deferred<void> | undefined;
}

export type EventStamp = { readonly eventId: EventId; readonly createdAt: string };

export interface PlanUpdatePayload {
  readonly explanation?: string | null;
  readonly plan: ReadonlyArray<{
    readonly step: string;
    readonly status: "pending" | "inProgress" | "completed";
  }>;
}

export interface ExtensionHandlerContext {
  readonly acp: AcpSessionRuntimeShape;
  readonly threadId: ThreadId;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly offerRuntimeEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
  readonly makeEventStamp: () => Effect.Effect<EventStamp>;
  readonly logNative: (
    method: string,
    payload: unknown,
    source?: "acp.jsonrpc" | "acp.cursor.extension",
  ) => Effect.Effect<void>;
  readonly getActiveTurnId: () => TurnId | undefined;
  /**
   * Emit a plan-update event (with fingerprint dedup against the active
   * session context). If the session context hasn't been built yet
   * (extension handler fires before session/start resolves), the call
   * is a no-op.
   */
  readonly emitPlanUpdate: (
    payload: PlanUpdatePayload,
    rawPayload: unknown,
    source: "acp.jsonrpc" | "acp.cursor.extension",
    method: string,
  ) => Effect.Effect<void>;
}

export interface ContentDeltaHookContext<TExtra> {
  readonly ctx: BaseAcpSessionContext<TExtra>;
  readonly text: string;
  readonly rawPayload: unknown;
  readonly offerRuntimeEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
  readonly makeEventStamp: () => Effect.Effect<EventStamp>;
}

export interface AcpAdapterBaseConfig<TProvider extends ProviderKind, TExtra> {
  readonly provider: TProvider;
  readonly capabilities: ProviderAdapterCapabilities;

  /** Validate any provider-specific part of the incoming startSession input. */
  readonly validateStartInput?: (
    input: ProviderSessionStartInput,
  ) => Effect.Effect<void, ProviderAdapterValidationError>;

  /**
   * Build the per-session ACP runtime + session-extra state. Runs inside
   * the session scope. Cursor keeps `extra` empty; Gemini populates
   * thread paths, the ACP session id it plans to load, etc.
   */
  readonly buildSession: (input: {
    readonly startInput: ProviderSessionStartInput;
    readonly cwd: string;
    readonly resumeSessionId: string | undefined;
    readonly nativeLoggers: ReturnType<typeof makeAcpNativeLoggers>;
  }) => Effect.Effect<
    { readonly acp: AcpSessionRuntimeShape; readonly extra: TExtra },
    ProviderAdapterError,
    Scope.Scope | FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
  >;

  /** Parse the persisted resume cursor into its sessionId, if valid. */
  readonly parseResumeCursor: (raw: unknown) => { readonly sessionId: string } | undefined;
  /** Build the resume cursor that will ship in ProviderSession.resumeCursor. */
  readonly buildResumeCursor: (sessionId: string) => ProviderSession["resumeCursor"];

  /**
   * Register any provider-specific ACP extension handlers (e.g. Cursor's
   * cursor/ask_question, cursor/create_plan, cursor/update_todos).
   * Gemini leaves this unset.
   */
  readonly registerExtensionHandlers?: (context: ExtensionHandlerContext) => Effect.Effect<void>;

  /**
   * Apply mode + model to the ACP session. Called after session start
   * and before each turn. Cursor routes everything through
   * setConfigOption; Gemini uses session/set_mode + session/set_model.
   */
  readonly applySessionConfiguration: (input: {
    readonly acp: AcpSessionRuntimeShape;
    readonly sessionId: string;
    readonly runtimeMode: RuntimeMode;
    readonly interactionMode: ProviderInteractionMode | undefined;
    readonly modelSelection: ModelSelection | undefined;
    readonly threadId: ThreadId;
  }) => Effect.Effect<void, ProviderAdapterError>;

  /** Optional: resolve the model string that will be recorded in the session. */
  readonly resolveSessionModel?: (modelSelection: ModelSelection | undefined) => string | undefined;

  /**
   * Optional: run after the session context is first built. Gemini persists
   * metadata here. May return an array of turns to seed `ctx.turns` on
   * resume — this is how providers that maintain their own persisted turn
   * index keep `readThread` and `rollbackThread` accurate after a process
   * restart. Items inside each restored turn stay opaque (typically `[]`)
   * because the protocol doesn't require message bodies for replay.
   */
  readonly afterSessionCreated?: (ctx: BaseAcpSessionContext<TExtra>) => Effect.Effect<void | {
    readonly seedTurns?: ReadonlyArray<{ id: TurnId; items: Array<unknown> }>;
  }>;

  /**
   * Optional: run when a content-delta notification arrives. Gemini uses
   * this to parse <proposed_plan> blocks and emit turn.proposed.completed
   * events; Cursor relies on its native cursor/create_plan extension.
   */
  readonly onContentDelta?: (context: ContentDeltaHookContext<TExtra>) => Effect.Effect<void>;

  /** Optional turn-lifecycle hooks (Gemini uses these for metadata + message counting). */
  readonly beforeTurn?: (input: {
    readonly ctx: BaseAcpSessionContext<TExtra>;
    readonly turnId: TurnId;
    readonly modelSelection: ModelSelection | undefined;
  }) => Effect.Effect<void, ProviderAdapterError>;

  readonly afterTurnSettled?: (input: {
    readonly ctx: BaseAcpSessionContext<TExtra>;
    readonly turnId: TurnId;
    readonly stopReason: string | null | undefined;
  }) => Effect.Effect<void>;

  /** Optional cleanup hooks (Gemini truncates the chat file on stop + rollback). */
  readonly beforeStop?: (ctx: BaseAcpSessionContext<TExtra>) => Effect.Effect<void>;
  readonly afterRollback?: (input: {
    readonly ctx: BaseAcpSessionContext<TExtra>;
    readonly numTurns: number;
  }) => Effect.Effect<void>;

  /**
   * Permission auto-approval policy. Defaults to
   * `selectAutoApprovedPermissionOption` gated on runtimeMode==="full-access".
   */
  readonly selectAutoApprovedPermission?: (input: {
    readonly request: EffectAcpSchema.RequestPermissionRequest;
    readonly runtimeMode: RuntimeMode;
  }) => string | undefined;

  /**
   * Optional override for the native-log source tag on permission/session
   * updates. Defaults to "acp.jsonrpc".
   */
  readonly defaultLogSource?: "acp.jsonrpc" | "acp.cursor.extension";
}

export interface AcpAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  /**
   * Maximum time the `session/cancel` notification is allowed to take
   * before we log a warning and move on. The notification is
   * fire-and-forget in normal operation (writes to stdout instantly);
   * this timeout only catches pathological cases (hung child process,
   * backed-up pipe). Defaults to `"2 seconds"`.
   */
  readonly acpCancelTimeout?: Duration.Input;
  /**
   * Maximum time `sendTurn` will wait for the agent to naturally
   * resolve `session/prompt` after a cancel notification has been
   * sent. If exceeded, `sendTurn` synthesizes a cancelled
   * `turn.completed` event so the UI can transition out of "running"
   * state even when the agent's implementation is slow or buggy about
   * honoring cancel. The real prompt reply, if it ever arrives, is
   * drained in the background and discarded. Defaults to
   * `"3 seconds"`.
   */
  readonly syntheticCancelGrace?: Duration.Input;
}

// ── common pure helpers ────────────────────────────────────────────────

export function settlePendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void> {
  return Effect.forEach(
    pendingApprovals.values(),
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    { discard: true },
  );
}

export function settlePendingUserInputsAsEmptyAnswers(
  pendingUserInputs: ReadonlyMap<ApprovalRequestId, PendingUserInput>,
): Effect.Effect<void> {
  return Effect.forEach(
    pendingUserInputs.values(),
    (pending) => Deferred.succeed(pending.answers, {}).pipe(Effect.ignore),
    { discard: true },
  );
}

export function selectAutoApprovedPermissionOption(
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

export function normalizeModeSearchText(mode: AcpSessionMode): string {
  return [mode.id, mode.name, mode.description]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function findModeByAliases(
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
    if (exact) return exact;
  }
  for (const alias of normalizedAliases) {
    const partial = modes.find((mode) => normalizeModeSearchText(mode).includes(alias));
    if (partial) return partial;
  }
  return undefined;
}

export function isPlanMode(mode: AcpSessionMode, planAliases: ReadonlyArray<string>): boolean {
  return findModeByAliases([mode], planAliases) !== undefined;
}

// ── factory ────────────────────────────────────────────────────────────

export function makeAcpAdapter<TProvider extends ProviderKind, TExtra>(
  config: AcpAdapterBaseConfig<TProvider, TExtra>,
  liveOptions?: AcpAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const serverConfig = yield* Effect.service(ServerConfig);
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const nativeEventLogger =
      liveOptions?.nativeEventLogger ??
      (liveOptions?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(liveOptions.nativeEventLogPath, { stream: "native" })
        : undefined);
    const managedNativeEventLogger =
      liveOptions?.nativeEventLogger === undefined ? nativeEventLogger : undefined;

    const sessions = new Map<ThreadId, BaseAcpSessionContext<TExtra>>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const PROVIDER = config.provider;
    const defaultLogSource = config.defaultLogSource ?? "acp.jsonrpc";
    const acpCancelTimeout: Duration.Input = liveOptions?.acpCancelTimeout ?? "2 seconds";
    const syntheticCancelGrace: Duration.Input = liveOptions?.syntheticCancelGrace ?? "3 seconds";
    const autoApprove =
      config.selectAutoApprovedPermission ??
      (({ request, runtimeMode }) =>
        runtimeMode === "full-access" ? selectAutoApprovedPermissionOption(request) : undefined);

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const nextEventId = Effect.map(Random.nextUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = (): Effect.Effect<EventStamp> =>
      Effect.all({ eventId: nextEventId, createdAt: nowIso });

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

    const logNative = (
      threadId: ThreadId,
      method: string,
      payload: unknown,
      source: "acp.jsonrpc" | "acp.cursor.extension" = defaultLogSource,
    ) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = new Date().toISOString();
        // `source` rides along on the event payload so downstream
        // consumers can distinguish JSON-RPC notifications from
        // Cursor-extension notifications without re-deriving from method
        // names. The base logger preserves arbitrary payload fields.
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
              payload: { source, payload },
            },
          },
          threadId,
        );
      });

    const emitPlanUpdate = (
      ctx: BaseAcpSessionContext<TExtra>,
      payload: {
        readonly explanation?: string | null;
        readonly plan: ReadonlyArray<{
          readonly step: string;
          readonly status: "pending" | "inProgress" | "completed";
        }>;
      },
      rawPayload: unknown,
      source: "acp.jsonrpc" | "acp.cursor.extension",
      method: string,
    ) =>
      Effect.gen(function* () {
        const fingerprint = `${ctx.activeTurnId ?? "no-turn"}:${JSON.stringify(payload)}`;
        if (ctx.lastPlanFingerprint === fingerprint) return;
        ctx.lastPlanFingerprint = fingerprint;
        yield* offerRuntimeEvent(
          makeAcpPlanUpdatedEvent({
            stamp: yield* makeEventStamp(),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            payload,
            source,
            method,
            rawPayload,
          }),
        );
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<BaseAcpSessionContext<TExtra>, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const stopSessionInternal = (ctx: BaseAcpSessionContext<TExtra>) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
        if (config.beforeStop) {
          yield* config.beforeStop(ctx);
        }
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

    const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (input) =>
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
          if (config.validateStartInput) {
            yield* config.validateStartInput(input);
          }

          const cwd = input.cwd.trim();
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );
          let ctx!: BaseAcpSessionContext<TExtra>;

          const resumeSessionId = config.parseResumeCursor(input.resumeCursor)?.sessionId;
          const nativeLoggers = makeAcpNativeLoggers({
            nativeEventLogger,
            provider: PROVIDER,
            threadId: input.threadId,
          });

          const { acp, extra } = yield* config
            .buildSession({
              startInput: input,
              cwd,
              resumeSessionId,
              nativeLoggers,
            })
            .pipe(
              Effect.provideService(Scope.Scope, sessionScope),
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
            );

          // Wire permission handling + any provider-specific extensions.
          yield* Effect.gen(function* () {
            if (config.registerExtensionHandlers) {
              yield* config.registerExtensionHandlers({
                acp,
                threadId: input.threadId,
                pendingUserInputs,
                offerRuntimeEvent,
                makeEventStamp,
                logNative: (method, payload, source) =>
                  logNative(input.threadId, method, payload, source),
                getActiveTurnId: () => ctx?.activeTurnId,
                emitPlanUpdate: (payload, rawPayload, source, method) =>
                  ctx ? emitPlanUpdate(ctx, payload, rawPayload, source, method) : Effect.void,
              });
            }
            yield* acp.handleRequestPermission((params) =>
              Effect.gen(function* () {
                yield* logNative(
                  input.threadId,
                  "session/request_permission",
                  params,
                  "acp.jsonrpc",
                );
                const autoApprovedOptionId = autoApprove({
                  request: params,
                  runtimeMode: input.runtimeMode,
                });
                if (autoApprovedOptionId !== undefined) {
                  return {
                    outcome: {
                      outcome: "selected" as const,
                      optionId: autoApprovedOptionId,
                    },
                  };
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
          });

          const started = yield* acp
            .start()
            .pipe(
              Effect.mapError((error) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
              ),
            );

          yield* config.applySessionConfiguration({
            acp,
            sessionId: started.sessionId,
            runtimeMode: input.runtimeMode,
            interactionMode: undefined,
            modelSelection: input.modelSelection,
            threadId: input.threadId,
          });

          const now = yield* nowIso;
          const sessionModel = config.resolveSessionModel?.(input.modelSelection);
          const session: ProviderSession = {
            provider: PROVIDER,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            ...(sessionModel !== undefined ? { model: sessionModel } : {}),
            threadId: input.threadId,
            resumeCursor: config.buildResumeCursor(started.sessionId),
            createdAt: now,
            updatedAt: now,
          };

          ctx = {
            threadId: input.threadId,
            session,
            scope: sessionScope,
            acp,
            acpSessionId: started.sessionId,
            notificationFiber: undefined,
            pendingApprovals,
            pendingUserInputs,
            turns: [],
            lastPlanFingerprint: undefined,
            activeTurnId: undefined,
            stopped: false,
            extra,
            cancelSignal: undefined,
          };

          if (config.afterSessionCreated) {
            const result = yield* config.afterSessionCreated(ctx);
            if (result && result.seedTurns && result.seedTurns.length > 0) {
              ctx.turns.push(...result.seedTurns);
            }
          }

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
                    yield* logNative(
                      ctx.threadId,
                      "session/update",
                      event.rawPayload,
                      "acp.jsonrpc",
                    );
                    yield* emitPlanUpdate(
                      ctx,
                      event.payload,
                      event.rawPayload,
                      "acp.jsonrpc",
                      "session/update",
                    );
                    return;
                  case "ToolCallUpdated":
                    yield* logNative(
                      ctx.threadId,
                      "session/update",
                      event.rawPayload,
                      "acp.jsonrpc",
                    );
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
                  case "ContentDelta":
                    yield* logNative(
                      ctx.threadId,
                      "session/update",
                      event.rawPayload,
                      "acp.jsonrpc",
                    );
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
                    if (config.onContentDelta) {
                      yield* config.onContentDelta({
                        ctx,
                        text: event.text,
                        rawPayload: event.rawPayload,
                        offerRuntimeEvent,
                        makeEventStamp,
                      });
                    }
                    return;
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
            payload: {
              state: "ready",
              reason: `${config.provider} ACP session ready`,
            },
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

    const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        const turnId = TurnId.make(crypto.randomUUID());
        const turnModel = config.resolveSessionModel?.(input.modelSelection) ?? ctx.session.model;

        yield* config.applySessionConfiguration({
          acp: ctx.acp,
          sessionId: ctx.acpSessionId,
          runtimeMode: ctx.session.runtimeMode,
          interactionMode: input.interactionMode,
          modelSelection: input.modelSelection,
          threadId: input.threadId,
        });

        ctx.activeTurnId = turnId;
        ctx.lastPlanFingerprint = undefined;
        ctx.session = {
          ...ctx.session,
          activeTurnId: turnId,
          updatedAt: yield* nowIso,
        };

        // Wire up the cancelSignal BEFORE emitting turn.started so that
        // an interruptTurn racing against the `turn.started` event
        // always sees the signal. interruptTurn reads ctx.cancelSignal
        // to schedule the grace timer.
        const cancelSignal = yield* Deferred.make<void>();
        ctx.cancelSignal = cancelSignal;

        if (config.beforeTurn) {
          yield* config.beforeTurn({
            ctx,
            turnId,
            modelSelection: input.modelSelection,
          });
        }

        yield* offerRuntimeEvent({
          type: "turn.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          payload: turnModel ? { model: turnModel } : {},
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

        // `cancelSignal` was wired up above, before we emitted
        // `turn.started`, so interruptTurn can always see it. Race the
        // prompt against the cancelSignal: if the signal fires first,
        // `raceFirst` interrupts the prompt Effect — client-side we
        // stop waiting, though the agent may still be processing.
        // Acceptable trade-off: a late reply lands in the effect-acp
        // client with no listener and is discarded.
        type TurnOutcome =
          | { readonly kind: "natural"; readonly result: EffectAcpSchema.PromptResponse }
          | { readonly kind: "synthetic-cancel" };

        // `raceFirst` (as opposed to `race`) returns whichever side
        // completes first, success OR failure. This matters because
        // stopSession closes the session scope — the prompt Effect
        // then fails with a transport error, and we need the race to
        // propagate that failure rather than wait for cancelSignal
        // (which may never fire).
        const outcome: TurnOutcome = yield* ctx.acp.prompt({ prompt: promptParts }).pipe(
          Effect.mapError((error) =>
            mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
          ),
          Effect.map((result): TurnOutcome => ({ kind: "natural", result })),
          Effect.raceFirst(
            Deferred.await(cancelSignal).pipe(
              Effect.map((): TurnOutcome => ({ kind: "synthetic-cancel" })),
            ),
          ),
        );

        ctx.cancelSignal = undefined;

        if (outcome.kind === "synthetic-cancel") {
          if (config.afterTurnSettled) {
            yield* config.afterTurnSettled({
              ctx,
              turnId,
              stopReason: "cancelled",
            });
          }

          ctx.turns.push({ id: turnId, items: [{ prompt: promptParts }] });
          ctx.session = {
            ...ctx.session,
            activeTurnId: turnId,
            updatedAt: yield* nowIso,
            ...(turnModel !== undefined ? { model: turnModel } : {}),
          };

          yield* offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId,
            payload: {
              state: "cancelled",
              stopReason: "cancelled",
            },
          });

          return {
            threadId: input.threadId,
            turnId,
            resumeCursor: ctx.session.resumeCursor,
          };
        }

        // Natural branch: race winner provides the real result.
        const result = outcome.result;

        if (config.afterTurnSettled) {
          yield* config.afterTurnSettled({
            ctx,
            turnId,
            stopReason: result.stopReason,
          });
        }

        ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, result }] });
        ctx.session = {
          ...ctx.session,
          activeTurnId: turnId,
          updatedAt: yield* nowIso,
          ...(turnModel !== undefined ? { model: turnModel } : {}),
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

    const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);

        // Fire the cancel notification under a bounded timeout so a
        // hung child process doesn't keep us waiting on stdin. Log at
        // warn if anything goes wrong — still non-fatal for the caller.
        yield* ctx.acp.cancel.pipe(
          Effect.mapError((error) =>
            mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", error),
          ),
          Effect.timeout(acpCancelTimeout),
          Effect.tapError((error) =>
            Effect.logWarning("ACP cancel notification failed or timed out", {
              threadId,
              error: error instanceof Error ? error.message : String(error),
            }),
          ),
          Effect.ignore,
        );

        // If sendTurn is currently awaiting a prompt reply, schedule a
        // grace timer: after `syntheticCancelGrace`, if the prompt
        // hasn't already been resolved, fire the cancelSignal so
        // sendTurn's raceFirst unblocks and synthesizes a cancelled
        // turn.completed event. This is the whole reason the stop
        // button actually stops — without it, a slow agent
        // (most commonly Gemini CLI finishing a long tool call) leaves
        // the UI spinning indefinitely. The timer is forked into the
        // session scope so it outlives this interruptTurn call; if the
        // prompt completes naturally first, the raceFirst has already
        // won with the natural result and the later Deferred.succeed
        // is a harmless no-op.
        const cancelSignal = ctx.cancelSignal;
        if (cancelSignal) {
          yield* Effect.sleep(syntheticCancelGrace).pipe(
            Effect.andThen(Deferred.succeed(cancelSignal, undefined).pipe(Effect.asVoid)),
            Effect.forkIn(ctx.scope),
            Effect.asVoid,
          );
        }
      });

    const respondToRequest: ProviderAdapterShape<ProviderAdapterError>["respondToRequest"] = (
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

    const respondToUserInput: ProviderAdapterShape<ProviderAdapterError>["respondToUserInput"] = (
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

    const readThread: ProviderAdapterShape<ProviderAdapterError>["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns } satisfies ProviderThreadSnapshot;
      });

    const rollbackThread: ProviderAdapterShape<ProviderAdapterError>["rollbackThread"] = (
      threadId,
      numTurns,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        if (numTurns > ctx.turns.length) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: `Cannot roll back ${numTurns} turn(s); thread only has ${ctx.turns.length}.`,
          });
        }
        const nextLength = Math.max(0, ctx.turns.length - numTurns);
        ctx.turns.splice(nextLength);
        if (config.afterRollback) {
          yield* config.afterRollback({ ctx, numTurns });
        }
        return { threadId, turns: ctx.turns } satisfies ProviderThreadSnapshot;
      });

    const stopSession: ProviderAdapterShape<ProviderAdapterError>["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: ProviderAdapterShape<ProviderAdapterError>["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: ProviderAdapterShape<ProviderAdapterError>["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    const stopAll: ProviderAdapterShape<ProviderAdapterError>["stopAll"] = () =>
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
      capabilities: config.capabilities,
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
    } satisfies ProviderAdapterShape<ProviderAdapterError> & { readonly provider: TProvider };
  });
}
