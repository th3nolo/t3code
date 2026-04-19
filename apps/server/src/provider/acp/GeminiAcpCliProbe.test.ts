/**
 * Optional integration check against a real `gemini` ACP install.
 * Enable with: T3_GEMINI_ACP_PROBE=1 bun run test src/provider/acp/GeminiAcpCliProbe.test.ts
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, Fiber, FileSystem } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect } from "vitest";

import {
  applyGeminiAcpConfigOptions,
  initializeGeminiCliHome,
  makeGeminiAcpRuntime,
  resolveGeminiAcpFlavor,
  resolveGeminiAuthMethod,
} from "./GeminiAcpSupport.ts";

describe.runIf(process.env.T3_GEMINI_ACP_PROBE === "1")("Gemini ACP CLI probe", () => {
  it.effect("starts a real Gemini ACP runtime and exercises prompt + cancel", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const probeHome = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-gemini-live-" });
      yield* initializeGeminiCliHome({ home: probeHome });

      const flavor = yield* resolveGeminiAcpFlavor({
        childProcessSpawner,
        geminiSettings: {
          binaryPath: process.env.T3_GEMINI_BIN ?? "gemini",
          launchArgs: process.env.T3_GEMINI_LAUNCH_ARGS ?? "",
        },
        cwd: process.cwd(),
        home: probeHome,
      });

      const runtime = yield* makeGeminiAcpRuntime({
        childProcessSpawner,
        geminiSettings: {
          binaryPath: process.env.T3_GEMINI_BIN ?? "gemini",
          launchArgs: process.env.T3_GEMINI_LAUNCH_ARGS ?? "",
        },
        cwd: process.cwd(),
        home: probeHome,
        flavor: flavor.flavor,
        clientInfo: { name: "t3-gemini-live-probe", version: "0.0.0" },
        authMethodId: (yield* resolveGeminiAuthMethod({ homeDir: probeHome })) ?? "oauth-personal",
      });
      const started = yield* runtime.start();
      expect(typeof started.sessionId).toBe("string");

      yield* runtime
        .request("session/set_model", {
          sessionId: started.sessionId,
          modelId: process.env.T3_GEMINI_PROBE_MODEL ?? "gemini-2.5-pro",
        })
        .pipe(Effect.ignore);

      yield* applyGeminiAcpConfigOptions({
        runtime,
        modelOptions: {
          thinking: false,
          effort: "high",
          contextWindow: "1m",
        },
      }).pipe(Effect.ignore);

      const promptResult = yield* runtime.prompt({
        prompt: [{ type: "text", text: "Reply with a short Gemini ACP probe acknowledgement." }],
      });
      expect(promptResult.stopReason).toBeDefined();

      const cancelFiber = yield* runtime
        .prompt({
          prompt: [{ type: "text", text: "Think for a while before replying." }],
        })
        .pipe(Effect.timeout("5 seconds"), Effect.exit, Effect.forkScoped);
      yield* Effect.sleep("400 millis");
      yield* runtime.cancel.pipe(Effect.ignore);
      const cancelResult = yield* Fiber.await(cancelFiber);
      expect(cancelResult._tag).toBeDefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
