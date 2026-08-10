import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import { transformJsonBody, translateEvent } from "./opencode2CompatAdapter.ts";

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
  it("maps flat v2 messages to a bare array of v1 { info, parts }", () => {
    const out = transformJsonBody("GET", "/api/session/ses_1/message", {
      data: [userMsg, assistantMsg],
      cursor: {},
    }) as Array<{ info: Record<string, unknown>; parts: Array<{ type: string; text?: string }> }>;

    NodeAssert.equal(out.length, 2);

    const user = out[0]!;
    NodeAssert.equal(user.info.role, "user");
    NodeAssert.deepEqual(user.parts, [{ type: "text", text: "Say PONG" }]);

    const assistant = out[1]!;
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
    const out = transformJsonBody("GET", "/api/provider", providerBody) as {
      all: Array<{ id: string; models: unknown }>;
      connected: Array<string>;
      default: object;
    };
    NodeAssert.deepEqual(out.connected, ["opencode", "deepseek"]);
    NodeAssert.equal(out.all.length, 2);
    NodeAssert.ok("models" in out.all[0]!);
    NodeAssert.deepEqual(out.default, {});
  });

  it("unwraps the { data } envelope for single-object session responses", () => {
    const out = transformJsonBody("POST", "/api/session", { data: { id: "ses_1", title: "t" } }) as {
      id: string;
    };
    NodeAssert.equal(out.id, "ses_1");
    // list responses (with cursor) are left alone
    NodeAssert.equal(
      transformJsonBody("GET", "/api/session", { data: [{ id: "ses_1" }], cursor: {} }),
      undefined,
    );
  });

  it("is fail-open: unrecognized shapes/paths return undefined", () => {
    NodeAssert.equal(transformJsonBody("GET", "/api/provider", { unexpected: true }), undefined);
    NodeAssert.equal(transformJsonBody("GET", "/api/session/ses_1/message", { data: "oops" }), undefined);
  });
});

describe("opencode2CompatAdapter.translateEvent", () => {
  const SID = "ses_1";
  const MID = "msg_1";

  it("maps session lifecycle to busy/idle session.status", () => {
    const t = new Map<string, number>();
    NodeAssert.deepEqual(translateEvent({ type: "session.execution.started", data: { sessionID: SID } }, t), [
      { type: "session.status", properties: { sessionID: SID, status: { type: "busy" } } },
    ]);
    NodeAssert.deepEqual(translateEvent({ type: "session.execution.succeeded", data: { sessionID: SID } }, t), [
      { type: "session.status", properties: { sessionID: SID, status: { type: "idle" } } },
    ]);
  });

  it("registers the assistant message role on step.started", () => {
    const out = translateEvent(
      { type: "session.step.started", data: { sessionID: SID, assistantMessageID: MID } },
      new Map(),
    );
    NodeAssert.deepEqual(out, [
      { type: "message.updated", properties: { sessionID: SID, info: { id: MID, role: "assistant" } } },
    ]);
  });

  it("streams a text run as start(part.updated) → delta → end(part.updated w/ time.end)", () => {
    const t = new Map<string, number>();
    const started = translateEvent(
      { type: "session.text.started", created: 100, data: { sessionID: SID, assistantMessageID: MID, ordinal: 0 } },
      t,
    );
    const pid = (started[0]!.properties.part as { id: string }).id;
    NodeAssert.equal((started[0]!.properties.part as { type: string }).type, "text");

    const delta = translateEvent(
      { type: "session.text.delta", data: { sessionID: SID, assistantMessageID: MID, ordinal: 0, delta: "PO" } },
      t,
    );
    NodeAssert.deepEqual(delta, [
      { type: "message.part.delta", properties: { sessionID: SID, partID: pid, delta: "PO" } },
    ]);

    const ended = translateEvent(
      { type: "session.text.ended", created: 200, data: { sessionID: SID, assistantMessageID: MID, ordinal: 0, text: "PONG" } },
      t,
    );
    const endedPart = ended[0]!.properties.part as { id: string; text: string; time: { start: number; end: number } };
    NodeAssert.equal(endedPart.id, pid); // same synthesized partID across the run
    NodeAssert.equal(endedPart.text, "PONG");
    NodeAssert.equal(endedPart.time.start, 100);
    NodeAssert.equal(endedPart.time.end, 200); // required or T3 never completes the turn
  });

  it("drops events with no v1 equivalent", () => {
    const t = new Map<string, number>();
    NodeAssert.deepEqual(translateEvent({ type: "server.connected", data: {} }, t), []);
    NodeAssert.deepEqual(translateEvent({ type: "session.step.ended", data: { sessionID: SID } }, t), []);
    NodeAssert.deepEqual(translateEvent({ type: "session.usage.updated", data: { sessionID: SID } }, t), []);
  });
});
