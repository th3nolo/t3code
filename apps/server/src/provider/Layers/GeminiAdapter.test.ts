import * as os from "node:os";
import * as path from "node:path";
import { chmod, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Stream } from "effect";

import { ThreadId, type ProviderRuntimeEvent } from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  countPersistedGeminiMessages,
  readGeminiSessionMetadata,
  resolveGeminiThreadPaths,
} from "../geminiSessionStore.ts";
import { GeminiAdapter } from "../Services/GeminiAdapter.ts";
import { makeGeminiAdapterLive } from "./GeminiAdapter.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockAgentPath = path.join(__dirname, "../../../scripts/gemini-acp-mock-agent.ts");
const bunExe = "bun";

async function makeMockGeminiWrapper(extraEnv?: Record<string, string>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gemini-acp-mock-"));
  const wrapperPath = path.join(dir, "fake-gemini.sh");
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
${envExports}
exec ${JSON.stringify(bunExe)} ${JSON.stringify(mockAgentPath)} "$@"
`;
  await writeFile(wrapperPath, script, "utf8");
  await chmod(wrapperPath, 0o755);
  return wrapperPath;
}

async function readJsonLines(filePath: string) {
  const raw = await readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function findChatFiles(root: string): Promise<Array<string>> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: Array<string> = [];
  for (const entry of entries) {
    const nextPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findChatFiles(nextPath)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(nextPath);
    }
  }
  return files;
}

const geminiAdapterTestLayer = it.layer(
  makeGeminiAdapterLive().pipe(
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3code-gemini-adapter-test-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const geminiInterruptFallbackLayer = it.layer(
  makeGeminiAdapterLive({
    syntheticCancelGrace: "200 millis",
    acpCancelTimeout: "500 millis",
  }).pipe(
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3code-gemini-interrupt-fallback-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
  { excludeTestServices: true },
);

geminiAdapterTestLayer("GeminiAdapterLive", (it) => {
  it.effect(
    "retries optional ACP mode/model/config requests when they fail or are unsupported",
    () =>
      Effect.gen(function* () {
        const adapter = yield* GeminiAdapter;
        const settings = yield* ServerSettingsService;
        const threadId = ThreadId.make("gemini-optional-retry");
        const tempDir = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "gemini-acp-")));
        const requestLogPath = path.join(tempDir, "requests.ndjson");
        yield* Effect.promise(() => writeFile(requestLogPath, "", "utf8"));
        const wrapperPath = yield* Effect.promise(() =>
          makeMockGeminiWrapper({
            T3_GEMINI_REQUEST_LOG_PATH: requestLogPath,
            T3_GEMINI_UNSUPPORTED_SET_MODE: "1",
            T3_GEMINI_UNSUPPORTED_SET_MODEL: "1",
            T3_GEMINI_FAIL_SET_CONFIG_OPTION: "1",
          }),
        );

        yield* settings.updateSettings({ providers: { gemini: { binaryPath: wrapperPath } } });

        const modelSelection = {
          provider: "gemini" as const,
          model: "gemini-2.5-flash",
          options: {
            thinking: false,
            effort: "high" as const,
            contextWindow: "128k",
          },
        };

        yield* adapter.startSession({
          threadId,
          provider: "gemini",
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection,
        });

        yield* adapter.sendTurn({
          threadId,
          input: "first turn",
          attachments: [],
          modelSelection,
        });

        yield* adapter.sendTurn({
          threadId,
          input: "second turn",
          attachments: [],
          modelSelection,
        });

        yield* adapter.stopSession(threadId);

        const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
        const setModeRequests = requests.filter((entry) => entry.method === "session/set_mode");
        const setModelRequests = requests.filter((entry) => entry.method === "session/set_model");
        const setConfigRequests = requests.filter(
          (entry) => entry.method === "session/set_config_option",
        );

        assert.isAtLeast(setModeRequests.length, 3);
        assert.isAtLeast(setModelRequests.length, 3);
        assert.isAtLeast(setConfigRequests.length, 3);
        assert.isTrue(
          setConfigRequests.every(
            (entry) => (entry.params as Record<string, unknown> | undefined)?.configId === "effort",
          ),
        );
      }),
  );

  it.effect("repairs a prior +2 fallback before recording the next turn", () =>
    Effect.gen(function* () {
      const adapter = yield* GeminiAdapter;
      const settings = yield* ServerSettingsService;
      const serverConfig = yield* ServerConfig;
      const threadId = ThreadId.make("gemini-message-count-repair");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGeminiWrapper({
          T3_GEMINI_EMIT_TOOL_CHAT: "1",
          T3_GEMINI_LOCK_CHAT_FILE_AFTER_PROMPT: "1",
        }),
      );

      yield* settings.updateSettings({ providers: { gemini: { binaryPath: wrapperPath } } });

      yield* adapter.startSession({
        threadId,
        provider: "gemini",
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { provider: "gemini", model: "gemini-2.5-pro" },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "tool-heavy turn",
        attachments: [],
      });

      const threadPaths = resolveGeminiThreadPaths({
        providerStateDir: serverConfig.providerStateDir,
        threadId,
      });
      const chatFiles = yield* Effect.promise(() =>
        findChatFiles(path.join(threadPaths.home, ".gemini", "tmp")),
      );
      const backupPath = chatFiles.find((file) => file.endsWith(".backup.json"));
      const chatFilePath = chatFiles.find((file) => file.endsWith("mock-chat.json"));
      assert.isDefined(backupPath);
      assert.isDefined(chatFilePath);
      const backupRaw = yield* Effect.promise(() => readFile(backupPath!, "utf8"));
      yield* Effect.promise(() => writeFile(chatFilePath!, backupRaw, "utf8"));

      yield* adapter.sendTurn({
        threadId,
        input: "follow-up turn",
        attachments: [],
      });

      const metadata = yield* readGeminiSessionMetadata(threadPaths.metadataPath);
      assert.isDefined(metadata);
      assert.equal(metadata?.turns[1]?.messageCountBefore, 6);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("seeds readThread from persisted Gemini metadata on resume", () =>
    Effect.gen(function* () {
      const adapter = yield* GeminiAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("gemini-resume-seed");
      const wrapperPath = yield* Effect.promise(() => makeMockGeminiWrapper());
      yield* settings.updateSettings({ providers: { gemini: { binaryPath: wrapperPath } } });

      const firstSession = yield* adapter.startSession({
        threadId,
        provider: "gemini",
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { provider: "gemini", model: "gemini-2.5-pro" },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "persist one turn",
        attachments: [],
      });
      yield* adapter.stopSession(threadId);

      yield* adapter.startSession({
        threadId,
        provider: "gemini",
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { provider: "gemini", model: "gemini-2.5-pro" },
        resumeCursor: firstSession.resumeCursor,
      });

      const thread = yield* adapter.readThread(threadId);
      assert.equal(thread.turns.length, 1);
      assert.equal(String(thread.turns[0]?.id).length > 0, true);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("emits turn.proposed.completed with raw ACP payload data", () =>
    Effect.gen(function* () {
      const adapter = yield* GeminiAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("gemini-proposed-plan");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGeminiWrapper({ T3_GEMINI_EMIT_PROPOSED_PLAN: "1" }),
      );
      yield* settings.updateSettings({ providers: { gemini: { binaryPath: wrapperPath } } });

      const proposedPlan =
        yield* Deferred.make<
          Extract<ProviderRuntimeEvent, { readonly type: "turn.proposed.completed" }>
        >();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          if (String(event.threadId) !== String(threadId)) return;
          if (event.type === "turn.proposed.completed") {
            yield* Deferred.succeed(proposedPlan, event).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: "gemini",
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { provider: "gemini", model: "gemini-2.5-pro" },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "show a plan",
        attachments: [],
      });

      const event = yield* Deferred.await(proposedPlan);
      if (!event.raw) {
        throw new Error("Expected proposed-plan event to include raw ACP payload.");
      }
      assert.equal(event.raw.source, "acp.jsonrpc");
      assert.equal(event.raw.method, "session/update");
      assert.isDefined(event.raw.payload);
      assert.include(event.payload.planMarkdown, "Inspect Gemini ACP state");

      yield* adapter.stopSession(threadId);
      yield* Fiber.interrupt(runtimeEventsFiber);
    }),
  );
});

geminiInterruptFallbackLayer("GeminiAdapterLive interrupt fallback", (it) => {
  it.effect("truncates Gemini chat state after a synthetic cancel", () =>
    Effect.gen(function* () {
      const adapter = yield* GeminiAdapter;
      const settings = yield* ServerSettingsService;
      const serverConfig = yield* ServerConfig;
      const threadId = ThreadId.make("gemini-synthetic-cancel");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGeminiWrapper({ T3_GEMINI_HANG_ON_PROMPT: "1" }),
      );
      yield* settings.updateSettings({ providers: { gemini: { binaryPath: wrapperPath } } });

      const turnStarted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          if (String(event.threadId) === String(threadId) && event.type === "turn.started") {
            yield* Deferred.succeed(turnStarted, undefined).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: "gemini",
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { provider: "gemini", model: "gemini-2.5-pro" },
      });

      const sendFiber = yield* adapter
        .sendTurn({ threadId, input: "hang please", attachments: [] })
        .pipe(Effect.forkChild);

      yield* Deferred.await(turnStarted);
      yield* adapter.interruptTurn(threadId);
      yield* Fiber.join(sendFiber);

      const sessionsAfter = yield* adapter.listSessions();
      const sessionAfter = sessionsAfter.find((s) => String(s.threadId) === String(threadId));
      assert.isDefined(sessionAfter);
      assert.isUndefined(sessionAfter?.activeTurnId);

      yield* adapter.stopSession(threadId);

      const threadPaths = resolveGeminiThreadPaths({
        providerStateDir: serverConfig.providerStateDir,
        threadId,
      });
      const metadata = yield* readGeminiSessionMetadata(threadPaths.metadataPath);
      assert.isDefined(metadata);
      assert.equal(metadata?.turns.length, 1);
      assert.equal(metadata?.turns[0]?.status, "incomplete");
      assert.equal(metadata?.turns[0]?.messageCountBefore, 0);
      assert.equal(metadata?.turns[0]?.messageCountAfter, 0);

      const chatFiles = yield* Effect.promise(() =>
        findChatFiles(path.join(threadPaths.home, ".gemini", "tmp")),
      );
      const chatFilePath = chatFiles.find((file) => file.endsWith("mock-chat.json"));
      assert.isDefined(chatFilePath);
      const countedMessages = yield* countPersistedGeminiMessages(chatFilePath!);
      assert.equal(countedMessages, 0);
      yield* Fiber.interrupt(runtimeEventsFiber);
    }),
  );
});
