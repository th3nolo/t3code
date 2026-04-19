import * as nodePath from "node:path";
import { readFileSync, writeFileSync } from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId, TurnId } from "@t3tools/contracts";
import { it as effectIt } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { describe, expect, it } from "vitest";

import {
  appendGeminiTurn,
  countPersistedGeminiMessages,
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
  withGeminiChatFileRelativePath,
  writeGeminiSessionMetadata,
} from "./geminiSessionStore.ts";

describe("parseGeminiResumeCursor", () => {
  it("parses a valid cursor", () => {
    expect(
      parseGeminiResumeCursor({
        schemaVersion: GEMINI_SESSION_SCHEMA_VERSION,
        sessionId: "abc-123",
      }),
    ).toEqual({
      schemaVersion: GEMINI_SESSION_SCHEMA_VERSION,
      sessionId: "abc-123",
    });
  });

  it("rejects bad or missing fields", () => {
    expect(parseGeminiResumeCursor(undefined)).toBeUndefined();
    expect(parseGeminiResumeCursor(null)).toBeUndefined();
    expect(parseGeminiResumeCursor([])).toBeUndefined();
    expect(parseGeminiResumeCursor({})).toBeUndefined();
    expect(parseGeminiResumeCursor({ schemaVersion: 2, sessionId: "abc" })).toBeUndefined();
    expect(
      parseGeminiResumeCursor({ schemaVersion: GEMINI_SESSION_SCHEMA_VERSION, sessionId: " " }),
    ).toBeUndefined();
  });

  it("trims whitespace from sessionId", () => {
    expect(
      parseGeminiResumeCursor({
        schemaVersion: GEMINI_SESSION_SCHEMA_VERSION,
        sessionId: "  trimmed  ",
      }),
    ).toEqual({
      schemaVersion: GEMINI_SESSION_SCHEMA_VERSION,
      sessionId: "trimmed",
    });
  });
});

describe("resolveGeminiThreadPaths", () => {
  it("builds the expected per-thread layout", () => {
    const paths = resolveGeminiThreadPaths({
      providerStateDir: "/state/providers",
      threadId: ThreadId.make("thread-xyz"),
    });
    expect(paths.threadDir).toBe(nodePath.join("/state/providers", "gemini", "thread-xyz"));
    expect(paths.home).toBe(nodePath.join("/state/providers", "gemini", "thread-xyz", "home"));
    expect(paths.metadataPath).toBe(
      nodePath.join("/state/providers", "gemini", "thread-xyz", "session-metadata.json"),
    );
  });
});

describe("metadata list helpers", () => {
  const initial = makeInitialGeminiMetadata({ sessionId: "s1" });

  it("appendGeminiTurn adds a turn without mutating input", () => {
    const turn = makeGeminiTurnRecord({
      turnId: TurnId.make("t1"),
      messageCountBefore: 0,
      messageCountAfter: 2,
      status: "completed",
    });
    const next = appendGeminiTurn(initial, turn);
    expect(initial.turns).toEqual([]);
    expect(next.turns).toEqual([turn]);
  });

  it("updateLastGeminiTurnStatus replaces only the last entry", () => {
    const withTurn = appendGeminiTurn(
      initial,
      makeGeminiTurnRecord({
        turnId: TurnId.make("t1"),
        messageCountBefore: 0,
        messageCountAfter: 0,
        status: "incomplete",
      }),
    );
    const completed = updateLastGeminiTurnStatus(withTurn, "completed", {
      messageCountAfter: 2,
    });
    expect(completed.turns).toHaveLength(1);
    expect(completed.turns[0]!.status).toBe("completed");
    expect(completed.turns[0]!.messageCountAfter).toBe(2);
  });

  it("updateLastGeminiTurnStatus is a no-op on empty metadata", () => {
    expect(updateLastGeminiTurnStatus(initial, "completed")).toEqual(initial);
  });

  it("truncateGeminiTurns returns the trimmed list and truncated tail", () => {
    const withTurns = appendGeminiTurn(
      appendGeminiTurn(
        initial,
        makeGeminiTurnRecord({
          turnId: TurnId.make("t1"),
          messageCountBefore: 0,
          messageCountAfter: 2,
          status: "completed",
        }),
      ),
      makeGeminiTurnRecord({
        turnId: TurnId.make("t2"),
        messageCountBefore: 2,
        messageCountAfter: 4,
        status: "completed",
      }),
    );
    const { next, truncated } = truncateGeminiTurns(withTurns, 1);
    expect(next.turns).toHaveLength(1);
    expect(next.turns[0]!.turnId).toBe("t1");
    expect(truncated).toHaveLength(1);
    expect(truncated[0]!.turnId).toBe("t2");
  });

  it("truncateGeminiTurns handles no-op requests", () => {
    expect(truncateGeminiTurns(initial, 3).next).toEqual(initial);
    expect(truncateGeminiTurns(initial, 3).truncated).toEqual([]);
  });
});

describe("withGeminiChatFileRelativePath", () => {
  const initial = makeInitialGeminiMetadata({ sessionId: "s1" });

  it("returns the same reference when the value already matches", () => {
    const seeded = withGeminiChatFileRelativePath(initial, "tmp/chats/a.json");
    expect(seeded.chatFileRelativePath).toBe("tmp/chats/a.json");
    const sameAgain = withGeminiChatFileRelativePath(seeded, "tmp/chats/a.json");
    expect(sameAgain).toBe(seeded);
  });

  it("returns the same reference for blank input so callers can skip persisting", () => {
    expect(withGeminiChatFileRelativePath(initial, "")).toBe(initial);
    expect(withGeminiChatFileRelativePath(initial, "   ")).toBe(initial);
  });

  it("trims and replaces when the value differs", () => {
    const first = withGeminiChatFileRelativePath(initial, "  tmp/chats/old.json  ");
    expect(first.chatFileRelativePath).toBe("tmp/chats/old.json");
    const second = withGeminiChatFileRelativePath(first, "tmp/chats/new.json");
    expect(second.chatFileRelativePath).toBe("tmp/chats/new.json");
    expect(second).not.toBe(first);
  });
});

effectIt.layer(NodeServices.layer)("metadata persistence", (it) => {
  it.effect("round-trips metadata atomically through writeGeminiSessionMetadata", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-gemini-meta-" });
      const metadataPath = nodePath.join(dir, "session-metadata.json");
      const metadata = appendGeminiTurn(
        makeInitialGeminiMetadata({
          sessionId: "sess-1",
          chatFileRelativePath: "tmp/chats/session.json",
        }),
        makeGeminiTurnRecord({
          turnId: TurnId.make("turn-1"),
          messageCountBefore: 0,
          messageCountAfter: 2,
          status: "completed",
        }),
      );
      yield* writeGeminiSessionMetadata({ metadataPath, metadata });

      const onDisk = JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
      expect(onDisk).toMatchObject({
        schemaVersion: GEMINI_SESSION_SCHEMA_VERSION,
        sessionId: "sess-1",
        chatFileRelativePath: "tmp/chats/session.json",
      });
      expect(Array.isArray((onDisk as { turns: unknown }).turns)).toBe(true);

      const parsed = yield* readGeminiSessionMetadata(metadataPath);
      expect(parsed).toEqual(metadata);
    }),
  );

  it.effect("readGeminiSessionMetadata returns undefined for missing/invalid files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-gemini-meta-" });

      const missing = yield* readGeminiSessionMetadata(nodePath.join(dir, "nope.json"));
      expect(missing).toBeUndefined();

      const badPath = nodePath.join(dir, "bad.json");
      writeFileSync(badPath, "{ not json", "utf8");
      const bad = yield* readGeminiSessionMetadata(badPath);
      expect(bad).toBeUndefined();

      const empty = nodePath.join(dir, "empty.json");
      writeFileSync(empty, "", "utf8");
      const emptyResult = yield* readGeminiSessionMetadata(empty);
      expect(emptyResult).toBeUndefined();
    }),
  );
});

effectIt.layer(NodeServices.layer)("chat file helpers", (it) => {
  it.effect("countPersistedGeminiMessages returns the messages length", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-gemini-chat-" });
      const chatPath = nodePath.join(dir, "chat.json");
      writeFileSync(
        chatPath,
        JSON.stringify({
          sessionId: "s1",
          messages: [{ role: "user" }, { role: "assistant" }, { role: "user" }],
        }),
        "utf8",
      );
      expect(yield* countPersistedGeminiMessages(chatPath)).toBe(3);
    }),
  );

  it.effect(
    "countPersistedGeminiMessages counts every message in a tool-call turn (regression guard for the +2 heuristic bug)",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-gemini-chat-" });
        const chatPath = nodePath.join(dir, "chat.json");
        // A real turn with N tool calls produces ~2N+2 messages:
        // [user prompt, assistant tool call, tool result, assistant tool call,
        //  tool result, assistant final reply] = 6 messages for 2 tool calls.
        writeFileSync(
          chatPath,
          JSON.stringify({
            sessionId: "s-tools",
            messages: [
              { role: "user", text: "do two things" },
              { role: "assistant", toolCallId: "t1" },
              { role: "tool", toolCallId: "t1" },
              { role: "assistant", toolCallId: "t2" },
              { role: "tool", toolCallId: "t2" },
              { role: "assistant", text: "done" },
            ],
          }),
          "utf8",
        );

        const count = yield* countPersistedGeminiMessages(chatPath);
        // Not 2 (the old broken heuristic) — 6.
        expect(count).toBe(6);

        // Rollback to the pre-turn boundary (messageCountBefore = 0)
        // must strip every message, not just the first two.
        const remaining = yield* truncatePersistedGeminiMessages({
          chatFilePath: chatPath,
          messageCount: 0,
        });
        expect(remaining).toBe(0);
        const afterTruncate = JSON.parse(readFileSync(chatPath, "utf8")) as {
          messages: ReadonlyArray<unknown>;
        };
        expect(afterTruncate.messages).toEqual([]);
      }),
  );

  it.effect("truncatePersistedGeminiMessages slices messages while preserving the envelope", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-gemini-chat-" });
      const chatPath = nodePath.join(dir, "chat.json");
      const original = {
        sessionId: "s1",
        extraMetadata: { keep: true },
        messages: [
          { role: "user", text: "a" },
          { role: "assistant", text: "b" },
          { role: "user", text: "c" },
        ],
      };
      writeFileSync(chatPath, JSON.stringify(original), "utf8");

      const nextCount = yield* truncatePersistedGeminiMessages({
        chatFilePath: chatPath,
        messageCount: 1,
      });
      expect(nextCount).toBe(1);

      const truncated = JSON.parse(readFileSync(chatPath, "utf8")) as typeof original;
      expect(truncated.messages).toHaveLength(1);
      expect(truncated.messages[0]!.text).toBe("a");
      expect(truncated.sessionId).toBe("s1");
      expect(truncated.extraMetadata).toEqual({ keep: true });
    }),
  );

  it.effect(
    "resolveGeminiChatFile finds the chat file via explicit relativePath when present",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-gemini-home-" });
        const rel = "tmp/chats/session.json";
        const abs = nodePath.join(home, rel);
        yield* fs.makeDirectory(nodePath.dirname(abs), { recursive: true });
        writeFileSync(abs, JSON.stringify({ sessionId: "sess-1", messages: [] }), "utf8");

        const resolved = yield* resolveGeminiChatFile({
          home,
          sessionId: "sess-1",
          chatFileRelativePath: rel,
        });
        expect(resolved).toBeDefined();
        expect(resolved!.absolutePath).toBe(nodePath.resolve(abs));
        expect(resolved!.relativePath.replaceAll(nodePath.sep, "/")).toBe(rel);
      }),
  );

  it.effect("resolveGeminiChatFile scans the tmp/**/chats directory by sessionId", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-gemini-home-" });
      // Gemini nests chat files under tmp/<project-hash>/chats/<id>.json so
      // the internal filter requires at least one intermediate segment.
      const chatDir = nodePath.join(home, "tmp", "project-xyz", "chats");
      yield* fs.makeDirectory(chatDir, { recursive: true });
      const chatPath = nodePath.join(chatDir, "candidate.json");
      writeFileSync(
        chatPath,
        JSON.stringify({ sessionId: "resolved-via-scan", messages: [] }),
        "utf8",
      );

      const resolved = yield* resolveGeminiChatFile({
        home,
        sessionId: "resolved-via-scan",
      });
      expect(resolved).toBeDefined();
      expect(resolved!.absolutePath).toBe(nodePath.resolve(chatPath));
    }),
  );
});
