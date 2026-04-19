#!/usr/bin/env bun
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import * as nodePath from "node:path";

import * as Effect from "effect/Effect";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";

import * as EffectAcpAgent from "effect-acp/agent";
import * as AcpError from "effect-acp/errors";
import type * as AcpSchema from "effect-acp/schema";

const requestLogPath = process.env.T3_GEMINI_REQUEST_LOG_PATH;
const exitLogPath = process.env.T3_GEMINI_EXIT_LOG_PATH;
const hangOnPrompt = process.env.T3_GEMINI_HANG_ON_PROMPT === "1";
const emitToolChat = process.env.T3_GEMINI_EMIT_TOOL_CHAT === "1";
const emitProposedPlan = process.env.T3_GEMINI_EMIT_PROPOSED_PLAN === "1";
const failSetConfigOption = process.env.T3_GEMINI_FAIL_SET_CONFIG_OPTION === "1";
const failSetMode = process.env.T3_GEMINI_FAIL_SET_MODE === "1";
const failSetModel = process.env.T3_GEMINI_FAIL_SET_MODEL === "1";
const unsupportedSetMode = process.env.T3_GEMINI_UNSUPPORTED_SET_MODE === "1";
const unsupportedSetModel = process.env.T3_GEMINI_UNSUPPORTED_SET_MODEL === "1";
const lockChatFileAfterPrompt = process.env.T3_GEMINI_LOCK_CHAT_FILE_AFTER_PROMPT === "1";
const promptResponseText = process.env.T3_GEMINI_PROMPT_RESPONSE_TEXT ?? "gemini mock response";
const sessionId = "gemini-mock-session-1";

type GeminiChatMessage =
  | { readonly role: "user"; readonly text: string }
  | { readonly role: "assistant"; readonly text?: string; readonly toolCallId?: string }
  | { readonly role: "tool"; readonly toolCallId: string; readonly output?: string };

const availableModes: ReadonlyArray<AcpSchema.SessionMode> = [
  {
    id: "code",
    name: "Code",
    description: "Write and modify code",
  },
  {
    id: "architect",
    name: "Architect",
    description: "Plan the solution",
  },
  {
    id: "auto_edit",
    name: "Auto Edit",
    description: "Auto-accept edits",
  },
  {
    id: "yolo",
    name: "YOLO",
    description: "Full access mode",
  },
];

let currentModeId = "code";
let currentModelId = "gemini-2.5-pro";
let currentEffort = "medium";
let currentContext = "1m";
let currentThinking = true;
let chatFilePath: string | undefined;
const chatMessages: Array<GeminiChatMessage> = [];
const cancelledSessions = new Set<string>();

function logExit(reason: string): void {
  if (!exitLogPath) return;
  appendFileSync(exitLogPath, `${reason}\n`, "utf8");
}

process.once("SIGTERM", () => {
  logExit("SIGTERM");
  process.exit(0);
});

process.once("SIGINT", () => {
  logExit("SIGINT");
  process.exit(0);
});

process.once("exit", (code) => {
  logExit(`exit:${code}`);
});

function configOptions(): ReadonlyArray<AcpSchema.SessionConfigOption> {
  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: currentModelId,
      options: [
        { value: "auto", name: "Auto" },
        { value: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
        { value: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
      ],
    },
    {
      id: "effort",
      name: "Reasoning",
      category: "thought_level",
      type: "select",
      currentValue: currentEffort,
      options: [
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
        { value: "max", name: "Max" },
      ],
    },
    {
      id: "context",
      name: "Context Window",
      category: "model_config",
      type: "select",
      currentValue: currentContext,
      options: [
        { value: "128k", name: "128K" },
        { value: "1m", name: "1M" },
      ],
    },
    {
      id: "thinking",
      name: "Thinking",
      category: "model_config",
      type: "boolean",
      currentValue: currentThinking,
    },
  ];
}

function modeState(): AcpSchema.SessionModeState {
  return {
    currentModeId,
    availableModes,
  };
}

function ensureChatFile(): string {
  if (chatFilePath) return chatFilePath;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? process.cwd();
  const chatDir = nodePath.join(home, ".gemini", "tmp", sessionId, "chats");
  mkdirSync(chatDir, { recursive: true });
  chatFilePath = nodePath.join(chatDir, "mock-chat.json");
  return chatFilePath;
}

function persistChatFile() {
  const nextPath = ensureChatFile();
  const encoded = `${JSON.stringify(
    {
      sessionId,
      messages: chatMessages,
    },
    null,
    2,
  )}\n`;
  if (lockChatFileAfterPrompt) {
    writeFileSync(`${nextPath}.backup.json`, encoded, "utf8");
    writeFileSync(nextPath, '{"broken":\n', "utf8");
    return;
  }
  writeFileSync(nextPath, encoded, "utf8");
}

function appendMessages(messages: ReadonlyArray<GeminiChatMessage>) {
  chatMessages.push(...messages);
  persistChatFile();
}

const program = Effect.gen(function* () {
  const agent = yield* EffectAcpAgent.AcpAgent;

  yield* agent.handleInitialize(() =>
    Effect.succeed({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
    }),
  );

  yield* agent.handleAuthenticate(() => Effect.succeed({}));

  yield* agent.handleCreateSession(() =>
    Effect.succeed({
      sessionId,
      modes: modeState(),
      configOptions: configOptions(),
    }),
  );

  yield* agent.handleLoadSession((request) =>
    agent.client
      .sessionUpdate({
        sessionId: String(request.sessionId ?? sessionId),
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "gemini replay" },
        },
      })
      .pipe(
        Effect.as({
          modes: modeState(),
          configOptions: configOptions(),
        }),
      ),
  );

  yield* agent.handleSetSessionConfigOption((request) =>
    Effect.gen(function* () {
      if (failSetConfigOption) {
        return yield* AcpError.AcpRequestError.invalidParams(
          "Mock invalid params for session/set_config_option",
          {
            method: "session/set_config_option",
            params: request,
          },
        );
      }

      if (request.configId === "effort" && typeof request.value === "string") {
        currentEffort = request.value;
      }
      if (request.configId === "context" && typeof request.value === "string") {
        currentContext = request.value;
      }
      if (request.configId === "thinking") {
        currentThinking = request.value === true || request.value === "true";
      }

      return {
        configOptions: configOptions(),
      };
    }),
  );

  yield* agent.handleCancel((request) =>
    Effect.sync(() => {
      cancelledSessions.add(String(request.sessionId ?? sessionId));
    }),
  );

  yield* agent.handlePrompt((request) =>
    Effect.gen(function* () {
      const requestedSessionId = String(request.sessionId ?? sessionId);
      const promptText =
        typeof request.prompt === "object" &&
        request.prompt !== null &&
        "text" in request.prompt &&
        typeof request.prompt.text === "string"
          ? request.prompt.text
          : "mock prompt";

      appendMessages([{ role: "user", text: promptText }]);

      if (emitProposedPlan) {
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: `<proposed_plan>\n- [x] Inspect Gemini ACP state\n- [ ] Apply the requested change\n</proposed_plan>`,
            },
          },
        });
      }

      if (hangOnPrompt) {
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "mock-hang: waiting forever" },
          },
        });
        return yield* Effect.never;
      }

      if (emitToolChat) {
        appendMessages([
          { role: "assistant", toolCallId: "tool-1" },
          { role: "tool", toolCallId: "tool-1", output: "first tool output" },
          { role: "assistant", toolCallId: "tool-2" },
          { role: "tool", toolCallId: "tool-2", output: "second tool output" },
          { role: "assistant", text: promptResponseText },
        ]);
      } else {
        appendMessages([{ role: "assistant", text: promptResponseText }]);
      }

      yield* agent.client.sessionUpdate({
        sessionId: requestedSessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: promptResponseText },
        },
      });

      const cancelled = cancelledSessions.delete(requestedSessionId);
      return {
        stopReason: cancelled ? "cancelled" : "end_turn",
      };
    }),
  );

  yield* agent.handleUnknownExtRequest((method, params) => {
    if (method === "session/set_mode") {
      if (unsupportedSetMode) {
        return Effect.fail(AcpError.AcpRequestError.methodNotFound(method));
      }
      if (failSetMode) {
        return Effect.fail(
          AcpError.AcpRequestError.invalidParams("Mock invalid params for session/set_mode", {
            method,
            params,
          }),
        );
      }

      const nextModeId =
        typeof params === "object" &&
        params !== null &&
        "modeId" in params &&
        typeof params.modeId === "string"
          ? params.modeId
          : undefined;
      const requestedSessionId =
        typeof params === "object" &&
        params !== null &&
        "sessionId" in params &&
        typeof params.sessionId === "string"
          ? params.sessionId
          : sessionId;

      if (nextModeId?.trim()) {
        currentModeId = nextModeId.trim();
        return agent.client
          .sessionUpdate({
            sessionId: requestedSessionId,
            update: {
              sessionUpdate: "current_mode_update",
              currentModeId,
            },
          })
          .pipe(Effect.as({}));
      }

      return Effect.succeed({});
    }

    if (method === "session/set_model") {
      if (unsupportedSetModel) {
        return Effect.fail(AcpError.AcpRequestError.methodNotFound(method));
      }
      if (failSetModel) {
        return Effect.fail(
          AcpError.AcpRequestError.invalidParams("Mock invalid params for session/set_model", {
            method,
            params,
          }),
        );
      }

      const nextModelId =
        typeof params === "object" &&
        params !== null &&
        "modelId" in params &&
        typeof params.modelId === "string"
          ? params.modelId
          : undefined;

      if (nextModelId?.trim()) {
        currentModelId = nextModelId.trim();
      }

      return Effect.succeed({
        configOptions: configOptions(),
      });
    }

    return Effect.fail(AcpError.AcpRequestError.methodNotFound(method));
  });

  return yield* Effect.never;
}).pipe(
  Effect.provide(
    EffectAcpAgent.layerStdio(
      requestLogPath
        ? {
            logIncoming: true,
            logger: (event) => {
              if (event.direction !== "incoming" || event.stage !== "raw") {
                return Effect.void;
              }
              if (typeof event.payload !== "string") {
                return Effect.void;
              }
              const payload = event.payload;
              return Effect.sync(() => {
                appendFileSync(
                  requestLogPath,
                  payload.endsWith("\n") ? payload : `${payload}\n`,
                  "utf8",
                );
              });
            },
          }
        : {},
    ),
  ),
  Effect.scoped,
  Effect.provide(NodeServices.layer),
);

NodeRuntime.runMain(program);
