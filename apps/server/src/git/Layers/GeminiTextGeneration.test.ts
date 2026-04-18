import * as path from "node:path";
import * as os from "node:os";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect } from "vitest";

import { ServerSettingsError } from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { TextGeneration } from "../Services/TextGeneration.ts";
import { GeminiTextGenerationLive } from "./GeminiTextGeneration.ts";
import { ServerSettingsService } from "../../serverSettings.ts";

const GeminiTextGenerationTestLayer = GeminiTextGenerationLive.pipe(
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "t3code-gemini-text-generation-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * Writes a fake `gemini` binary that returns different JSON payloads on
 * consecutive calls. The wrapper records the CLI args it was invoked with
 * into `argsLog` so tests can assert on retry behaviour and attachment
 * injection.
 */
function makeFakeGeminiCli(input: {
  readonly responses: ReadonlyArray<{
    readonly stdout?: string;
    readonly stderr?: string;
    readonly exitCode?: number;
  }>;
  readonly dir: string;
  readonly argsLog: string;
}): string {
  const binDir = path.join(input.dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const cliPath = path.join(binDir, "gemini");
  const counterPath = path.join(input.dir, "counter");
  writeFileSync(counterPath, "0", "utf8");
  const branches = input.responses
    .map((response, index) => {
      const stdout = shellSingleQuote(response.stdout ?? "");
      const stderr = shellSingleQuote(response.stderr ?? "");
      const exit = response.exitCode ?? 0;
      return [
        `if [ "$count" = "${index}" ]; then`,
        `  printf %s ${stdout}`,
        `  printf %s ${stderr} >&2`,
        `  exit ${exit}`,
        "fi",
      ].join("\n");
    })
    .join("\n");

  // Use NUL as the per-argument separator so args that contain newlines
  // (like full prompts) round-trip unambiguously. An explicit delimiter line
  // `===CALL===` separates invocations so the test can count/inspect each.
  const script = [
    "#!/bin/sh",
    `count=$(cat ${shellSingleQuote(counterPath)})`,
    `printf %s $((count + 1)) > ${shellSingleQuote(counterPath)}`,
    `printf '===CALL===\\n' >> ${shellSingleQuote(input.argsLog)}`,
    `for arg in "$@"; do printf '%s\\0' "$arg" >> ${shellSingleQuote(input.argsLog)}; done`,
    branches,
    `printf '%s\\n' "ran out of mock responses at call $count" >&2`,
    "exit 2",
    "",
  ].join("\n");
  writeFileSync(cliPath, script, "utf8");
  chmodSync(cliPath, 0o755);
  return cliPath;
}

const envelope = (innerJson: string): string => JSON.stringify({ response: innerJson, stats: {} });

interface LoggedCall {
  readonly args: ReadonlyArray<string>;
}

function readLoggedCalls(argsLogPath: string): ReadonlyArray<LoggedCall> {
  const raw = readFileSync(argsLogPath, "utf8");
  const rawCalls = raw.split("===CALL===\n");
  const calls: Array<LoggedCall> = [];
  for (const block of rawCalls) {
    if (block.length === 0) continue;
    const args = block.split("\0").filter((arg) => arg.length > 0);
    if (args.length === 0) continue;
    calls.push({ args });
  }
  return calls;
}

function argAfter(args: ReadonlyArray<string>, flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

effectIt.layer(GeminiTextGenerationTestLayer)("GeminiTextGeneration", (it) => {
  it.effect("generates a commit message from a single valid response", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsService;
      const textGen = yield* TextGeneration;
      const dir = mkdtempSync(path.join(os.tmpdir(), "t3code-gemini-text-ok-"));
      const argsLog = path.join(dir, "args.log");
      const cliPath = makeFakeGeminiCli({
        dir,
        argsLog,
        responses: [
          {
            stdout: envelope(
              JSON.stringify({ subject: "feat: add thing", body: "More details here." }),
            ),
          },
        ],
      });
      yield* settings.updateSettings({
        providers: { gemini: { enabled: true, binaryPath: cliPath } },
      });

      const result = yield* textGen.generateCommitMessage({
        cwd: process.cwd(),
        branch: "main",
        stagedSummary: "a file changed",
        stagedPatch: "diff --git ...",
        modelSelection: { provider: "gemini", model: "gemini-2.5-pro" },
      });
      expect(result.subject).toBe("feat: add thing");
      expect(result.body).toBe("More details here.");

      const calls = readLoggedCalls(argsLog);
      expect(calls).toHaveLength(1);
      expect(argAfter(calls[0]!.args, "--model")).toBe("gemini-2.5-pro");
      expect(argAfter(calls[0]!.args, "--output-format")).toBe("json");
      expect(calls[0]!.args).toContain("--prompt");
    }),
  );

  it.effect("retries once on malformed JSON and succeeds on second attempt", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsService;
      const textGen = yield* TextGeneration;
      const dir = mkdtempSync(path.join(os.tmpdir(), "t3code-gemini-text-retry-"));
      const argsLog = path.join(dir, "args.log");
      const cliPath = makeFakeGeminiCli({
        dir,
        argsLog,
        responses: [
          { stdout: envelope("not json at all") },
          {
            stdout: envelope(
              JSON.stringify({ subject: "fix: retry worked", body: "Second attempt body." }),
            ),
          },
        ],
      });
      yield* settings.updateSettings({
        providers: { gemini: { enabled: true, binaryPath: cliPath } },
      });

      const result = yield* textGen.generateCommitMessage({
        cwd: process.cwd(),
        branch: "main",
        stagedSummary: "a file changed",
        stagedPatch: "diff --git ...",
        modelSelection: { provider: "gemini", model: "auto" },
      });
      expect(result.subject).toBe("fix: retry worked");
      expect(result.body).toBe("Second attempt body.");

      // Exactly two CLI invocations; the retry carries the explicit
      // "return valid JSON only" tail.
      const calls = readLoggedCalls(argsLog);
      expect(calls).toHaveLength(2);
      expect(argAfter(calls[0]!.args, "--prompt")).not.toContain("Return valid JSON only.");
      expect(argAfter(calls[1]!.args, "--prompt")).toContain("Return valid JSON only.");
      // "auto" means no `--model` flag on either call.
      for (const call of calls) {
        expect(call.args).not.toContain("--model");
      }
    }),
  );

  it.effect("raises TextGenerationError after two malformed JSON responses", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsService;
      const textGen = yield* TextGeneration;
      const dir = mkdtempSync(path.join(os.tmpdir(), "t3code-gemini-text-fail-"));
      const argsLog = path.join(dir, "args.log");
      const cliPath = makeFakeGeminiCli({
        dir,
        argsLog,
        responses: [{ stdout: envelope("still bad") }, { stdout: envelope("still bad again") }],
      });
      yield* settings.updateSettings({
        providers: { gemini: { enabled: true, binaryPath: cliPath } },
      });

      const exit = yield* textGen
        .generateCommitMessage({
          cwd: process.cwd(),
          branch: "main",
          stagedSummary: "x",
          stagedPatch: "y",
          modelSelection: { provider: "gemini", model: "auto" },
        })
        .pipe(Effect.exit);
      expect(exit._tag).toBe("Failure");
    }),
  );

  it.effect("injects --include-directories + @{...} tokens when attachments are present", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsService;
      const config = yield* ServerConfig;
      const textGen = yield* TextGeneration;

      const attachmentId = "abc1";
      const attachmentName = "diagram.png";
      const attachmentPath = path.join(config.attachmentsDir, `${attachmentId}.png`);
      mkdirSync(path.dirname(attachmentPath), { recursive: true });
      writeFileSync(attachmentPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

      const dir = mkdtempSync(path.join(os.tmpdir(), "t3code-gemini-text-attach-"));
      const argsLog = path.join(dir, "args.log");
      const cliPath = makeFakeGeminiCli({
        dir,
        argsLog,
        responses: [{ stdout: envelope(JSON.stringify({ branch: "feature/bubble" })) }],
      });
      yield* settings.updateSettings({
        providers: { gemini: { enabled: true, binaryPath: cliPath } },
      });

      const result = yield* textGen.generateBranchName({
        cwd: process.cwd(),
        message: "add a floating button",
        attachments: [
          {
            type: "image",
            id: attachmentId,
            name: attachmentName,
            mimeType: "image/png",
            sizeBytes: 4,
          },
        ],
        modelSelection: { provider: "gemini", model: "auto" },
      });
      expect(typeof result.branch).toBe("string");
      expect(result.branch.length).toBeGreaterThan(0);

      const calls = readLoggedCalls(argsLog);
      expect(calls).toHaveLength(1);
      const includeDir = argAfter(calls[0]!.args, "--include-directories");
      expect(includeDir).toBeDefined();
      // Cleanup already ran by the time we get here — assert on the prompt
      // rather than the staging dir's existence.
      const promptArg = argAfter(calls[0]!.args, "--prompt");
      expect(promptArg).toBeDefined();
      expect(promptArg).toContain("@{");
    }),
  );

  it.effect("rejects the request when the model selection is not Gemini", () =>
    Effect.gen(function* () {
      const textGen = yield* TextGeneration;
      const exit = yield* textGen
        .generateCommitMessage({
          cwd: process.cwd(),
          branch: null,
          stagedSummary: "x",
          stagedPatch: "y",
          modelSelection: { provider: "codex", model: "gpt-5.4-mini" },
        } as never)
        .pipe(Effect.exit);
      expect(exit._tag).toBe("Failure");
    }),
  );
});

export type _Unused = ServerSettingsError;
