import type { GeminiModelOptions } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Effect, Fiber, FileSystem } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { tolerateOptionalAcpCall } from "../src/provider/acp/AcpAdapterSupport.ts";
import {
  applyGeminiAcpConfigOptions,
  initializeGeminiCliHome,
  makeGeminiAcpRuntime,
  resolveGeminiAcpFlavor,
  resolveGeminiAuthMethod,
  type GeminiAcpFlavor,
} from "../src/provider/acp/GeminiAcpSupport.ts";

const targetCwd = process.argv[2] ?? process.cwd();
const targetModel = process.argv[3] ?? "gemini-2.5-pro";
const promptText = process.argv[4] ?? "Describe your current Gemini ACP configuration.";
const cancelPromptText =
  process.env.T3_GEMINI_CANCEL_PROMPT ?? "Think through a long refactor and explain it in detail.";
const requestedMode = process.env.T3_GEMINI_PROBE_MODE ?? "architect";
const binaryPath = process.env.T3_GEMINI_BIN ?? "gemini";
const launchArgs = process.env.T3_GEMINI_LAUNCH_ARGS ?? "";

function parseThinkingFlag(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
  if (normalized === "false" || normalized === "0" || normalized === "no") return false;
  return undefined;
}

function parseEffort(value: string | undefined): GeminiModelOptions["effort"] {
  switch (value?.trim().toLowerCase()) {
    case "low":
    case "medium":
    case "high":
    case "max":
      return value.trim().toLowerCase() as GeminiModelOptions["effort"];
    default:
      return "high";
  }
}

function logSection(title: string, value: unknown) {
  process.stdout.write(`\n=== ${title} ===\n`);
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const probeHome = yield* fs.makeTempDirectoryScoped({ prefix: "t3-gemini-acp-probe-" });
  yield* initializeGeminiCliHome({ home: probeHome });

  const flavorResult = yield* resolveGeminiAcpFlavor({
    childProcessSpawner,
    geminiSettings: {
      binaryPath,
      launchArgs,
    },
    cwd: targetCwd,
    home: probeHome,
    clientInfo: { name: "t3-gemini-acp-probe", version: "0.0.0" },
  });
  const flavor: GeminiAcpFlavor = flavorResult.flavor;
  logSection("FLAVOR", {
    flavor,
    sessionId: flavorResult.started.sessionId,
    modeCount: flavorResult.started.sessionSetupResult.modes?.availableModes.length ?? 0,
    configOptionCount: flavorResult.started.sessionSetupResult.configOptions?.length ?? 0,
  });

  const runtime = yield* makeGeminiAcpRuntime({
    childProcessSpawner,
    geminiSettings: { binaryPath, launchArgs },
    cwd: targetCwd,
    home: probeHome,
    flavor,
    clientInfo: { name: "t3-gemini-acp-probe", version: "0.0.0" },
    authMethodId: (yield* resolveGeminiAuthMethod({ homeDir: probeHome })) ?? "oauth-personal",
  });
  const started = yield* runtime.start();
  logSection("SESSION_START", started.sessionSetupResult);

  const modeStatus = started.sessionSetupResult.modes?.availableModes.some(
    (mode) => mode.id === requestedMode,
  )
    ? yield* tolerateOptionalAcpCall({
        label: "session/set_mode",
        effect: runtime.request("session/set_mode", {
          sessionId: started.sessionId,
          modeId: requestedMode,
        }),
      })
    : ({ _tag: "unsupported" } as const);
  logSection("MODE", {
    requestedMode,
    status: modeStatus._tag,
  });

  const modelStatus = yield* tolerateOptionalAcpCall({
    label: "session/set_model",
    effect: runtime.request("session/set_model", {
      sessionId: started.sessionId,
      modelId: targetModel,
    }),
  });
  logSection("MODEL", {
    requestedModel: targetModel,
    status: modelStatus._tag,
  });

  const modelOptions: GeminiModelOptions = {
    thinking: parseThinkingFlag(process.env.T3_GEMINI_PROBE_THINKING) ?? false,
    effort: parseEffort(process.env.T3_GEMINI_PROBE_EFFORT),
    contextWindow: process.env.T3_GEMINI_PROBE_CONTEXT ?? "1m",
  };
  const configStatus = yield* tolerateOptionalAcpCall({
    label: "session/set_config_option",
    effect: applyGeminiAcpConfigOptions({
      runtime,
      modelOptions,
    }),
  });
  logSection("CONFIG", {
    requested: modelOptions,
    status: configStatus._tag,
    configOptions: yield* runtime.getConfigOptions,
  });

  const promptResult = yield* runtime.prompt({
    prompt: [{ type: "text", text: promptText }],
  });
  logSection("PROMPT", promptResult);

  const cancelFiber = yield* runtime
    .prompt({
      prompt: [{ type: "text", text: cancelPromptText }],
    })
    .pipe(Effect.timeout("5 seconds"), Effect.exit, Effect.forkScoped);

  yield* Effect.sleep("400 millis");
  const cancelRequest = yield* Effect.exit(runtime.cancel);
  const cancelPrompt = yield* Fiber.join(cancelFiber);
  logSection("CANCEL", {
    cancelRequest,
    cancelPrompt,
  });
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

NodeRuntime.runMain(program);
