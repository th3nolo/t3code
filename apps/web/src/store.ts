import {
  type Dispatch,
  type ReactNode,
  createContext,
  createElement,
  useContext,
  useEffect,
  useReducer,
} from "react";
import type {
  ProviderCoreEvent,
  ProviderSession,
  ProviderSnapshot,
  ProviderStreamFrame,
} from "@t3tools/contracts";

import { resolveModelSlug } from "./model-logic";
import { hydratePersistedState, toPersistedState } from "./persistenceSchema";
import { applyEventToMessages, evolveSession } from "./session-logic";
import {
  DEFAULT_RUNTIME_MODE,
  type Project,
  type RuntimeMode,
  type Thread,
  type ThreadEvent,
} from "./types";

// ── Actions ──────────────────────────────────────────────────────────

type Action =
  | { type: "ADD_PROJECT"; project: Project }
  | { type: "SYNC_PROJECTS"; projects: Project[] }
  | { type: "TOGGLE_PROJECT"; projectId: string }
  | { type: "ADD_THREAD"; thread: Thread }
  | { type: "SET_ACTIVE_THREAD"; threadId: string }
  | { type: "TOGGLE_DIFF" }
  | {
      type: "APPLY_STREAM_FRAME";
      frame: ProviderStreamFrame;
      activeAssistantMessageRef: { current: string | null };
    }
  | { type: "UPDATE_SESSION"; threadId: string; session: ProviderSession }
  | { type: "PUSH_USER_MESSAGE"; threadId: string; id: string; text: string }
  | { type: "SET_ERROR"; threadId: string; error: string | null }
  | { type: "SET_THREAD_TITLE"; threadId: string; title: string }
  | { type: "SET_THREAD_MODEL"; threadId: string; model: string }
  | { type: "SET_RUNTIME_MODE"; mode: RuntimeMode };

// ── State ────────────────────────────────────────────────────────────

export interface AppState {
  projects: Project[];
  threads: Thread[];
  activeThreadId: string | null;
  runtimeMode: RuntimeMode;
  diffOpen: boolean;
  lastProviderSeq: number;
}

const PERSISTED_STATE_KEY = "t3code:renderer-state:v4";
const LEGACY_PERSISTED_STATE_KEYS = [
  "t3code:renderer-state:v3",
  "codething:renderer-state:v4",
  "codething:renderer-state:v3",
  "codething:renderer-state:v2",
  "codething:renderer-state:v1",
] as const;

const initialState: AppState = {
  projects: [],
  threads: [],
  activeThreadId: null,
  runtimeMode: DEFAULT_RUNTIME_MODE,
  diffOpen: false,
  lastProviderSeq: 0,
};

// ── Helpers ──────────────────────────────────────────────────────────

function readPersistedState(): AppState {
  if (typeof window === "undefined") return initialState;

  try {
    const rawCurrent = window.localStorage.getItem(PERSISTED_STATE_KEY);
    const [legacyV3Key, legacyV2Key, legacyV1Key] = LEGACY_PERSISTED_STATE_KEYS;
    const rawLegacyV3 = window.localStorage.getItem(legacyV3Key);
    const rawLegacyV2 = window.localStorage.getItem(legacyV2Key);
    const rawLegacyV1 = window.localStorage.getItem(legacyV1Key);
    const raw = rawCurrent ?? rawLegacyV3 ?? rawLegacyV2 ?? rawLegacyV1;
    if (!raw) return initialState;
    const hydrated = hydratePersistedState(
      raw,
      !rawCurrent && !rawLegacyV3 && !rawLegacyV2 && Boolean(rawLegacyV1),
    );
    if (!hydrated) return initialState;

    return { ...hydrated, diffOpen: false, lastProviderSeq: 0 };
  } catch {
    return initialState;
  }
}

function persistState(state: AppState): void {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(PERSISTED_STATE_KEY, JSON.stringify(toPersistedState(state)));
    for (const legacyKey of LEGACY_PERSISTED_STATE_KEYS) {
      window.localStorage.removeItem(legacyKey);
    }
  } catch {
    // Ignore quota/storage errors to avoid breaking chat UX.
  }
}

function updateThread(
  threads: Thread[],
  threadId: string,
  updater: (t: Thread) => Thread,
): Thread[] {
  return threads.map((t) => (t.id === threadId ? updater(t) : t));
}

function findThreadBySessionId(threads: Thread[], sessionId: string): Thread | undefined {
  return threads.find((t) => t.session?.sessionId === sessionId);
}

function durationMs(startIso: string, endIso: string): number | undefined {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
    return undefined;
  }

  return end - start;
}

function eventSessionId(event: ProviderCoreEvent): string | undefined {
  if (event.type === "session.updated") {
    return event.session.sessionId;
  }

  if (event.type === "debug.raw") {
    return event.sessionId;
  }

  return event.sessionId;
}

function eventThreadId(event: ProviderCoreEvent): string | undefined {
  if (event.type === "session.updated") {
    return event.session.threadId;
  }

  if (event.type === "turn.started") {
    return event.threadId;
  }

  if (event.type === "turn.completed") {
    return event.threadId;
  }

  if (event.type === "message.delta") {
    return event.threadId;
  }

  if (event.type === "message.completed") {
    return event.threadId;
  }

  if (event.type === "approval.requested") {
    return event.threadId;
  }

  if (event.type === "activity") {
    return event.threadId;
  }

  if (event.type === "error") {
    return event.threadId;
  }

  return undefined;
}

function shouldIgnoreForeignThreadEvent(thread: Thread, event: ProviderCoreEvent): boolean {
  if (event.type === "session.updated") {
    // Session snapshots are authoritative for thread identity and should never
    // be blocked by stale local thread bindings.
    return false;
  }

  const emittedThreadId = eventThreadId(event);
  if (!emittedThreadId) {
    return false;
  }

  const expectedThreadId = thread.session?.threadId ?? thread.codexThreadId;
  if (!expectedThreadId || emittedThreadId === expectedThreadId) {
    return false;
  }

  return true;
}

function updateTurnFields(
  thread: Thread,
  event: ProviderCoreEvent,
): Partial<Thread> {
  if (event.type === "turn.started") {
    return {
      latestTurnId: event.turnId,
      latestTurnStartedAt: event.startedAt,
      latestTurnCompletedAt: undefined,
      latestTurnDurationMs: undefined,
    };
  }

  if (event.type === "turn.completed") {
    const startedAt =
      event.turnId === thread.latestTurnId
        ? thread.latestTurnStartedAt
        : undefined;
    const elapsed =
      event.durationMs ??
      (startedAt && startedAt.length > 0
        ? durationMs(startedAt, event.completedAt)
        : undefined);

    return {
      latestTurnId: event.turnId,
      latestTurnCompletedAt: event.completedAt,
      latestTurnDurationMs: elapsed,
    };
  }

  return {};
}

function shouldPersistThreadEvent(event: ProviderCoreEvent): boolean {
  if (event.type === "message.delta") {
    return false;
  }

  if (event.type === "debug.raw") {
    return false;
  }

  if (event.type === "session.updated") {
    return event.session.status === "error" || event.session.status === "closed";
  }

  return true;
}

function appendThreadEvent(
  events: ThreadEvent[],
  eventRecord: ThreadEvent,
): ThreadEvent[] {
  return [eventRecord, ...events].slice(0, 2_000);
}

function approvalEventsFromSnapshot(
  approvals: ProviderSnapshot["pendingApprovals"],
  seq: number,
): ThreadEvent[] {
  return approvals
    .map((approval) => ({
      seq,
      at: approval.requestedAt,
      event: {
        type: "approval.requested",
        sessionId: approval.sessionId,
        ...(approval.threadId ? { threadId: approval.threadId } : {}),
        ...(approval.turnId ? { turnId: approval.turnId } : {}),
        approvalId: approval.approvalId,
        approvalKind: approval.approvalKind,
        title: approval.title,
        ...(approval.detail ? { detail: approval.detail } : {}),
        ...(approval.payload !== undefined ? { payload: approval.payload } : {}),
        ...(approval.timeoutAt ? { timeoutAt: approval.timeoutAt } : {}),
        requestedAt: approval.requestedAt,
      } satisfies ProviderCoreEvent,
    }))
    .toSorted((left, right) => Date.parse(right.at) - Date.parse(left.at));
}

function applySnapshotToThread(
  thread: Thread,
  snapshot: ProviderSnapshot,
  seq: number,
): Thread {
  if (!thread.session) {
    return thread;
  }

  const sessionId = thread.session.sessionId;
  const snapshotSession = snapshot.sessions.find((session) => session.sessionId === sessionId);
  if (!snapshotSession) {
    return {
      ...thread,
      session: null,
      messages: thread.messages.map((message) => ({
        ...message,
        streaming: false,
      })),
      events: [],
      error: null,
      latestTurnId: undefined,
      latestTurnStartedAt: undefined,
      latestTurnCompletedAt: undefined,
      latestTurnDurationMs: undefined,
    };
  }

  const activeTurns = snapshot.activeTurns
    .filter((turn) => turn.sessionId === sessionId)
    .toSorted((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));
  const activeTurn = activeTurns[0];

  const activeMessages = snapshot.activeMessages
    .filter((message) => message.sessionId === sessionId)
    .toSorted((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt));
  const activeMessageIds = new Set(activeMessages.map((message) => message.messageId));

  const keptMessages = thread.messages
    .filter((message) => !message.streaming)
    .filter((message) => !activeMessageIds.has(message.id));

  const hydratedMessages = activeMessages.map((message) => ({
    id: message.messageId,
    role: "assistant" as const,
    text: message.text,
    createdAt: message.startedAt,
    streaming: true,
  }));

  const pendingApprovals = snapshot.pendingApprovals.filter(
    (approval) => approval.sessionId === sessionId,
  );

  return {
    ...thread,
    codexThreadId: snapshotSession.threadId ?? thread.codexThreadId,
    session: snapshotSession,
    messages: [...keptMessages, ...hydratedMessages],
    events: approvalEventsFromSnapshot(pendingApprovals, seq),
    error: snapshotSession.lastError ?? (snapshotSession.status === "error" ? thread.error : null),
    latestTurnId: activeTurn?.turnId,
    latestTurnStartedAt: activeTurn?.startedAt,
    latestTurnCompletedAt: undefined,
    latestTurnDurationMs: undefined,
  };
}

function applySnapshotToThreads(
  threads: Thread[],
  snapshot: ProviderSnapshot,
  seq: number,
): Thread[] {
  return threads.map((thread) => applySnapshotToThread(thread, snapshot, seq));
}

// ── Reducer ──────────────────────────────────────────────────────────

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "ADD_PROJECT":
      if (state.projects.some((project) => project.cwd === action.project.cwd)) {
        return state;
      }
      return {
        ...state,
        projects: [
          ...state.projects,
          {
            ...action.project,
            model: resolveModelSlug(action.project.model),
          },
        ],
      };

    case "SYNC_PROJECTS": {
      const previousByCwd = new Map(
        state.projects.map((project) => [project.cwd, project] as const),
      );
      const nextProjects = action.projects.map((project) => {
        const previous = previousByCwd.get(project.cwd);
        return {
          ...project,
          model: resolveModelSlug(previous?.model ?? project.model),
          expanded: previous?.expanded ?? project.expanded,
        };
      });
      const previousProjectById = new Map(
        state.projects.map((project) => [project.id, project] as const),
      );
      const nextProjectIdByCwd = new Map(
        nextProjects.map((project) => [project.cwd, project.id] as const),
      );
      const nextThreads = state.threads
        .map((thread) => {
          const previousProject = previousProjectById.get(thread.projectId);
          if (!previousProject) return null;
          const mappedProjectId = nextProjectIdByCwd.get(previousProject.cwd);
          if (!mappedProjectId) return null;
          return {
            ...thread,
            projectId: mappedProjectId,
          };
        })
        .filter((thread): thread is Thread => thread !== null);
      const activeThreadId = nextThreads.some((thread) => thread.id === state.activeThreadId)
        ? state.activeThreadId
        : (nextThreads[0]?.id ?? null);

      return {
        ...state,
        projects: nextProjects,
        threads: nextThreads,
        activeThreadId,
      };
    }

    case "TOGGLE_PROJECT":
      return {
        ...state,
        projects: state.projects.map((p) =>
          p.id === action.projectId ? { ...p, expanded: !p.expanded } : p,
        ),
      };

    case "ADD_THREAD":
      return {
        ...state,
        threads: [
          ...state.threads,
          {
            ...action.thread,
            model: resolveModelSlug(action.thread.model),
          },
        ],
        activeThreadId: action.thread.id,
      };

    case "SET_ACTIVE_THREAD":
      return { ...state, activeThreadId: action.threadId };

    case "TOGGLE_DIFF":
      return { ...state, diffOpen: !state.diffOpen };

    case "APPLY_STREAM_FRAME": {
      const { frame, activeAssistantMessageRef } = action;
      if (frame.seq <= state.lastProviderSeq) {
        return state;
      }

      if (frame.kind === "gap") {
        return {
          ...state,
          lastProviderSeq: frame.seq,
        };
      }

      if (frame.kind === "snapshot") {
        return {
          ...state,
          threads: applySnapshotToThreads(state.threads, frame.data, frame.seq),
          lastProviderSeq: frame.seq,
        };
      }

      const sessionId = eventSessionId(frame.data);
      if (!sessionId) {
        return {
          ...state,
          lastProviderSeq: frame.seq,
        };
      }

      const target = findThreadBySessionId(state.threads, sessionId);
      if (!target) {
        return {
          ...state,
          lastProviderSeq: frame.seq,
        };
      }

      if (shouldIgnoreForeignThreadEvent(target, frame.data)) {
        return {
          ...state,
          lastProviderSeq: frame.seq,
        };
      }

      return {
        ...state,
        lastProviderSeq: frame.seq,
        threads: updateThread(state.threads, target.id, (thread) => {
          const nextSession =
            frame.data.type === "session.updated"
              ? frame.data.session
              : thread.session
                ? evolveSession(thread.session, frame.data, frame.at)
                : thread.session;

          return {
            ...thread,
            codexThreadId: nextSession?.threadId ?? thread.codexThreadId,
            session: nextSession,
            messages: applyEventToMessages(
              thread.messages,
              frame.data,
              frame.at,
              activeAssistantMessageRef,
            ),
            events: shouldPersistThreadEvent(frame.data)
              ? appendThreadEvent(thread.events, {
                  seq: frame.seq,
                  at: frame.at,
                  event: frame.data,
                })
              : thread.events,
            error:
              frame.data.type === "error"
                ? frame.data.message
                : frame.data.type === "turn.completed" && frame.data.outcome === "failed"
                  ? (frame.data.error ?? thread.error)
                  : frame.data.type === "session.updated" && frame.data.session.status === "error"
                    ? (frame.data.session.lastError ?? thread.error)
                    : thread.error,
            ...updateTurnFields(thread, frame.data),
          };
        }),
      };
    }

    case "UPDATE_SESSION":
      return {
        ...state,
        threads: updateThread(state.threads, action.threadId, (t) => ({
          ...t,
          session: action.session,
          codexThreadId: action.session.threadId ?? t.codexThreadId,
          events: [],
          error: null,
          latestTurnId: undefined,
          latestTurnStartedAt: undefined,
          latestTurnCompletedAt: undefined,
          latestTurnDurationMs: undefined,
        })),
      };

    case "PUSH_USER_MESSAGE":
      return {
        ...state,
        threads: updateThread(state.threads, action.threadId, (t) => ({
          ...t,
          messages: [
            ...t.messages,
            {
              id: action.id,
              role: "user" as const,
              text: action.text,
              createdAt: new Date().toISOString(),
              streaming: false,
            },
          ],
        })),
      };

    case "SET_ERROR":
      return {
        ...state,
        threads: updateThread(state.threads, action.threadId, (t) => ({
          ...t,
          error: action.error,
        })),
      };

    case "SET_THREAD_TITLE":
      return {
        ...state,
        threads: updateThread(state.threads, action.threadId, (t) => ({
          ...t,
          title: action.title,
        })),
      };

    case "SET_THREAD_MODEL":
      return {
        ...state,
        threads: updateThread(state.threads, action.threadId, (t) => ({
          ...t,
          model: resolveModelSlug(action.model),
        })),
      };

    case "SET_RUNTIME_MODE":
      return {
        ...state,
        runtimeMode: action.mode,
      };

    default:
      return state;
  }
}

// ── Context ──────────────────────────────────────────────────────────

const StoreContext = createContext<{
  state: AppState;
  dispatch: Dispatch<Action>;
}>({ state: initialState, dispatch: () => {} });

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, readPersistedState);

  useEffect(() => {
    persistState(state);
  }, [state]);

  return createElement(StoreContext.Provider, { value: { state, dispatch } }, children);
}

export function useStore() {
  return useContext(StoreContext);
}
