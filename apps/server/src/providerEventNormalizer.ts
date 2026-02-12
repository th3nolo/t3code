import type {
  CanonicalSessionState,
  ProviderCoreEvent,
  ProviderRawEvent,
} from "@t3tools/contracts";

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeType(raw: string | undefined): string {
  if (!raw) return "";
  return raw.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function isAgentMessageType(raw: string | undefined): boolean {
  const normalized = normalizeType(raw);
  return normalized.includes("agentmessage") || normalized.includes("assistantmessage");
}

function readThreadId(event: ProviderRawEvent): string | undefined {
  if (event.threadId) return event.threadId;
  const payload = asObject(event.payload);
  const thread = asObject(payload?.thread);
  const message = asObject(payload?.message);
  const msg = asObject(payload?.msg);
  return (
    asString(payload?.threadId) ??
    asString(payload?.thread_id) ??
    asString(payload?.conversationId) ??
    asString(thread?.id) ??
    asString(message?.threadId) ??
    asString(message?.thread_id) ??
    asString(msg?.threadId) ??
    asString(msg?.thread_id)
  );
}

function readTurnId(event: ProviderRawEvent): string | undefined {
  if (event.turnId) return event.turnId;
  const payload = asObject(event.payload);
  const turn = asObject(payload?.turn);
  const message = asObject(payload?.message);
  const msg = asObject(payload?.msg);
  return (
    asString(payload?.turnId) ??
    asString(payload?.turn_id) ??
    asString(turn?.id) ??
    asString(message?.turnId) ??
    asString(message?.turn_id) ??
    asString(msg?.turnId) ??
    asString(msg?.turn_id)
  );
}

function readItemId(event: ProviderRawEvent): string | undefined {
  if (event.itemId) return event.itemId;
  const payload = asObject(event.payload);
  const item = asObject(payload?.item);
  const message = asObject(payload?.message);
  const msg = asObject(payload?.msg);
  return (
    asString(payload?.itemId) ??
    asString(payload?.item_id) ??
    asString(payload?.messageId) ??
    asString(payload?.message_id) ??
    asString(payload?.msgId) ??
    asString(payload?.msg_id) ??
    asString(item?.id) ??
    asString(message?.id) ??
    asString(msg?.id)
  );
}

function mapApprovalDecision(decision: string): "accept" | "accept_for_session" | "decline" | "cancel" | "timed_out" {
  switch (decision) {
    case "accept":
      return "accept";
    case "acceptForSession":
      return "accept_for_session";
    case "decline":
      return "decline";
    case "cancel":
      return "cancel";
    default:
      return "cancel";
  }
}

function nextSessionState(
  raw: ProviderRawEvent,
  current: CanonicalSessionState | undefined,
): CanonicalSessionState | undefined {
  const now = raw.createdAt;
  const base: CanonicalSessionState =
    current ?? {
      sessionId: raw.sessionId,
      provider: raw.provider,
      status: "ready",
      createdAt: now,
      updatedAt: now,
    };
  const threadId = readThreadId(raw);
  const turnId = readTurnId(raw);
  const payload = asObject(raw.payload);
  const turn = asObject(payload?.turn);
  const turnStatus = asString(turn?.status);
  const turnError = asString(asObject(turn?.error)?.message);

  if (raw.kind === "session") {
    if (raw.method === "session/connecting") {
      return {
        ...base,
        status: "connecting",
        updatedAt: now,
      };
    }
    if (raw.method === "session/ready") {
      return {
        ...base,
        status: "ready",
        threadId: threadId ?? base.threadId,
        updatedAt: now,
      };
    }
    if (raw.method === "session/closed" || raw.method === "session/exited") {
      return {
        ...base,
        status: "closed",
        activeTurnId: undefined,
        lastError: raw.message ?? base.lastError,
        updatedAt: now,
      };
    }
    if (raw.method === "session/startFailed") {
      return {
        ...base,
        status: "error",
        lastError: raw.message ?? base.lastError,
        updatedAt: now,
      };
    }
  }

  if (raw.method === "thread/started") {
    return {
      ...base,
      threadId: threadId ?? base.threadId,
      updatedAt: now,
    };
  }

  if (raw.method === "turn/started") {
    return {
      ...base,
      status: "running",
      threadId: threadId ?? base.threadId,
      activeTurnId: turnId ?? base.activeTurnId,
      updatedAt: now,
    };
  }

  if (raw.method === "turn/completed") {
    return {
      ...base,
      status: turnStatus === "failed" ? "error" : "ready",
      threadId: threadId ?? base.threadId,
      activeTurnId: undefined,
      lastError: turnError ?? base.lastError,
      updatedAt: now,
    };
  }

  if (raw.kind === "error") {
    return {
      ...base,
      status: "error",
      lastError: raw.message ?? base.lastError,
      updatedAt: now,
    };
  }

  if (raw.method === "error") {
    const errorMessage = asString(asObject(payload?.error)?.message);
    return {
      ...base,
      status: "error",
      lastError: errorMessage ?? raw.message ?? base.lastError,
      updatedAt: now,
    };
  }

  return undefined;
}

function isActionableItemType(type: string | undefined): boolean {
  if (!type) return false;
  const normalized = type.toLowerCase();
  if (
    normalized.includes("agentmessage") ||
    normalized.includes("reasoning") ||
    normalized.includes("preamble")
  ) {
    return false;
  }
  return true;
}

function mapActivityLabel(type: string | undefined): string {
  const normalized = type?.toLowerCase() ?? "";
  if (normalized.includes("command")) return "Command run";
  if (normalized.includes("filechange") || normalized.includes("file_change")) {
    return "File change";
  }
  if (normalized.includes("tool")) return "Tool call";
  return "Activity";
}

function mapActivityKind(type: string | undefined): "tool" | "plan" | "system" {
  const normalized = type?.toLowerCase() ?? "";
  if (normalized.includes("plan")) return "plan";
  if (normalized.includes("system")) return "system";
  return "tool";
}

export interface ProviderEventAdapter {
  normalize(
    raw: ProviderRawEvent,
    currentSession: CanonicalSessionState | undefined,
  ): ProviderCoreEvent[];
  toDebugRaw(raw: ProviderRawEvent): ProviderCoreEvent;
}

export class ProviderEventNormalizer implements ProviderEventAdapter {
  normalize(
    raw: ProviderRawEvent,
    currentSession: CanonicalSessionState | undefined,
  ): ProviderCoreEvent[] {
    const events: ProviderCoreEvent[] = [];
    const payload = asObject(raw.payload);
    const threadId = readThreadId(raw);
    const turnId = readTurnId(raw);
    const itemId = readItemId(raw);

    const sessionUpdate = nextSessionState(raw, currentSession);
    if (sessionUpdate) {
      events.push({
        type: "session.updated",
        session: sessionUpdate,
      });
    }

    if (raw.method === "turn/started" && threadId && turnId) {
      events.push({
        type: "turn.started",
        sessionId: raw.sessionId,
        threadId,
        turnId,
        startedAt: raw.createdAt,
      });
    }

    if (raw.method === "turn/completed" && threadId && turnId) {
      const turn = asObject(payload?.turn);
      const status = asString(turn?.status);
      const turnError = asString(asObject(turn?.error)?.message);
      let outcome: "completed" | "failed" | "interrupted" = "completed";
      if (status === "failed") {
        outcome = "failed";
      } else if (status === "interrupted") {
        outcome = "interrupted";
      }
      events.push({
        type: "turn.completed",
        sessionId: raw.sessionId,
        threadId,
        turnId,
        completedAt: raw.createdAt,
        outcome,
        ...(turnError ? { error: turnError } : {}),
      });
    }

    if (raw.method === "item/agentMessage/delta" && threadId && itemId) {
      const delta =
        raw.textDelta ??
        asString(payload?.delta) ??
        asString(asObject(payload?.message)?.delta) ??
        asString(asObject(payload?.msg)?.delta) ??
        "";
      if (delta.length > 0) {
        events.push({
          type: "message.delta",
          sessionId: raw.sessionId,
          threadId,
          ...(turnId ? { turnId } : {}),
          messageId: itemId,
          role: "assistant",
          delta,
        });
      }
    }

    if (raw.method === "item/completed" && threadId) {
      const item = asObject(payload?.item);
      const itemType = asString(item?.type);
      const isAgentMessage =
        isAgentMessageType(itemType) ||
        (!!raw.itemId && raw.itemId.startsWith("msg_"));
      if (isAgentMessage) {
        const messageId = asString(item?.id) ?? itemId;
        const text = asString(item?.text) ?? "";
        if (messageId) {
          events.push({
            type: "message.completed",
            sessionId: raw.sessionId,
            threadId,
            ...(turnId ? { turnId } : {}),
            messageId,
            role: "assistant",
            text,
          });
        }
      }
    }

    if (
      raw.method === "item/commandExecution/requestApproval" &&
      raw.requestId
    ) {
      const command = asString(payload?.command);
      const reason = asString(payload?.reason);
      events.push({
        type: "approval.requested",
        sessionId: raw.sessionId,
        ...(threadId ? { threadId } : {}),
        ...(turnId ? { turnId } : {}),
        approvalId: raw.requestId,
        approvalKind: "command",
        title: "Command approval requested",
        ...(command ? { detail: command } : reason ? { detail: reason } : {}),
        payload: raw.payload,
        requestedAt: raw.createdAt,
      });
    }

    if (raw.method === "item/fileChange/requestApproval" && raw.requestId) {
      const reason = asString(payload?.reason);
      events.push({
        type: "approval.requested",
        sessionId: raw.sessionId,
        ...(threadId ? { threadId } : {}),
        ...(turnId ? { turnId } : {}),
        approvalId: raw.requestId,
        approvalKind: "file_change",
        title: "File change approval requested",
        ...(reason ? { detail: reason } : {}),
        payload: raw.payload,
        requestedAt: raw.createdAt,
      });
    }

    if (raw.method === "item/tool/requestUserInput") {
      const approvalId = raw.requestId ?? raw.id;
      events.push({
        type: "approval.requested",
        sessionId: raw.sessionId,
        ...(threadId ? { threadId } : {}),
        ...(turnId ? { turnId } : {}),
        approvalId,
        approvalKind: "user_input",
        title: "Tool requested user input",
        payload: raw.payload,
        requestedAt: raw.createdAt,
      });
    }

    if (raw.method === "item/requestApproval/decision" && raw.requestId) {
      const decision = mapApprovalDecision(
        asString(payload?.decision) ?? "cancel",
      );
      events.push({
        type: "approval.resolved",
        sessionId: raw.sessionId,
        approvalId: raw.requestId,
        decision,
        resolvedAt: raw.createdAt,
      });
    }

    if (raw.method === "item/started" || raw.method === "item/completed") {
      const item = asObject(payload?.item);
      const itemType = asString(item?.type);
      const itemText = asString(item?.text);
      const isAgentMessage = isAgentMessageType(itemType);
      if (raw.method === "item/started" && threadId && itemId && isAgentMessage) {
        if (itemText && itemText.length > 0) {
          events.push({
            type: "message.delta",
            sessionId: raw.sessionId,
            threadId,
            ...(turnId ? { turnId } : {}),
            messageId: itemId,
            role: "assistant",
            delta: itemText,
          });
        }
      }

      if (threadId && itemId && isActionableItemType(itemType)) {
        events.push({
          type: "activity",
          sessionId: raw.sessionId,
          threadId,
          ...(turnId ? { turnId } : {}),
          activityId: itemId,
          activityKind: mapActivityKind(itemType),
          label: mapActivityLabel(itemType),
          ...(asString(item?.command) ? { detail: asString(item?.command) } : {}),
          status: raw.method === "item/started" ? "created" : "success",
          ...(raw.method === "item/started"
            ? { startedAt: raw.createdAt }
            : { completedAt: raw.createdAt }),
        });
      }
    }

    if (raw.method === "turn/plan/updated" && threadId) {
      const explanation = asString(payload?.explanation);
      const plan = payload?.plan;
      events.push({
        type: "activity",
        sessionId: raw.sessionId,
        threadId,
        ...(turnId ? { turnId } : {}),
        activityId: raw.id,
        activityKind: "plan",
        label: "Plan updated",
        ...(explanation ? { detail: explanation } : {}),
        status: "success",
        completedAt: raw.createdAt,
        ...(explanation || plan
          ? {
              extensions: {
                "codex.turn.plan": {
                  explanation: explanation ?? null,
                  plan: plan ?? null,
                },
              },
            }
          : {}),
      });
    }

    if (raw.kind === "error" || raw.method === "error") {
      const notificationMessage = asString(asObject(payload?.error)?.message);
      const retryable = asBoolean(payload?.willRetry) ?? asBoolean(payload?.will_retry);
      const message = notificationMessage ?? raw.message ?? "Provider error";
      events.push({
        type: "error",
        sessionId: raw.sessionId,
        ...(threadId ? { threadId } : {}),
        ...(turnId ? { turnId } : {}),
        code: raw.method,
        message,
        ...(retryable !== undefined ? { retryable } : {}),
      });
    }

    return events;
  }

  toDebugRaw(raw: ProviderRawEvent): ProviderCoreEvent {
    return {
      type: "debug.raw",
      provider: raw.provider,
      sessionId: raw.sessionId,
      method: raw.method,
      payload: raw.payload ?? null,
    };
  }
}
