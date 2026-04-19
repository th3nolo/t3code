import * as path from "node:path";
import * as os from "node:os";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect } from "vitest";

import { ServerSettingsService } from "../../serverSettings.ts";
import {
  checkGeminiProviderStatus,
  discoverGeminiCapabilitiesViaAcp,
  getGeminiBuiltInModels,
} from "./GeminiProvider.ts";

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const geminiMockAgentPath = path.join(__dirname, "../../../scripts/gemini-acp-mock-agent.ts");

function makeFakeGeminiCli(input: {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
}): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "t3code-gemini-provider-test-"));
  const binDir = path.join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const cliPath = path.join(binDir, "gemini");
  const stdoutLine = input.stdout?.replace(/\n$/, "") ?? "";
  const stderrLine = input.stderr?.replace(/\n$/, "") ?? "";
  const script = [
    "#!/bin/sh",
    stdoutLine.length > 0 ? `echo ${shellSingleQuote(stdoutLine)}` : "",
    stderrLine.length > 0 ? `echo ${shellSingleQuote(stderrLine)} >&2` : "",
    `exit ${input.exitCode ?? 0}`,
    "",
  ]
    .filter((line) => line.length > 0 || line === "")
    .join("\n");
  writeFileSync(cliPath, script, "utf8");
  chmodSync(cliPath, 0o755);
  return cliPath;
}

async function makeGeminiAcpWrapper(input: {
  readonly argvLogPath: string;
  readonly supportedFlavor: "acp" | "experimental-acp";
}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "t3code-gemini-provider-acp-"));
  const wrapperPath = path.join(dir, "fake-gemini.sh");
  const script = `#!/bin/sh
printf '%s\t' "$@" >> ${JSON.stringify(input.argvLogPath)}
printf '\n' >> ${JSON.stringify(input.argvLogPath)}
for arg in "$@"; do
  if [ "$arg" = "--${input.supportedFlavor}" ]; then
    exec ${JSON.stringify("bun")} ${JSON.stringify(geminiMockAgentPath)} "$@"
  fi
done
exit 9
`;
  await writeFile(wrapperPath, script, "utf8");
  await chmod(wrapperPath, 0o755);
  return wrapperPath;
}

async function readArgvLog(filePath: string) {
  const raw = await readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split("\t").filter((token) => token.length > 0));
}

const TestLayer = Layer.mergeAll(ServerSettingsService.layerTest(), NodeServices.layer);

effectIt.layer(TestLayer)("checkGeminiProviderStatus", (it) => {
  it.effect("returns disabled when settings disable Gemini", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsService;
      yield* settings.updateSettings({ providers: { gemini: { enabled: false } } });
      const snapshot = yield* checkGeminiProviderStatus();
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("disabled");
    }),
  );

  it.effect("reports error + installed=false when binary is missing on PATH", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsService;
      yield* settings.updateSettings({
        providers: { gemini: { enabled: true, binaryPath: "/nonexistent/gemini-binary-xyz" } },
      });
      const snapshot = yield* checkGeminiProviderStatus();
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.auth.status).toBe("unknown");
    }),
  );

  it.effect("rejects reserved launchArgs with an installed-but-error state", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsService;
      const cliPath = makeFakeGeminiCli({ stdout: "gemini 2.5.0\n" });
      yield* settings.updateSettings({
        providers: {
          gemini: { enabled: true, binaryPath: cliPath, launchArgs: "--acp foo" },
        },
      });
      const snapshot = yield* checkGeminiProviderStatus();
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toBeDefined();
      expect(snapshot.message).toContain("acp");
    }),
  );

  it.effect("returns 'warning' when CLI works but no auth env or disk creds exist", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsService;
      const cliPath = makeFakeGeminiCli({ stdout: "gemini 2.5.0" });
      // Reset launchArgs from potentially-leaky prior tests
      yield* settings.updateSettings({
        providers: { gemini: { enabled: true, binaryPath: cliPath, launchArgs: "" } },
      });
      // Point HOME at a fresh tempdir so the disk-based OAuth check sees
      // nothing. Save/restore the previous value.
      const savedHome = process.env["HOME"];
      const fakeHome = mkdtempSync(path.join(os.tmpdir(), "t3code-gemini-home-"));
      process.env["HOME"] = fakeHome;
      for (const key of [
        "GEMINI_API_KEY",
        "GOOGLE_GENAI_USE_VERTEXAI",
        "CLOUD_SHELL",
        "GEMINI_CLI_USE_COMPUTE_ADC",
        "GOOGLE_GENAI_USE_GCA",
      ]) {
        delete process.env[key];
      }
      try {
        const snapshot = yield* checkGeminiProviderStatus();
        expect(snapshot.enabled).toBe(true);
        expect(snapshot.installed).toBe(true);
        expect(snapshot.status).toBe("warning");
        // Probe completed and conclusively found no auth — surface that
        // explicitly so enrichSnapshot's unauthenticated-skip can fire.
        expect(snapshot.auth.status).toBe("unauthenticated");
        expect(snapshot.message).toContain("gemini auth login");
      } finally {
        if (savedHome !== undefined) {
          process.env["HOME"] = savedHome;
        } else {
          delete process.env["HOME"];
        }
      }
    }),
  );

  it.effect("flips to 'ready' when oauth_creds.json is present on disk", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsService;
      const cliPath = makeFakeGeminiCli({ stdout: "gemini 2.5.0" });
      yield* settings.updateSettings({
        providers: { gemini: { enabled: true, binaryPath: cliPath, launchArgs: "" } },
      });

      const savedHome = process.env["HOME"];
      const fakeHome = mkdtempSync(path.join(os.tmpdir(), "t3code-gemini-oauth-home-"));
      mkdirSync(path.join(fakeHome, ".gemini"), { recursive: true });
      writeFileSync(
        path.join(fakeHome, ".gemini", "oauth_creds.json"),
        JSON.stringify({ access_token: "abc" }),
        "utf8",
      );
      process.env["HOME"] = fakeHome;
      for (const key of [
        "GEMINI_API_KEY",
        "GOOGLE_GENAI_USE_VERTEXAI",
        "CLOUD_SHELL",
        "GEMINI_CLI_USE_COMPUTE_ADC",
        "GOOGLE_GENAI_USE_GCA",
      ]) {
        delete process.env[key];
      }
      try {
        const snapshot = yield* checkGeminiProviderStatus();
        expect(snapshot.enabled).toBe(true);
        expect(snapshot.installed).toBe(true);
        expect(snapshot.status).toBe("ready");
        expect(snapshot.auth.status).toBe("authenticated");
      } finally {
        if (savedHome !== undefined) {
          process.env["HOME"] = savedHome;
        } else {
          delete process.env["HOME"];
        }
      }
    }),
  );

  it.effect("surfaces custom models alongside built-in models", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsService;
      const cliPath = makeFakeGeminiCli({ stdout: "gemini 2.5.0" });
      yield* settings.updateSettings({
        providers: {
          gemini: {
            enabled: true,
            binaryPath: cliPath,
            launchArgs: "",
            customModels: ["gemini-custom-one", "gemini-custom-two"],
          },
        },
      });
      const snapshot = yield* checkGeminiProviderStatus();
      const slugs = snapshot.models.map((model) => model.slug);
      for (const builtIn of getGeminiBuiltInModels()) {
        expect(slugs).toContain(builtIn.slug);
      }
      expect(slugs).toContain("gemini-custom-one");
      expect(slugs).toContain("gemini-custom-two");
    }),
  );
});

effectIt.layer(NodeServices.layer)("discoverGeminiCapabilitiesViaAcp", (it) => {
  it.effect("reuses the resolved experimental ACP flavor across capability probes", () =>
    Effect.gen(function* () {
      const tempDir = yield* Effect.promise(() =>
        mkdtemp(path.join(os.tmpdir(), "t3code-gemini-provider-argv-")),
      );
      const argvLogPath = path.join(tempDir, "argv.txt");
      yield* Effect.promise(() => writeFile(argvLogPath, "", "utf8"));
      const wrapperPath = yield* Effect.promise(() =>
        makeGeminiAcpWrapper({
          argvLogPath,
          supportedFlavor: "experimental-acp",
        }),
      );

      const models = yield* discoverGeminiCapabilitiesViaAcp({
        geminiSettings: {
          enabled: true,
          binaryPath: wrapperPath,
          launchArgs: "",
          customModels: [],
        },
        existingModels: getGeminiBuiltInModels(),
      });

      expect(models.map((model) => model.slug)).toEqual([
        "auto",
        "gemini-3.1-pro-preview",
        "gemini-3-flash-preview",
        "gemini-2.5-pro",
        "gemini-2.5-flash",
      ]);

      const argvLog = yield* Effect.promise(() => readArgvLog(argvLogPath));
      const acpAttempts = argvLog.filter((argv) => argv.includes("--acp"));
      const experimentalAttempts = argvLog.filter((argv) => argv.includes("--experimental-acp"));

      expect(acpAttempts.length).toBeGreaterThanOrEqual(1);
      expect(experimentalAttempts.length).toBeGreaterThanOrEqual(2);
      expect(argvLog.some((argv) => argv.includes("--experimental-acp"))).toBe(true);
    }),
  );
});
