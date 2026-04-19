import * as nodePath from "node:path";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as nodeOs from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type * as EffectAcpSchema from "effect-acp/schema";
import { it as effectIt } from "@effect/vitest";
import { Effect, FileSystem, SynchronizedRef } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyGeminiAcpConfigOptions,
  applyGeminiAcpModel,
  buildGeminiAcpSpawnInput,
  buildGeminiCapabilitiesFromConfigOptions,
  findGeminiEffortConfigOption,
  findGeminiThinkingConfigOption,
  GEMINI_RESERVED_FLAGS,
  type GeminiAcpFlavor,
  resolveCachedGeminiFlavor,
  resolveGeminiAcpConfigUpdates,
  resolveGeminiAuthMethod,
  resolveGeminiAuthMethodFromDisk,
  resolveGeminiAuthMethodFromEnv,
  resolveGeminiUserLaunchArgs,
  seedGeminiCliHomeAuth,
  validateGeminiLaunchArgs,
  writeGeminiCliSettings,
} from "./GeminiAcpSupport.ts";

describe("validateGeminiLaunchArgs", () => {
  it("accepts undefined, null, and empty strings", () => {
    expect(validateGeminiLaunchArgs(undefined)).toBeUndefined();
    expect(validateGeminiLaunchArgs(null)).toBeUndefined();
    expect(validateGeminiLaunchArgs("")).toBeUndefined();
    expect(validateGeminiLaunchArgs("   ")).toBeUndefined();
  });

  it("accepts harmless user flags", () => {
    expect(validateGeminiLaunchArgs("--verbose --telemetry false")).toBeUndefined();
  });

  it("rejects every reserved flag", () => {
    for (const flag of GEMINI_RESERVED_FLAGS) {
      const error = validateGeminiLaunchArgs(`--${flag} something`);
      expect(error, `expected --${flag} to be rejected`).toBeDefined();
      expect(error?.flag).toBe(flag);
    }
  });

  it("surfaces the specific reserved flag in the error message", () => {
    const error = validateGeminiLaunchArgs("--model foo --prompt bar");
    expect(error).toBeDefined();
    expect(error?.message).toContain("--model");
  });
});

describe("resolveGeminiUserLaunchArgs", () => {
  it("returns empty argv for blank input", () => {
    expect(resolveGeminiUserLaunchArgs(null)).toEqual({ argv: [], error: undefined });
    expect(resolveGeminiUserLaunchArgs("")).toEqual({ argv: [], error: undefined });
  });

  it("splits quoted shell words and unescapes backslashes", () => {
    const result = resolveGeminiUserLaunchArgs("--foo 'hello world' --bar baz\\space");
    expect(result.error).toBeUndefined();
    expect(result.argv).toEqual(["--foo", "hello world", "--bar", "bazspace"]);
  });

  it("returns the error and an empty argv for reserved flags", () => {
    const result = resolveGeminiUserLaunchArgs("--acp --verbose");
    expect(result.argv).toEqual([]);
    expect(result.error?.flag).toBe("acp");
  });
});

describe("buildGeminiAcpSpawnInput", () => {
  it("defaults to `gemini --acp` when no settings are provided", () => {
    const spawn = buildGeminiAcpSpawnInput({
      geminiSettings: undefined,
      cwd: "/tmp/project",
    });
    expect(spawn.command).toBe("gemini");
    expect(spawn.args).toEqual(["--acp"]);
    expect(spawn.cwd).toBe("/tmp/project");
    // Even without a home override we still emit keyring neutralizers —
    // otherwise the inherited process.env would reach libsecret.
    expect(spawn.env?.["DBUS_SESSION_BUS_ADDRESS"]).toBe("");
    expect(spawn.env?.["GNOME_KEYRING_CONTROL"]).toBe("");
    expect(spawn.env?.["GNOME_KEYRING_PID"]).toBe("");
  });

  it("honours custom binary, launchArgs, includeDirectories, and flavor", () => {
    const spawn = buildGeminiAcpSpawnInput({
      geminiSettings: {
        binaryPath: "/usr/local/bin/gemini",
        launchArgs: "--verbose --telemetry false",
      },
      cwd: "/tmp/project",
      overrides: {
        includeDirectories: ["/abs/path/a", "/abs/path/b"],
        flavor: "experimental-acp",
        env: { FOO: "bar" },
        home: "/tmp/home",
      },
    });
    expect(spawn.command).toBe("/usr/local/bin/gemini");
    expect(spawn.args).toEqual([
      "--verbose",
      "--telemetry",
      "false",
      "--include-directories",
      "/abs/path/a,/abs/path/b",
      "--experimental-acp",
    ]);
    expect(spawn.env).toEqual({
      // Keyring neutralizers land first and persist through user overrides.
      DBUS_SESSION_BUS_ADDRESS: "",
      DBUS_SYSTEM_BUS_ADDRESS: "",
      GNOME_KEYRING_CONTROL: "",
      GNOME_KEYRING_PID: "",
      FOO: "bar",
      HOME: "/tmp/home",
      USERPROFILE: "/tmp/home",
    });
  });

  it("drops reserved user launchArgs to a safe baseline", () => {
    const spawn = buildGeminiAcpSpawnInput({
      geminiSettings: { binaryPath: "gemini", launchArgs: "--acp --model foo" },
      cwd: "/tmp/project",
    });
    expect(spawn.args).toEqual(["--acp"]);
  });

  it("lets callers re-enable specific keyring vars via the env override", () => {
    const spawn = buildGeminiAcpSpawnInput({
      geminiSettings: undefined,
      cwd: "/tmp/project",
      overrides: {
        env: { DBUS_SESSION_BUS_ADDRESS: "unix:abstract=/tmp/bus" },
      },
    });
    expect(spawn.env?.["DBUS_SESSION_BUS_ADDRESS"]).toBe("unix:abstract=/tmp/bus");
    // The others we didn't override stay neutralized.
    expect(spawn.env?.["GNOME_KEYRING_CONTROL"]).toBe("");
  });
});

describe("resolveGeminiAuthMethodFromDisk", () => {
  let homeDir = "";

  beforeEach(() => {
    homeDir = mkdtempSync(nodePath.join(nodeOs.tmpdir(), "t3code-gemini-home-"));
    mkdirSync(nodePath.join(homeDir, ".gemini"), { recursive: true });
  });

  afterEach(() => {
    if (homeDir.length > 0) {
      rmSync(homeDir, { recursive: true, force: true });
      homeDir = "";
    }
  });

  it("returns undefined when no oauth_creds.json exists", () => {
    expect(resolveGeminiAuthMethodFromDisk({ homeDir })).toBeUndefined();
  });

  it("returns oauth-personal when oauth_creds.json exists and is non-empty", () => {
    const credsPath = nodePath.join(homeDir, ".gemini", "oauth_creds.json");
    writeFileSync(credsPath, JSON.stringify({ access_token: "abc" }), "utf8");
    chmodSync(credsPath, 0o600);
    expect(resolveGeminiAuthMethodFromDisk({ homeDir })).toBe("oauth-personal");
  });

  it("ignores empty oauth_creds.json", () => {
    const credsPath = nodePath.join(homeDir, ".gemini", "oauth_creds.json");
    writeFileSync(credsPath, "", "utf8");
    expect(resolveGeminiAuthMethodFromDisk({ homeDir })).toBeUndefined();
  });
});

describe("resolveGeminiAuthMethod", () => {
  let homeDir = "";

  beforeEach(() => {
    homeDir = mkdtempSync(nodePath.join(nodeOs.tmpdir(), "t3code-gemini-home-"));
    mkdirSync(nodePath.join(homeDir, ".gemini"), { recursive: true });
  });

  afterEach(() => {
    if (homeDir.length > 0) {
      rmSync(homeDir, { recursive: true, force: true });
      homeDir = "";
    }
  });

  it("prefers env var over disk creds", () => {
    writeFileSync(
      nodePath.join(homeDir, ".gemini", "oauth_creds.json"),
      JSON.stringify({ access_token: "abc" }),
      "utf8",
    );
    expect(resolveGeminiAuthMethod({ env: { GEMINI_API_KEY: "xyz" }, homeDir })).toBe(
      "gemini-api-key",
    );
  });

  it("falls back to on-disk OAuth when no env matches", () => {
    writeFileSync(
      nodePath.join(homeDir, ".gemini", "oauth_creds.json"),
      JSON.stringify({ access_token: "abc" }),
      "utf8",
    );
    expect(resolveGeminiAuthMethod({ env: {}, homeDir })).toBe("oauth-personal");
  });

  it("returns undefined when neither env nor disk is configured", () => {
    expect(resolveGeminiAuthMethod({ env: {}, homeDir })).toBeUndefined();
  });
});

describe("resolveGeminiAuthMethodFromEnv", () => {
  it("detects GEMINI_API_KEY first", () => {
    expect(resolveGeminiAuthMethodFromEnv({ GEMINI_API_KEY: "abc" })).toBe("gemini-api-key");
  });

  it("detects Vertex AI via GOOGLE_GENAI_USE_VERTEXAI", () => {
    expect(resolveGeminiAuthMethodFromEnv({ GOOGLE_GENAI_USE_VERTEXAI: "true" })).toBe("vertex-ai");
    expect(resolveGeminiAuthMethodFromEnv({ GOOGLE_GENAI_USE_VERTEXAI: "1" })).toBe("vertex-ai");
  });

  it("detects compute default credentials via CLOUD_SHELL or GEMINI_CLI_USE_COMPUTE_ADC", () => {
    expect(resolveGeminiAuthMethodFromEnv({ CLOUD_SHELL: "true" })).toBe(
      "compute-default-credentials",
    );
    expect(resolveGeminiAuthMethodFromEnv({ GEMINI_CLI_USE_COMPUTE_ADC: "yes" })).toBe(
      "compute-default-credentials",
    );
  });

  it("detects oauth-personal via GOOGLE_GENAI_USE_GCA", () => {
    expect(resolveGeminiAuthMethodFromEnv({ GOOGLE_GENAI_USE_GCA: "true" })).toBe("oauth-personal");
  });

  it("returns undefined when no recognised env is set", () => {
    expect(resolveGeminiAuthMethodFromEnv({})).toBeUndefined();
    expect(resolveGeminiAuthMethodFromEnv({ GEMINI_API_KEY: "   " })).toBeUndefined();
    expect(resolveGeminiAuthMethodFromEnv({ GOOGLE_GENAI_USE_VERTEXAI: "0" })).toBeUndefined();
  });
});

effectIt.layer(NodeServices.layer)("writeGeminiCliSettings", (it) => {
  it.effect("writes settings.json under <home>/.gemini/ with the expected security flags", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-gemini-settings-" });
      // A fresh userHomeDir with no `.gemini/` — keeps disk auth detection
      // from flipping `auth.selectedType` to whatever the test machine has
      // on its real ~/.gemini/.
      const userHomeDir = yield* fs.makeTempDirectoryScoped({
        prefix: "t3code-gemini-fake-user-",
      });

      const settingsPath = yield* writeGeminiCliSettings({ home, env: {}, userHomeDir });
      expect(settingsPath).toBe(nodePath.join(home, ".gemini", "settings.json"));

      const raw = readFileSync(settingsPath, "utf8");
      const parsed = JSON.parse(raw) as {
        readonly general: { readonly checkpointing: { readonly enabled: boolean } };
        readonly security: {
          readonly folderTrust: { readonly enabled: boolean };
          readonly toolSandboxing: boolean;
          readonly auth?: { readonly selectedType: string };
        };
      };
      expect(parsed.general.checkpointing.enabled).toBe(false);
      expect(parsed.security.folderTrust.enabled).toBe(false);
      expect(parsed.security.toolSandboxing).toBe(false);
      expect(parsed.security.auth).toBeUndefined();
    }),
  );

  it.effect("includes security.auth when the env implies one", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-gemini-settings-auth-" });
      const settingsPath = yield* writeGeminiCliSettings({
        home,
        env: { GEMINI_API_KEY: "example" },
      });
      const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as {
        readonly security: { readonly auth?: { readonly selectedType: string } };
      };
      expect(parsed.security.auth?.selectedType).toBe("gemini-api-key");
    }),
  );
});

effectIt.layer(NodeServices.layer)("seedGeminiCliHomeAuth", (it) => {
  it.effect("copies oauth creds / account list / installation id into <home>/.gemini/", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const userHomeDir = yield* fs.makeTempDirectoryScoped({
        prefix: "t3code-gemini-seed-user-",
      });
      const sourceGemini = nodePath.join(userHomeDir, ".gemini");
      yield* fs.makeDirectory(sourceGemini, { recursive: true });
      writeFileSync(
        nodePath.join(sourceGemini, "oauth_creds.json"),
        JSON.stringify({ access_token: "abc" }),
        "utf8",
      );
      writeFileSync(
        nodePath.join(sourceGemini, "google_accounts.json"),
        JSON.stringify({ accounts: ["user@example.com"] }),
        "utf8",
      );
      writeFileSync(nodePath.join(sourceGemini, "installation_id"), "install-123", "utf8");
      // Stray file that MUST NOT be copied (not on the seed allow-list).
      writeFileSync(nodePath.join(sourceGemini, "history.db"), "DO NOT COPY", "utf8");

      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-gemini-seed-dest-" });
      const seeded = yield* seedGeminiCliHomeAuth({ home, userHomeDir });
      expect([...seeded].sort()).toEqual(
        ["google_accounts.json", "installation_id", "oauth_creds.json"].sort(),
      );

      const destGemini = nodePath.join(home, ".gemini");
      expect(readFileSync(nodePath.join(destGemini, "oauth_creds.json"), "utf8")).toContain(
        "access_token",
      );
      expect(readFileSync(nodePath.join(destGemini, "installation_id"), "utf8")).toBe(
        "install-123",
      );
      expect(() => readFileSync(nodePath.join(destGemini, "history.db"), "utf8")).toThrow();
    }),
  );

  it.effect("returns an empty list and does nothing when the source has no creds", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const userHomeDir = yield* fs.makeTempDirectoryScoped({
        prefix: "t3code-gemini-seed-empty-user-",
      });
      const home = yield* fs.makeTempDirectoryScoped({
        prefix: "t3code-gemini-seed-empty-dest-",
      });
      const seeded = yield* seedGeminiCliHomeAuth({ home, userHomeDir });
      expect(seeded).toEqual([]);
    }),
  );
});

// A minimal Gemini-shaped config set that exercises each capability branch
// plus one unrecognised option that should be ignored. Matches the CLI
// idiom: category strings vary by release; we match on id/name heuristics.
const sampleGeminiConfigOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "gemini-3.1-pro-preview",
    options: [
      { value: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro" },
      { value: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    ],
  },
  {
    id: "effort",
    name: "Reasoning effort",
    category: "model_option",
    type: "select",
    currentValue: "medium",
    options: [
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
      { value: "max", name: "Max" },
    ],
  },
  {
    id: "thinking",
    name: "Thinking",
    category: "model_option",
    type: "boolean",
    currentValue: true,
  },
  {
    id: "context",
    name: "Context window",
    category: "model_config",
    type: "select",
    currentValue: "1m",
    options: [
      { value: "1m", name: "1M tokens" },
      { value: "2m", name: "2M tokens" },
    ],
  },
];

describe("buildGeminiCapabilitiesFromConfigOptions", () => {
  it("returns empty caps for undefined or empty input", () => {
    expect(buildGeminiCapabilitiesFromConfigOptions(undefined)).toEqual({
      reasoningEffortLevels: [],
      supportsFastMode: false,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    });
    expect(buildGeminiCapabilitiesFromConfigOptions([])).toEqual({
      reasoningEffortLevels: [],
      supportsFastMode: false,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    });
  });

  it("translates effort, thinking, and context options into capabilities", () => {
    const caps = buildGeminiCapabilitiesFromConfigOptions(sampleGeminiConfigOptions);
    expect(caps.supportsThinkingToggle).toBe(true);
    expect(caps.supportsFastMode).toBe(false);
    expect(caps.reasoningEffortLevels.map((entry) => entry.value)).toEqual([
      "low",
      "medium",
      "high",
      "max",
    ]);
    expect(caps.reasoningEffortLevels.find((entry) => entry.isDefault)?.value).toBe("medium");
    expect(caps.contextWindowOptions.map((entry) => entry.value)).toEqual(["1m", "2m"]);
    expect(caps.contextWindowOptions.find((entry) => entry.isDefault)?.value).toBe("1m");
  });

  it("normalizes synonyms of the max effort level", () => {
    const caps = buildGeminiCapabilitiesFromConfigOptions([
      {
        id: "effort",
        name: "Effort",
        category: "model_option",
        type: "select",
        currentValue: "extra-high",
        options: [
          { value: "low", name: "Low" },
          { value: "extra-high", name: "Extra High" },
        ],
      },
    ]);
    expect(caps.reasoningEffortLevels.map((entry) => entry.value)).toEqual(["low", "max"]);
  });

  it("detects thinking as a select with true/false values (not just booleans)", () => {
    const option = findGeminiThinkingConfigOption([
      {
        id: "thinking_mode",
        name: "Thinking",
        category: "model_option",
        type: "select",
        currentValue: "true",
        options: [
          { value: "true", name: "On" },
          { value: "false", name: "Off" },
        ],
      },
    ]);
    expect(option).toBeDefined();
  });

  it("finds the effort config option across common id/name variants", () => {
    const byReasoning = findGeminiEffortConfigOption([
      {
        id: "reasoning",
        name: "Reasoning",
        category: "thought_level",
        type: "select",
        currentValue: "medium",
        options: [{ value: "medium", name: "Medium" }],
      },
    ]);
    expect(byReasoning?.id).toBe("reasoning");

    const byThinkingBudget = findGeminiEffortConfigOption([
      {
        id: "thinking_budget",
        name: "Thinking budget",
        category: "model_option",
        type: "select",
        currentValue: "low",
        options: [{ value: "low", name: "Low" }],
      },
    ]);
    expect(byThinkingBudget?.id).toBe("thinking_budget");
  });
});

describe("resolveGeminiAcpConfigUpdates", () => {
  it("emits updates for thinking, effort, and context that actually exist on the session", () => {
    const updates = resolveGeminiAcpConfigUpdates(sampleGeminiConfigOptions, {
      thinking: false,
      effort: "high",
      contextWindow: "2m",
    });
    expect(updates).toEqual([
      { configId: "effort", value: "high" },
      { configId: "context", value: "2m" },
      { configId: "thinking", value: false },
    ]);
  });

  it("skips options the CLI doesn't expose", () => {
    // Only model + thinking on this session; effort + context should no-op.
    const minimalOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> = [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "gemini-2.5-pro",
        options: [{ value: "gemini-2.5-pro", name: "Gemini 2.5 Pro" }],
      },
      {
        id: "thinking",
        name: "Thinking",
        category: "model_option",
        type: "boolean",
        currentValue: true,
      },
    ];
    const updates = resolveGeminiAcpConfigUpdates(minimalOptions, {
      thinking: true,
      effort: "high",
      contextWindow: "2m",
    });
    expect(updates).toEqual([{ configId: "thinking", value: true }]);
  });

  it("returns [] for empty/undefined inputs", () => {
    expect(resolveGeminiAcpConfigUpdates(undefined, { thinking: true })).toEqual([]);
    expect(resolveGeminiAcpConfigUpdates([], { thinking: true })).toEqual([]);
    expect(resolveGeminiAcpConfigUpdates(sampleGeminiConfigOptions, null)).toEqual([]);
  });
});

describe("applyGeminiAcpModel", () => {
  it("issues setModel for a non-trivial slug", async () => {
    const calls: Array<string> = [];
    const runtime = {
      setModel: (value: string) =>
        Effect.sync(() => {
          calls.push(`model:${value}`);
        }),
    };
    await Effect.runPromise(
      applyGeminiAcpModel({
        runtime: runtime as unknown as Parameters<typeof applyGeminiAcpModel>[0]["runtime"],
        model: "gemini-3.1-pro-preview",
        mapError: ({ cause }) => new Error(`failed to set model: ${cause.message}`),
      }),
    );
    expect(calls).toEqual(["model:gemini-3.1-pro-preview"]);
  });

  it("is a no-op when the slug is `auto` (lets Gemini CLI pick)", async () => {
    const calls: Array<string> = [];
    const runtime = {
      setModel: (value: string) =>
        Effect.sync(() => {
          calls.push(`model:${value}`);
        }),
    };
    await Effect.runPromise(
      applyGeminiAcpModel({
        runtime: runtime as unknown as Parameters<typeof applyGeminiAcpModel>[0]["runtime"],
        model: "auto",
        mapError: ({ cause }) => new Error(cause.message),
      }),
    );
    expect(calls).toEqual([]);
  });
});

describe("applyGeminiAcpConfigOptions", () => {
  it("applies each option update from the session's exposed configOptions", async () => {
    const calls: Array<{ readonly configId: string; readonly value: string | boolean }> = [];
    const runtime = {
      getConfigOptions: Effect.succeed(sampleGeminiConfigOptions),
      setConfigOption: (configId: string, value: string | boolean) =>
        Effect.sync(() => {
          calls.push({ configId, value });
        }),
    };

    await Effect.runPromise(
      applyGeminiAcpConfigOptions({
        runtime: runtime as unknown as Parameters<typeof applyGeminiAcpConfigOptions>[0]["runtime"],
        modelOptions: { thinking: false, effort: "high", contextWindow: "2m" },
        mapError: ({ configId, cause }) => new Error(`failed to set ${configId}: ${cause.message}`),
      }),
    );

    expect(calls).toEqual([
      { configId: "effort", value: "high" },
      { configId: "context", value: "2m" },
      { configId: "thinking", value: false },
    ]);
  });

  it("is a no-op when modelOptions is null", async () => {
    const calls: Array<string> = [];
    const runtime = {
      getConfigOptions: Effect.succeed([] as ReadonlyArray<EffectAcpSchema.SessionConfigOption>),
      setConfigOption: (configId: string, value: string | boolean) =>
        Effect.sync(() => {
          calls.push(`${configId}=${String(value)}`);
        }),
    };
    await Effect.runPromise(
      applyGeminiAcpConfigOptions({
        runtime: runtime as unknown as Parameters<typeof applyGeminiAcpConfigOptions>[0]["runtime"],
        modelOptions: null,
        mapError: ({ cause }) => new Error(cause.message),
      }),
    );
    expect(calls).toEqual([]);
  });
});

describe("resolveCachedGeminiFlavor", () => {
  effectIt("probes once per binary path and reuses the cached flavor", () =>
    Effect.gen(function* () {
      const cacheRef = yield* SynchronizedRef.make(new Map<string, GeminiAcpFlavor>());
      let probeCalls = 0;
      const probe = Effect.sync<GeminiAcpFlavor>(() => {
        probeCalls += 1;
        return "acp";
      });

      const first = yield* resolveCachedGeminiFlavor({
        cacheRef,
        binaryPath: "/usr/bin/gemini",
        probe,
      });
      const second = yield* resolveCachedGeminiFlavor({
        cacheRef,
        binaryPath: "/usr/bin/gemini",
        probe,
      });
      const third = yield* resolveCachedGeminiFlavor({
        cacheRef,
        binaryPath: "/usr/bin/gemini",
        probe,
      });

      expect(first).toBe("acp");
      expect(second).toBe("acp");
      expect(third).toBe("acp");
      expect(probeCalls).toBe(1);
    }),
  );

  effectIt("probes separately for different binary paths", () =>
    Effect.gen(function* () {
      const cacheRef = yield* SynchronizedRef.make(new Map<string, GeminiAcpFlavor>());
      const flavorsByPath: Record<string, GeminiAcpFlavor> = {
        "/usr/bin/gemini": "acp",
        "/opt/gemini/gemini": "experimental-acp",
      };
      const probedPaths: Array<string> = [];
      const makeProbe = (path: string) =>
        Effect.sync<GeminiAcpFlavor>(() => {
          probedPaths.push(path);
          return flavorsByPath[path] ?? "acp";
        });

      const first = yield* resolveCachedGeminiFlavor({
        cacheRef,
        binaryPath: "/usr/bin/gemini",
        probe: makeProbe("/usr/bin/gemini"),
      });
      const second = yield* resolveCachedGeminiFlavor({
        cacheRef,
        binaryPath: "/opt/gemini/gemini",
        probe: makeProbe("/opt/gemini/gemini"),
      });
      const third = yield* resolveCachedGeminiFlavor({
        cacheRef,
        binaryPath: "/usr/bin/gemini",
        probe: makeProbe("/usr/bin/gemini"),
      });

      expect(first).toBe("acp");
      expect(second).toBe("experimental-acp");
      expect(third).toBe("acp");
      expect(probedPaths).toEqual(["/usr/bin/gemini", "/opt/gemini/gemini"]);
    }),
  );
});
