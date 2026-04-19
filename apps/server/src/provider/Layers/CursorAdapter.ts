/**
 * CursorAdapterLive — Cursor CLI (`agent acp`) via ACP.
 *
 * Built on top of `AcpAdapterBase`, which owns the shared session map,
 * thread-lock map, pubsub, permission wiring, notification-fiber loop,
 * and all the generic shape methods. This file only supplies the
 * Cursor-specific hooks: runtime construction, Cursor ACP extensions
 * (ask_question / create_plan / update_todos), mode/model resolution
 * through `setConfigOption`, and resume-cursor shape.
 *
 * @module CursorAdapterLive
 */
import * as nodePath from "node:path";

import {
  ApprovalRequestId,
  type CursorModelOptions,
  type ModelSelection,
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  type ProviderRuntimeEvent,
  RuntimeRequestId,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import { Deferred, Effect, Layer } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderAdapterProcessError, type ProviderAdapterError } from "../Errors.ts";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import {
  findModeByAliases,
  isPlanMode as baseIsPlanMode,
  makeAcpAdapter,
  type AcpAdapterLiveOptions,
  type BaseAcpSessionContext,
  type ExtensionHandlerContext,
} from "../acp/AcpAdapterBase.ts";
import { type AcpSessionMode, type AcpSessionModeState } from "../acp/AcpRuntimeModel.ts";
import { type AcpSessionRuntimeShape } from "../acp/AcpSessionRuntime.ts";
import { applyCursorAcpModelSelection, makeCursorAcpRuntime } from "../acp/CursorAcpSupport.ts";
import {
  CursorAskQuestionRequest,
  CursorCreatePlanRequest,
  CursorUpdateTodosRequest,
  extractAskQuestions,
  extractPlanMarkdown,
  extractTodosAsPlan,
} from "../acp/CursorAcpExtension.ts";
import { CursorAdapter, type CursorAdapterShape } from "../Services/CursorAdapter.ts";
import { resolveCursorAcpBaseModelId } from "./CursorProvider.ts";

const PROVIDER = "cursor" as const;
const CURSOR_RESUME_VERSION = 1 as const;
const ACP_PLAN_MODE_ALIASES = ["plan", "architect"];
const ACP_IMPLEMENT_MODE_ALIASES = ["code", "agent", "default", "chat", "implement"];
const ACP_APPROVAL_MODE_ALIASES = ["ask"];

export type { AcpAdapterLiveOptions as CursorAdapterLiveOptions };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCursorResume(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== CURSOR_RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim() };
}

function resolveRequestedCursorModeId(input: {
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly modeState: AcpSessionModeState | undefined;
}): string | undefined {
  const modeState = input.modeState;
  if (!modeState) return undefined;

  if (input.interactionMode === "plan") {
    return findModeByAliases(modeState.availableModes, ACP_PLAN_MODE_ALIASES)?.id;
  }
  const nonPlanFallback = (mode: AcpSessionMode) => !baseIsPlanMode(mode, ACP_PLAN_MODE_ALIASES);

  if (input.runtimeMode === "approval-required") {
    return (
      findModeByAliases(modeState.availableModes, ACP_APPROVAL_MODE_ALIASES)?.id ??
      findModeByAliases(modeState.availableModes, ACP_IMPLEMENT_MODE_ALIASES)?.id ??
      modeState.availableModes.find(nonPlanFallback)?.id ??
      modeState.currentModeId
    );
  }
  return (
    findModeByAliases(modeState.availableModes, ACP_IMPLEMENT_MODE_ALIASES)?.id ??
    findModeByAliases(modeState.availableModes, ACP_APPROVAL_MODE_ALIASES)?.id ??
    modeState.availableModes.find(nonPlanFallback)?.id ??
    modeState.currentModeId
  );
}

function applyRequestedSessionConfiguration(input: {
  readonly runtime: AcpSessionRuntimeShape;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly modelSelection:
    | {
        readonly model: string;
        readonly options?: CursorModelOptions | null | undefined;
      }
    | undefined;
  readonly mapError: (context: {
    readonly cause: import("effect-acp/errors").AcpError;
    readonly method: "session/set_config_option" | "session/set_mode";
  }) => ProviderAdapterError;
}): Effect.Effect<void, ProviderAdapterError> {
  return Effect.gen(function* () {
    if (input.modelSelection) {
      yield* applyCursorAcpModelSelection({
        runtime: input.runtime,
        model: input.modelSelection.model,
        modelOptions: input.modelSelection.options,
        mapError: ({ cause }) =>
          input.mapError({
            cause,
            method: "session/set_config_option",
          }),
      });
    }

    const requestedModeId = resolveRequestedCursorModeId({
      interactionMode: input.interactionMode,
      runtimeMode: input.runtimeMode,
      modeState: yield* input.runtime.getModeState,
    });
    if (!requestedModeId) return;

    yield* input.runtime.setMode(requestedModeId).pipe(
      Effect.mapError((cause) =>
        input.mapError({
          cause,
          method: "session/set_mode",
        }),
      ),
    );
  });
}

function registerCursorExtensionHandlers(context: ExtensionHandlerContext): Effect.Effect<void> {
  const {
    acp,
    threadId,
    pendingUserInputs,
    offerRuntimeEvent,
    makeEventStamp,
    logNative,
    emitPlanUpdate,
    getActiveTurnId,
  } = context;
  return Effect.gen(function* () {
    yield* acp.handleExtRequest("cursor/ask_question", CursorAskQuestionRequest, (params) =>
      Effect.gen(function* () {
        yield* logNative("cursor/ask_question", params, "acp.cursor.extension");
        const requestId = ApprovalRequestId.make(crypto.randomUUID());
        const runtimeRequestId = RuntimeRequestId.make(requestId);
        const answers = yield* Deferred.make<Record<string, unknown>>();
        pendingUserInputs.set(requestId, { answers });
        yield* offerRuntimeEvent({
          type: "user-input.requested",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId,
          turnId: getActiveTurnId(),
          requestId: runtimeRequestId,
          payload: { questions: extractAskQuestions(params) },
          raw: {
            source: "acp.cursor.extension",
            method: "cursor/ask_question",
            payload: params,
          },
        });
        const resolved = yield* Deferred.await(answers);
        pendingUserInputs.delete(requestId);
        yield* offerRuntimeEvent({
          type: "user-input.resolved",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId,
          turnId: getActiveTurnId(),
          requestId: runtimeRequestId,
          payload: { answers: resolved },
        });
        return { answers: resolved };
      }),
    );

    yield* acp.handleExtRequest("cursor/create_plan", CursorCreatePlanRequest, (params) =>
      Effect.gen(function* () {
        yield* logNative("cursor/create_plan", params, "acp.cursor.extension");
        yield* offerRuntimeEvent({
          type: "turn.proposed.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId,
          turnId: getActiveTurnId(),
          payload: { planMarkdown: extractPlanMarkdown(params) },
          raw: {
            source: "acp.cursor.extension",
            method: "cursor/create_plan",
            payload: params,
          },
        });
        return { accepted: true } as const;
      }),
    );

    yield* acp.handleExtNotification("cursor/update_todos", CursorUpdateTodosRequest, (params) =>
      Effect.gen(function* () {
        yield* logNative("cursor/update_todos", params, "acp.cursor.extension");
        yield* emitPlanUpdate(
          extractTodosAsPlan(params),
          params,
          "acp.cursor.extension",
          "cursor/update_todos",
        );
      }),
    );
  });
}

function makeCursorAdapterEffect(options?: AcpAdapterLiveOptions) {
  return Effect.gen(function* () {
    const serverSettingsService = yield* ServerSettingsService;

    const base = yield* makeAcpAdapter<"cursor", Record<string, never>>(
      {
        provider: PROVIDER,
        capabilities: { sessionModelSwitch: "in-session" },

        parseResumeCursor: parseCursorResume,
        buildResumeCursor: (sessionId) => ({
          schemaVersion: CURSOR_RESUME_VERSION,
          sessionId,
        }),

        resolveSessionModel: (modelSelection: ModelSelection | undefined) => {
          if (modelSelection?.provider !== "cursor") return undefined;
          return resolveCursorAcpBaseModelId(modelSelection.model);
        },

        buildSession: ({ startInput, cwd, resumeSessionId, nativeLoggers }) =>
          Effect.gen(function* () {
            const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
            const cursorSettings = yield* serverSettingsService.getSettings.pipe(
              Effect.map((settings) => settings.providers.cursor),
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
            const acp = yield* makeCursorAcpRuntime({
              cursorSettings,
              childProcessSpawner,
              cwd: resolvedCwd,
              ...(resumeSessionId ? { resumeSessionId } : {}),
              clientInfo: { name: "t3-code", version: "0.0.0" },
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
            return { acp, extra: {} as Record<string, never> };
          }),

        registerExtensionHandlers: registerCursorExtensionHandlers,

        applySessionConfiguration: ({
          acp,
          runtimeMode,
          interactionMode,
          modelSelection,
          threadId,
        }) => {
          const cursorSelection =
            modelSelection?.provider === "cursor"
              ? {
                  model: modelSelection.model,
                  options: modelSelection.options,
                }
              : undefined;
          return applyRequestedSessionConfiguration({
            runtime: acp,
            runtimeMode,
            interactionMode,
            modelSelection: cursorSelection,
            mapError: ({ cause, method }) =>
              mapAcpToAdapterError(PROVIDER, threadId, method, cause),
          });
        },
      },
      options,
    );

    return base satisfies CursorAdapterShape;
  });
}

export const CursorAdapterLive = Layer.effect(CursorAdapter, makeCursorAdapterEffect());

export function makeCursorAdapterLive(opts?: AcpAdapterLiveOptions) {
  return Layer.effect(CursorAdapter, makeCursorAdapterEffect(opts));
}

/** @deprecated Internal re-export for test helpers — prefer CursorAdapterShape. */
export type CursorSessionContextInternal = BaseAcpSessionContext<Record<string, never>>;

/** Utility for tests asserting that a decision matches a ProviderApprovalDecision. */
export type CursorApprovalDecision = ProviderApprovalDecision;
/** Utility for tests comparing runtime events. */
export type CursorRuntimeEvent = ProviderRuntimeEvent;

// Re-export for any test that still uses these types via the CursorAdapter module.
export type { ThreadId };
