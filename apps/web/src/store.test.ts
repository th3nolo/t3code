import type {
  ProviderCoreEvent,
  ProviderSession,
  ProviderStreamFrame,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { type AppState, reducer } from "./store";
import type { Thread } from "./types";

function makeSession(overrides: Partial<ProviderSession> = {}): ProviderSession {
  return {
    sessionId: "sess-1",
    provider: "codex",
    status: "ready",
    createdAt: "2026-02-09T00:00:00.000Z",
    updatedAt: "2026-02-09T00:00:00.000Z",
    ...overrides,
  };
}

function makeEventFrame(
  event: ProviderCoreEvent,
  overrides: Partial<Pick<ProviderStreamFrame, "seq" | "at">> = {},
): ProviderStreamFrame {
  return {
    kind: "event",
    seq: 1,
    at: "2026-02-09T00:00:01.000Z",
    data: event,
    ...overrides,
  };
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "thread-local-1",
    codexThreadId: null,
    projectId: "project-1",
    title: "Thread",
    model: "gpt-5.3-codex",
    session: makeSession(),
    messages: [],
    events: [],
    error: null,
    createdAt: "2026-02-09T00:00:00.000Z",
    ...overrides,
  };
}

function makeState(thread: Thread): AppState {
  return {
    projects: [
      {
        id: "project-1",
        name: "Project",
        cwd: "/tmp/project",
        model: "gpt-5.3-codex",
        expanded: true,
      },
    ],
    threads: [thread],
    activeThreadId: thread.id,
    runtimeMode: "full-access",
    diffOpen: false,
    lastProviderSeq: 0,
  };
}

describe("store reducer stream integration", () => {
  it("stores codexThreadId from UPDATE_SESSION", () => {
    const state = makeState(
      makeThread({
        session: null,
      }),
    );
    const next = reducer(state, {
      type: "UPDATE_SESSION",
      threadId: "thread-local-1",
      session: makeSession({ threadId: "thr_123" }),
    });

    expect(next.threads[0]?.codexThreadId).toBe("thr_123");
  });

  it("backfills codexThreadId from session.updated stream events", () => {
    const state = makeState(makeThread({ codexThreadId: null }));
    const next = reducer(state, {
      type: "APPLY_STREAM_FRAME",
      frame: makeEventFrame({
        type: "session.updated",
        session: makeSession({
          threadId: "thr_backfilled",
          updatedAt: "2026-02-09T00:00:01.000Z",
        }),
      }),
      activeAssistantMessageRef: { current: null },
    });

    expect(next.threads[0]?.codexThreadId).toBe("thr_backfilled");
    expect(next.lastProviderSeq).toBe(1);
  });

  it("ignores events from a foreign thread within the same session", () => {
    const state = makeState(makeThread({ codexThreadId: "thr_expected" }));
    const next = reducer(state, {
      type: "APPLY_STREAM_FRAME",
      frame: makeEventFrame({
        type: "turn.started",
        sessionId: "sess-1",
        threadId: "thr_unexpected",
        turnId: "turn-1",
        startedAt: "2026-02-09T00:00:01.000Z",
      }),
      activeAssistantMessageRef: { current: null },
    });

    expect(next.threads[0]).toEqual(state.threads[0]);
    expect(next.lastProviderSeq).toBe(1);
  });

  it("always applies session.updated even when thread id changes", () => {
    const state = makeState(makeThread({ codexThreadId: "thr_old" }));
    const next = reducer(state, {
      type: "APPLY_STREAM_FRAME",
      frame: makeEventFrame({
        type: "session.updated",
        session: makeSession({
          threadId: "thr_new",
          updatedAt: "2026-02-09T00:00:01.000Z",
        }),
      }),
      activeAssistantMessageRef: { current: null },
    });

    expect(next.threads[0]?.codexThreadId).toBe("thr_new");
    expect(next.threads[0]?.session?.threadId).toBe("thr_new");
  });

  it("applies snapshot frames as authoritative baseline", () => {
    const state = makeState(
      makeThread({
        codexThreadId: "thr_old",
        session: makeSession({
          threadId: "thr_old",
          status: "running",
          activeTurnId: "turn_old",
        }),
      }),
    );

    const next = reducer(state, {
      type: "APPLY_STREAM_FRAME",
      frame: {
        kind: "snapshot",
        seq: 10,
        at: "2026-02-09T00:00:10.000Z",
        data: {
          sessions: [
            makeSession({
              threadId: "thr_new",
              status: "running",
              activeTurnId: "turn_new",
              updatedAt: "2026-02-09T00:00:10.000Z",
            }),
          ],
          activeTurns: [
            {
              sessionId: "sess-1",
              threadId: "thr_new",
              turnId: "turn_new",
              startedAt: "2026-02-09T00:00:09.000Z",
            },
          ],
          activeMessages: [
            {
              sessionId: "sess-1",
              threadId: "thr_new",
              turnId: "turn_new",
              messageId: "msg-1",
              role: "assistant",
              text: "streaming",
              startedAt: "2026-02-09T00:00:09.100Z",
              updatedAt: "2026-02-09T00:00:09.500Z",
            },
          ],
          pendingApprovals: [
            {
              sessionId: "sess-1",
              threadId: "thr_new",
              turnId: "turn_new",
              approvalId: "approval-1",
              approvalKind: "command",
              title: "Command approval requested",
              detail: "git status --short",
              requestedAt: "2026-02-09T00:00:09.200Z",
            },
          ],
        },
      },
      activeAssistantMessageRef: { current: null },
    });

    expect(next.lastProviderSeq).toBe(10);
    expect(next.threads[0]?.codexThreadId).toBe("thr_new");
    expect(next.threads[0]?.latestTurnId).toBe("turn_new");
    expect(next.threads[0]?.messages.at(-1)?.id).toBe("msg-1");
    expect(next.threads[0]?.messages.at(-1)?.streaming).toBe(true);
    expect(next.threads[0]?.events[0]?.event.type).toBe("approval.requested");
  });

  it("reconciles project ids by cwd when syncing backend projects", () => {
    const state: AppState = {
      projects: [
        {
          id: "project-old-a",
          name: "A",
          cwd: "/tmp/a",
          model: "gpt-5.3-codex",
          expanded: false,
        },
        {
          id: "project-old-b",
          name: "B",
          cwd: "/tmp/b",
          model: "gpt-5.3-codex",
          expanded: true,
        },
      ],
      threads: [
        makeThread({
          id: "thread-a",
          projectId: "project-old-a",
        }),
        makeThread({
          id: "thread-b",
          projectId: "project-old-b",
        }),
      ],
      activeThreadId: "thread-b",
      runtimeMode: "full-access",
      diffOpen: false,
      lastProviderSeq: 0,
    };

    const next = reducer(state, {
      type: "SYNC_PROJECTS",
      projects: [
        {
          id: "project-new-a",
          name: "A",
          cwd: "/tmp/a",
          model: "gpt-5.3-codex",
          expanded: true,
        },
      ],
    });

    expect(next.projects).toHaveLength(1);
    expect(next.projects[0]?.id).toBe("project-new-a");
    // Preserve existing project UI preferences by cwd
    expect(next.projects[0]?.expanded).toBe(false);
    expect(next.threads).toHaveLength(1);
    expect(next.threads[0]?.id).toBe("thread-a");
    expect(next.threads[0]?.projectId).toBe("project-new-a");
    expect(next.activeThreadId).toBe("thread-a");
  });
});
