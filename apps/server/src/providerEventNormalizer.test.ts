import type { CanonicalSessionState, ProviderRawEvent } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { ProviderEventNormalizer } from "./providerEventNormalizer";

function makeRawEvent(overrides: Partial<ProviderRawEvent> = {}): ProviderRawEvent {
  return {
    id: "raw-1",
    kind: "notification",
    provider: "codex",
    sessionId: "sess-1",
    createdAt: "2026-02-10T00:00:00.000Z",
    method: "turn/started",
    payload: {
      thread: { id: "thread-1" },
      turn: { id: "turn-1" },
    },
    ...overrides,
  };
}

function makeSession(overrides: Partial<CanonicalSessionState> = {}): CanonicalSessionState {
  return {
    sessionId: "sess-1",
    provider: "codex",
    status: "ready",
    createdAt: "2026-02-10T00:00:00.000Z",
    updatedAt: "2026-02-10T00:00:00.000Z",
    ...overrides,
  };
}

describe("ProviderEventNormalizer", () => {
  it("maps turn start notifications to canonical session and turn events", () => {
    const normalizer = new ProviderEventNormalizer();

    const normalized = normalizer.normalize(
      makeRawEvent({
        method: "turn/started",
      }),
      makeSession(),
    );

    expect(normalized).toHaveLength(2);
    expect(normalized[0]?.type).toBe("session.updated");
    expect(normalized[1]?.type).toBe("turn.started");
  });

  it("maps command approval requests and decision notifications", () => {
    const normalizer = new ProviderEventNormalizer();

    const requested = normalizer.normalize(
      makeRawEvent({
        kind: "request",
        method: "item/commandExecution/requestApproval",
        requestId: "approval-1",
        payload: {
          thread: { id: "thread-1" },
          turn: { id: "turn-1" },
          command: "git status --short",
        },
      }),
      makeSession(),
    );

    expect(requested.some((event) => event.type === "approval.requested")).toBe(true);

    const resolved = normalizer.normalize(
      makeRawEvent({
        kind: "notification",
        method: "item/requestApproval/decision",
        requestId: "approval-1",
        payload: {
          requestId: "approval-1",
          decision: "acceptForSession",
        },
      }),
      makeSession(),
    );

    const approvalResolved = resolved.find((event) => event.type === "approval.resolved");
    expect(approvalResolved).toBeDefined();
    if (!approvalResolved || approvalResolved.type !== "approval.resolved") {
      throw new Error("expected approval.resolved event");
    }
    expect(approvalResolved.decision).toBe("accept_for_session");
  });

  it("drops unmapped methods from the core stream", () => {
    const normalizer = new ProviderEventNormalizer();

    const normalized = normalizer.normalize(
      makeRawEvent({
        method: "item/reasoning/summaryPartAdded",
        payload: {
          text: "partial summary",
        },
      }),
      makeSession(),
    );

    expect(normalized).toHaveLength(0);
  });

  it("maps message delta events when payload uses msg/message fallback fields", () => {
    const normalizer = new ProviderEventNormalizer();

    const normalized = normalizer.normalize(
      makeRawEvent({
        method: "item/agentMessage/delta",
        threadId: undefined,
        turnId: undefined,
        itemId: undefined,
        payload: {
          msg: {
            id: "msg-1",
            thread_id: "thread-1",
            turn_id: "turn-1",
          },
          delta: "hello",
        },
      }),
      makeSession(),
    );

    const delta = normalized.find((event) => event.type === "message.delta");
    expect(delta).toBeDefined();
    if (!delta || delta.type !== "message.delta") {
      throw new Error("expected message.delta event");
    }

    expect(delta.messageId).toBe("msg-1");
    expect(delta.threadId).toBe("thread-1");
    expect(delta.turnId).toBe("turn-1");
    expect(delta.delta).toBe("hello");
  });

  it("maps assistant message completion with assistantMessage type aliases", () => {
    const normalizer = new ProviderEventNormalizer();

    const normalized = normalizer.normalize(
      makeRawEvent({
        method: "item/completed",
        itemId: "msg_abc",
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "msg_abc",
            type: "assistant_message",
            text: "done",
          },
        },
      }),
      makeSession(),
    );

    const completed = normalized.find((event) => event.type === "message.completed");
    expect(completed).toBeDefined();
    if (!completed || completed.type !== "message.completed") {
      throw new Error("expected message.completed event");
    }

    expect(completed.messageId).toBe("msg_abc");
    expect(completed.text).toBe("done");
  });

  it("creates debug.raw wrappers", () => {
    const normalizer = new ProviderEventNormalizer();
    const raw = makeRawEvent({ method: "item/reasoning/summaryPartAdded" });

    const debug = normalizer.toDebugRaw(raw);

    expect(debug.type).toBe("debug.raw");
    if (debug.type !== "debug.raw") {
      throw new Error("expected debug.raw event");
    }
    expect(debug.provider).toBe("codex");
    expect(debug.method).toBe("item/reasoning/summaryPartAdded");
  });
});
