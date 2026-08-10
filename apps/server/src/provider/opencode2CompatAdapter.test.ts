import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import { transformJsonBody } from "./opencode2CompatAdapter.ts";

// Fixtures captured verbatim from opencode2 v0.0.0-next-17086.
const assistantMsg = {
  id: "msg_x",
  time: { created: 1, completed: 2 },
  type: "assistant",
  agent: "build",
  model: { id: "ling-3.0-tiny-free", providerID: "opencode" },
  content: [
    { type: "reasoning", text: "thinking…", state: {}, time: {} },
    { type: "text", text: "PONG" },
  ],
  finish: "stop",
  cost: 0,
  tokens: { input: 5415, output: 7 },
};
const userMsg = { id: "msg_u", time: { created: 1 }, text: "Say PONG", type: "user" };
const providerBody = {
  location: { directory: "C:\\Users\\Manuel" },
  data: [
    { id: "opencode", name: "OpenCode Zen", package: "aisdk:x", settings: {} },
    { id: "deepseek", name: "DeepSeek", package: "aisdk:y", settings: {} },
  ],
};

describe("opencode2CompatAdapter.transformJsonBody", () => {
  it("maps flat v2 messages to v1 { info, parts }", () => {
    const out = transformJsonBody("/api/session/ses_1/message", {
      data: [userMsg, assistantMsg],
      cursor: {},
    }) as { data: Array<{ info: Record<string, unknown>; parts: Array<{ type: string; text?: string }> }> };

    NodeAssert.equal(out.data.length, 2);

    const user = out.data[0]!;
    NodeAssert.equal(user.info.role, "user");
    NodeAssert.deepEqual(user.parts, [{ type: "text", text: "Say PONG" }]);

    const assistant = out.data[1]!;
    NodeAssert.equal(assistant.info.role, "assistant");
    NodeAssert.equal(assistant.info.agent, "build");
    NodeAssert.equal(assistant.parts.length, 2);
    NodeAssert.deepEqual(
      assistant.parts.find((p) => p.type === "text"),
      { type: "text", text: "PONG" },
    );
    NodeAssert.ok(assistant.parts.some((p) => p.type === "reasoning"));
    NodeAssert.ok(!("content" in assistant.info));
  });

  it("maps v2 provider list to v1 { all, connected, default }", () => {
    const out = transformJsonBody("/api/provider", providerBody) as {
      all: Array<{ id: string; models: unknown }>;
      connected: Array<string>;
      default: object;
    };
    NodeAssert.deepEqual(out.connected, ["opencode", "deepseek"]);
    NodeAssert.equal(out.all.length, 2);
    NodeAssert.ok("models" in out.all[0]!);
    NodeAssert.deepEqual(out.default, {});
  });

  it("is fail-open: unrecognized shapes/paths return undefined", () => {
    NodeAssert.equal(transformJsonBody("/api/session", { data: { id: "ses_1" } }), undefined);
    NodeAssert.equal(transformJsonBody("/api/provider", { unexpected: true }), undefined);
    NodeAssert.equal(transformJsonBody("/api/session/ses_1/message", { data: "oops" }), undefined);
  });
});
