import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";

import {
  type GeminiModelOptions,
  type GeminiSettings,
  type ModelCapabilities,
} from "@t3tools/contracts";
import { parseCliArgs } from "@t3tools/shared/cliArgs";
import { Cause, Effect, Exit, FileSystem, Layer, Scope, SynchronizedRef } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  AcpSessionRuntime,
  type AcpSessionRuntimeOptions,
  type AcpSessionRuntimeShape,
  type AcpSpawnInput,
} from "./AcpSessionRuntime.ts";

export const GEMINI_RESERVED_FLAGS: ReadonlyArray<string> = [
  "acp",
  "experimental-acp",
  "prompt",
  "output-format",
  "model",
  "approval-mode",
  "sandbox",
  "resume",
  "list-sessions",
  "delete-session",
];

const GEMINI_ACP_PROBE_TIMEOUT = "8 seconds";
const GEMINI_ACP_FLAVOR_CANDIDATES = ["acp", "experimental-acp"] as const;

export interface GeminiReservedFlagError {
  readonly flag: string;
  readonly message: string;
}

export type GeminiAuthType =
  | "gemini-api-key"
  | "vertex-ai"
  | "compute-default-credentials"
  | "oauth-personal";

export type GeminiAcpFlavor = (typeof GEMINI_ACP_FLAVOR_CANDIDATES)[number];

type GeminiAcpRuntimeGeminiSettings = Pick<GeminiSettings, "binaryPath" | "launchArgs">;

export interface GeminiUserLaunchArgs {
  readonly argv: ReadonlyArray<string>;
  readonly error: GeminiReservedFlagError | undefined;
}

export interface GeminiCliSettingsJson {
  readonly general: {
    readonly checkpointing: { readonly enabled: false };
  };
  readonly security: {
    readonly auth?: {
      readonly selectedType: GeminiAuthType;
    };
    readonly folderTrust: { readonly enabled: false };
    readonly toolSandboxing: false;
  };
}

export const GEMINI_DEFAULT_CLI_SETTINGS: Omit<GeminiCliSettingsJson, "security"> & {
  readonly security: Omit<GeminiCliSettingsJson["security"], "auth">;
} = {
  general: {
    checkpointing: { enabled: false },
  },
  security: {
    folderTrust: { enabled: false },
    toolSandboxing: false,
  },
};

function splitShellWords(raw: string): ReadonlyArray<string> {
  const tokens = raw.match(/"[^"]*"|'[^']*'|\\.|[^\s]+/g) ?? [];
  return tokens
    .map((token) => token.replace(/^['"]|['"]$/g, "").replace(/\\(.)/g, "$1"))
    .filter((token) => token.length > 0);
}

export function validateGeminiLaunchArgs(
  launchArgs: string | null | undefined,
): GeminiReservedFlagError | undefined {
  if (!launchArgs?.trim()) {
    return undefined;
  }
  const parsed = parseCliArgs(launchArgs.trim());
  const reservedFlags = new Set(GEMINI_RESERVED_FLAGS);
  for (const flag of Object.keys(parsed.flags)) {
    if (reservedFlags.has(flag)) {
      return {
        flag,
        message: `Gemini launch flag '--${flag}' is managed by T3 Code and cannot be overridden in settings.`,
      };
    }
  }
  return undefined;
}

export function resolveGeminiUserLaunchArgs(
  launchArgs: string | null | undefined,
): GeminiUserLaunchArgs {
  const error = validateGeminiLaunchArgs(launchArgs);
  if (error) {
    return { argv: [], error };
  }
  const trimmed = launchArgs?.trim() ?? "";
  if (!trimmed) {
    return { argv: [], error: undefined };
  }
  const argv = splitShellWords(trimmed);
  parseCliArgs(argv);
  return { argv, error: undefined };
}

export function resolveGeminiAuthMethodFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): GeminiAuthType | undefined {
  if (nonEmptyEnv(env["GEMINI_API_KEY"])) {
    return "gemini-api-key";
  }
  if (isTruthyEnv(env["GOOGLE_GENAI_USE_VERTEXAI"])) {
    return "vertex-ai";
  }
  if (isTruthyEnv(env["CLOUD_SHELL"]) || isTruthyEnv(env["GEMINI_CLI_USE_COMPUTE_ADC"])) {
    return "compute-default-credentials";
  }
  if (isTruthyEnv(env["GOOGLE_GENAI_USE_GCA"])) {
    return "oauth-personal";
  }
  return undefined;
}

/**
 * Resolve a Gemini auth method from the CLI's on-disk state.
 *
 * `gemini auth login` writes `~/.gemini/oauth_creds.json`; its presence is
 * how the Gemini CLI itself decides it can authenticate as the logged-in
 * user. Env-var detection alone misses this case — users typically never
 * set `GOOGLE_GENAI_USE_GCA` — so we fall back to a cheap stat of the
 * standard credential files.
 */
export function resolveGeminiAuthMethodFromDisk(input?: {
  readonly homeDir?: string;
}): GeminiAuthType | undefined {
  const homeDir = input?.homeDir ?? nodeOs.homedir();
  if (!homeDir) return undefined;
  const geminiHome = nodePath.join(homeDir, ".gemini");
  const oauthCredsPath = nodePath.join(geminiHome, "oauth_creds.json");
  try {
    const stat = nodeFs.statSync(oauthCredsPath);
    if (stat.isFile() && stat.size > 0) {
      return "oauth-personal";
    }
  } catch {
    // Ignore ENOENT / EACCES — no usable creds on disk.
  }
  return undefined;
}

/**
 * Combined resolver that tries env first (fast path for API-key / Vertex /
 * compute-ADC) and then falls back to on-disk credentials (the common
 * `gemini auth login` case).
 */
export function resolveGeminiAuthMethod(input?: {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
}): GeminiAuthType | undefined {
  return (
    resolveGeminiAuthMethodFromEnv(input?.env ?? process.env) ??
    resolveGeminiAuthMethodFromDisk(input?.homeDir !== undefined ? { homeDir: input.homeDir } : {})
  );
}

/**
 * Write our locked-down `settings.json` into the per-thread Gemini home.
 *
 * Gemini CLI looks up its config under `$HOME/.gemini/`, so when we spawn
 * with `HOME=<thread-home>` we have to mirror that layout — the file lands
 * at `<home>/.gemini/settings.json`, not `<home>/settings.json`.
 */
export const writeGeminiCliSettings = (input: {
  readonly home: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly userHomeDir?: string;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const geminiDir = nodePath.join(input.home, ".gemini");
    yield* fs.makeDirectory(geminiDir, { recursive: true });
    const settingsPath = nodePath.join(geminiDir, "settings.json");
    const selectedType = resolveGeminiAuthMethod({
      ...(input.env ? { env: input.env } : {}),
      ...(input.userHomeDir !== undefined ? { homeDir: input.userHomeDir } : {}),
    });
    const settings: GeminiCliSettingsJson = {
      ...GEMINI_DEFAULT_CLI_SETTINGS,
      security: {
        ...GEMINI_DEFAULT_CLI_SETTINGS.security,
        ...(selectedType ? { auth: { selectedType } } : {}),
      },
    };
    yield* fs.writeFileString(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    return settingsPath;
  });

const GEMINI_AUTH_FILES_TO_SEED: ReadonlyArray<string> = [
  "oauth_creds.json",
  "google_accounts.json",
  "installation_id",
];

/**
 * Copy Gemini CLI's auth-related files (OAuth token, account list,
 * installation id) from the user's real `~/.gemini/` into the per-thread
 * Gemini home. Without this, `gemini --acp` spawned under `HOME=<thread>`
 * would see an empty config dir and prompt the user to re-authenticate on
 * every session start.
 *
 * Unknown files are skipped silently — users with API-key-only auth have no
 * oauth_creds.json, and that's fine.
 *
 * Limitations: this is a one-shot copy at session start. In-session token
 * refresh works correctly because Gemini CLI writes the refreshed access
 * token back into the per-thread `$HOME/.gemini/` it owns. But if the user
 * runs `gemini auth login` externally (or switches Google accounts) while
 * a T3 session is live, the per-thread copy goes stale until the next
 * `startSession` re-seeds it. Symlinking instead of copying does not help:
 * the CLI's atomic-rename refresh would replace the symlink with a regular
 * file on the first refresh, producing the same divergence.
 */
export const seedGeminiCliHomeAuth = (input: {
  readonly home: string;
  readonly userHomeDir?: string;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const sourceRoot = nodePath.join(input.userHomeDir ?? nodeOs.homedir(), ".gemini");
    const destRoot = nodePath.join(input.home, ".gemini");
    yield* fs.makeDirectory(destRoot, { recursive: true });
    const seeded: Array<string> = [];
    for (const file of GEMINI_AUTH_FILES_TO_SEED) {
      const sourcePath = nodePath.join(sourceRoot, file);
      const destPath = nodePath.join(destRoot, file);
      const sourceExists = yield* fs.exists(sourcePath).pipe(Effect.orElseSucceed(() => false));
      if (!sourceExists) continue;
      const copied = yield* fs.copyFile(sourcePath, destPath).pipe(
        Effect.matchEffect({
          onFailure: () => Effect.succeed(false),
          onSuccess: () => Effect.succeed(true),
        }),
      );
      if (copied) {
        seeded.push(file);
      }
    }
    return seeded;
  });

export interface GeminiAcpSpawnOverrides {
  readonly home?: string;
  readonly includeDirectories?: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
  readonly flavor?: GeminiAcpFlavor;
}

/**
 * Env vars we set to empty strings in every Gemini spawn so libsecret
 * can't reach a running Secret Service / GNOME Keyring daemon. Without
 * this, `AcpSessionRuntime` merges the full `process.env` into the child
 * (see AcpSessionRuntime.ts:191), so DBus/GNOME-Keyring discovery vars
 * leak through and the keyring daemon prompts the user to create a
 * default keyring on every probe — visible as an unexpected desktop
 * dialog even for headless ACP work.
 *
 * Setting the values to `""` makes libsecret's discovery fail cleanly and
 * fall back to whatever we seed in the per-thread `.gemini/` dir (which
 * is already the real source of truth for our sessions).
 */
export const GEMINI_KEYRING_NEUTRALIZING_ENV: Readonly<Record<string, string>> = {
  DBUS_SESSION_BUS_ADDRESS: "",
  DBUS_SYSTEM_BUS_ADDRESS: "",
  GNOME_KEYRING_CONTROL: "",
  GNOME_KEYRING_PID: "",
};

export function buildGeminiAcpSpawnInput(input: {
  readonly geminiSettings: GeminiAcpRuntimeGeminiSettings | null | undefined;
  readonly cwd: string;
  readonly overrides?: GeminiAcpSpawnOverrides;
}): AcpSpawnInput {
  const binary =
    input.geminiSettings?.binaryPath && input.geminiSettings.binaryPath.trim().length > 0
      ? input.geminiSettings.binaryPath
      : "gemini";
  const userArgs = resolveGeminiUserLaunchArgs(input.geminiSettings?.launchArgs).argv;
  const includeDirectories = [...(input.overrides?.includeDirectories ?? [])]
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const args: Array<string> = [...userArgs];
  if (includeDirectories.length > 0) {
    args.push("--include-directories", includeDirectories.join(","));
  }
  args.push(`--${input.overrides?.flavor ?? "acp"}`);
  // Order matters: neutralizers first, then user-supplied overrides so
  // callers can re-enable specific keyring vars if they ever need to.
  // HOME/USERPROFILE go last so per-thread home routing always wins.
  const env: Record<string, string> = {
    ...GEMINI_KEYRING_NEUTRALIZING_ENV,
    ...(input.overrides?.env ?? {}),
  };
  if (input.overrides?.home) {
    // Gemini CLI resolves its config directory as `$HOME/.gemini/` (and
    // `%USERPROFILE%\.gemini\` on Windows). Overriding HOME is how we
    // redirect it without touching a non-standard env var that the CLI
    // might ignore.
    env["HOME"] = input.overrides.home;
    env["USERPROFILE"] = input.overrides.home;
  }
  return {
    command: binary,
    args,
    cwd: input.cwd,
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}

export interface GeminiAcpRuntimeInput extends Omit<
  AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly geminiSettings: GeminiAcpRuntimeGeminiSettings | null | undefined;
  readonly home?: string;
  readonly includeDirectories?: ReadonlyArray<string>;
  readonly spawnEnv?: Readonly<Record<string, string>>;
  readonly flavor?: GeminiAcpFlavor;
  readonly authMethodId?: string;
}

export const makeGeminiAcpRuntime = (
  input: GeminiAcpRuntimeInput,
): Effect.Effect<AcpSessionRuntimeShape, EffectAcpErrors.AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildGeminiAcpSpawnInput({
          geminiSettings: input.geminiSettings,
          cwd: input.cwd,
          overrides: {
            ...(input.home ? { home: input.home } : {}),
            ...(input.includeDirectories ? { includeDirectories: input.includeDirectories } : {}),
            ...(input.spawnEnv ? { env: input.spawnEnv } : {}),
            ...(input.flavor ? { flavor: input.flavor } : {}),
          },
        }),
        authMethodId: input.authMethodId ?? "oauth-personal",
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime).pipe(Effect.provide(acpContext));
  });

export const resolveGeminiAcpFlavor = (input: {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly geminiSettings: GeminiAcpRuntimeGeminiSettings | null | undefined;
  readonly cwd: string;
  readonly home: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly clientInfo?: NonNullable<AcpSessionRuntimeOptions["clientInfo"]>;
}): Effect.Effect<
  {
    readonly flavor: GeminiAcpFlavor;
    readonly started: import("./AcpSessionRuntime.ts").AcpSessionRuntimeStartResult;
  },
  EffectAcpErrors.AcpError
> =>
  Effect.gen(function* () {
    let lastCause: Cause.Cause<EffectAcpErrors.AcpError> | undefined;
    for (const flavor of GEMINI_ACP_FLAVOR_CANDIDATES) {
      const result = yield* Effect.exit(
        Effect.gen(function* () {
          const runtime = yield* makeGeminiAcpRuntime({
            childProcessSpawner: input.childProcessSpawner,
            geminiSettings: input.geminiSettings,
            cwd: input.cwd,
            home: input.home,
            flavor,
            clientInfo: input.clientInfo ?? {
              name: "t3-code-gemini-acp-probe",
              version: "0.0.0",
            },
            authMethodId: resolveGeminiAuthMethodFromEnv(input.env) ?? "oauth-personal",
          });
          return yield* runtime.start();
        }).pipe(Effect.timeout(GEMINI_ACP_PROBE_TIMEOUT), Effect.scoped),
      );
      if (Exit.isSuccess(result)) {
        return {
          flavor,
          started: result.value,
        };
      }
      lastCause = result.cause as Cause.Cause<EffectAcpErrors.AcpError>;
    }
    return yield* Effect.failCause<EffectAcpErrors.AcpError>(
      lastCause ??
        (Cause.die(
          new Error("Gemini ACP probe failed before any candidate flag was attempted."),
        ) as Cause.Cause<EffectAcpErrors.AcpError>),
    );
  });

/**
 * Memoize ACP-flavor detection so a single binary path only pays the
 * probe cost once. On cache hit, returns immediately. On cache miss,
 * runs `probe`, stores the result, returns it. The whole operation is
 * serialized on the `SynchronizedRef` so concurrent first calls probe
 * once, not N times.
 */
export const resolveCachedGeminiFlavor = <E, R>(input: {
  readonly cacheRef: SynchronizedRef.SynchronizedRef<Map<string, GeminiAcpFlavor>>;
  readonly binaryPath: string;
  readonly probe: Effect.Effect<GeminiAcpFlavor, E, R>;
}): Effect.Effect<GeminiAcpFlavor, E, R> =>
  SynchronizedRef.modifyEffect(input.cacheRef, (cache) => {
    const existing = cache.get(input.binaryPath);
    if (existing) {
      return Effect.succeed([existing, cache] as const);
    }
    return Effect.map(input.probe, (flavor) => {
      const next = new Map(cache);
      next.set(input.binaryPath, flavor);
      return [flavor, next] as const;
    });
  });

export function getGeminiSessionModels(
  response:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse
    | null
    | undefined,
): EffectAcpSchema.SessionModelState | undefined {
  return response?.models ?? undefined;
}

// ── ACP session config-option helpers ────────────────────────────────────
// These mirror CursorAcpSupport / CursorProvider helpers but keyed on
// Gemini-shaped option ids/categories. Gemini CLI may expose a different
// set of options across releases; the helpers use name/id heuristics so
// we pick up new options without code changes.

export interface GeminiAcpModelErrorContext {
  readonly cause: EffectAcpErrors.AcpError;
}

export interface GeminiAcpConfigOptionErrorContext {
  readonly cause: EffectAcpErrors.AcpError;
  readonly configId: string;
}

export interface GeminiSessionSelectOption {
  readonly value: string;
  readonly name: string;
}

export function flattenGeminiSessionConfigSelectOptions(
  configOption: EffectAcpSchema.SessionConfigOption | undefined,
): ReadonlyArray<GeminiSessionSelectOption> {
  if (!configOption || configOption.type !== "select") {
    return [];
  }
  return configOption.options.flatMap((entry) =>
    "value" in entry
      ? [
          {
            value: entry.value.trim(),
            name: entry.name.trim(),
          } satisfies GeminiSessionSelectOption,
        ]
      : entry.options.map(
          (option) =>
            ({
              value: option.value.trim(),
              name: option.name.trim(),
            }) satisfies GeminiSessionSelectOption,
        ),
  );
}

export function normalizeGeminiEffortValue(value: string | null | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  switch (normalized) {
    case "low":
    case "medium":
    case "high":
    case "max":
      return normalized;
    case "xhigh":
    case "extra-high":
    case "extra high":
      return "max";
    default:
      return undefined;
  }
}

function normalizeGeminiConfigOptionToken(value: string | null | undefined): string {
  return (
    value
      ?.trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, "-") ?? ""
  );
}

export function findGeminiModelConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): EffectAcpSchema.SessionConfigOption | undefined {
  return (
    configOptions.find((option) => option.id.trim().toLowerCase() === "model") ??
    configOptions.find((option) => option.category?.trim().toLowerCase() === "model")
  );
}

function matchesKeyword(
  option: EffectAcpSchema.SessionConfigOption,
  keywords: ReadonlyArray<string>,
): boolean {
  const id = option.id.trim().toLowerCase();
  const name = option.name.trim().toLowerCase();
  for (const keyword of keywords) {
    if (id === keyword || name === keyword || name.includes(keyword) || id.includes(keyword)) {
      return true;
    }
  }
  return false;
}

export function findGeminiEffortConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): EffectAcpSchema.SessionConfigOption | undefined {
  return configOptions.find(
    (option) =>
      option.type === "select" &&
      matchesKeyword(option, [
        "effort",
        "reasoning",
        "thinking-budget",
        "thinking_budget",
        "thought-level",
      ]),
  );
}

export function findGeminiThinkingConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): EffectAcpSchema.SessionConfigOption | undefined {
  return configOptions.find((option) => {
    if (!matchesKeyword(option, ["thinking"])) return false;
    if (option.type === "boolean") return true;
    if (option.type !== "select") return false;
    const values = new Set(
      flattenGeminiSessionConfigSelectOptions(option).map((entry) =>
        entry.value.trim().toLowerCase(),
      ),
    );
    return values.has("true") && values.has("false");
  });
}

export function findGeminiContextConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): EffectAcpSchema.SessionConfigOption | undefined {
  return configOptions.find(
    (option) => option.type === "select" && matchesKeyword(option, ["context", "context-window"]),
  );
}

function isGeminiBooleanLikeConfigOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  if (option.type === "boolean") return true;
  if (option.type !== "select") return false;
  const values = new Set(
    flattenGeminiSessionConfigSelectOptions(option).map((entry) =>
      entry.value.trim().toLowerCase(),
    ),
  );
  return values.has("true") && values.has("false");
}

const GEMINI_EMPTY_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

export function buildGeminiCapabilitiesFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ModelCapabilities {
  if (!configOptions || configOptions.length === 0) {
    return GEMINI_EMPTY_CAPABILITIES;
  }

  const effortOption = findGeminiEffortConfigOption(configOptions);
  const reasoningEffortLevels =
    effortOption && effortOption.type === "select"
      ? flattenGeminiSessionConfigSelectOptions(effortOption).flatMap((entry) => {
          const normalizedValue = normalizeGeminiEffortValue(entry.value);
          if (!normalizedValue) return [];
          return [
            {
              value: normalizedValue,
              label: entry.name,
              ...(normalizeGeminiEffortValue(effortOption.currentValue) === normalizedValue
                ? { isDefault: true }
                : {}),
            },
          ];
        })
      : [];

  const contextOption = findGeminiContextConfigOption(configOptions);
  const contextWindowOptions =
    contextOption && contextOption.type === "select"
      ? flattenGeminiSessionConfigSelectOptions(contextOption).map((entry) => ({
          value: entry.value,
          label: entry.name,
          ...(contextOption.currentValue === entry.value ? { isDefault: true } : {}),
        }))
      : [];

  const thinkingOption = findGeminiThinkingConfigOption(configOptions);

  return {
    reasoningEffortLevels,
    // Gemini CLI doesn't expose a Cursor-style "fast mode" config option.
    supportsFastMode: false,
    supportsThinkingToggle: thinkingOption
      ? isGeminiBooleanLikeConfigOption(thinkingOption)
      : false,
    contextWindowOptions,
    promptInjectedEffortLevels: [],
  };
}

function findGeminiSelectOptionValue(
  configOption: EffectAcpSchema.SessionConfigOption | undefined,
  matcher: (option: GeminiSessionSelectOption) => boolean,
): string | undefined {
  return flattenGeminiSessionConfigSelectOptions(configOption).find(matcher)?.value;
}

function findGeminiBooleanConfigValue(
  configOption: EffectAcpSchema.SessionConfigOption | undefined,
  requested: boolean,
): string | boolean | undefined {
  if (!configOption) return undefined;
  if (configOption.type === "boolean") return requested;
  return findGeminiSelectOptionValue(
    configOption,
    (option) => normalizeGeminiConfigOptionToken(option.value) === String(requested),
  );
}

export function resolveGeminiAcpConfigUpdates(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
  modelOptions: GeminiModelOptions | null | undefined,
): ReadonlyArray<{ readonly configId: string; readonly value: string | boolean }> {
  if (!configOptions || configOptions.length === 0) return [];
  const updates: Array<{ readonly configId: string; readonly value: string | boolean }> = [];

  const effortOption = findGeminiEffortConfigOption(configOptions);
  const requestedEffort = normalizeGeminiEffortValue(modelOptions?.effort);
  if (effortOption && requestedEffort) {
    const value = findGeminiSelectOptionValue(effortOption, (option) => {
      const normalizedValue = normalizeGeminiEffortValue(option.value);
      const normalizedName = normalizeGeminiEffortValue(option.name);
      return normalizedValue === requestedEffort || normalizedName === requestedEffort;
    });
    if (value) updates.push({ configId: effortOption.id, value });
  }

  const contextOption = findGeminiContextConfigOption(configOptions);
  if (contextOption && modelOptions?.contextWindow) {
    const value = findGeminiSelectOptionValue(
      contextOption,
      (option) =>
        normalizeGeminiConfigOptionToken(option.value) ===
          normalizeGeminiConfigOptionToken(modelOptions.contextWindow) ||
        normalizeGeminiConfigOptionToken(option.name) ===
          normalizeGeminiConfigOptionToken(modelOptions.contextWindow),
    );
    if (value) updates.push({ configId: contextOption.id, value });
  }

  const thinkingOption = findGeminiThinkingConfigOption(configOptions);
  if (thinkingOption && typeof modelOptions?.thinking === "boolean") {
    const value = findGeminiBooleanConfigValue(thinkingOption, modelOptions.thinking);
    if (value !== undefined) updates.push({ configId: thinkingOption.id, value });
  }

  return updates;
}

interface GeminiAcpModelRuntime {
  readonly setModel: AcpSessionRuntimeShape["setModel"];
}

interface GeminiAcpConfigOptionsRuntime {
  readonly getConfigOptions: AcpSessionRuntimeShape["getConfigOptions"];
  readonly setConfigOption: AcpSessionRuntimeShape["setConfigOption"];
}

/**
 * Issue `session/set_model` for a non-trivial slug. Empty / null /
 * undefined / `"auto"` are no-ops so callers can pass user-picker values
 * unconditionally.
 */
export function applyGeminiAcpModel<E>(input: {
  readonly runtime: GeminiAcpModelRuntime;
  readonly model: string | null | undefined;
  readonly mapError: (context: GeminiAcpModelErrorContext) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    const trimmed = input.model?.trim();
    if (!trimmed || trimmed === "auto") return;
    yield* input.runtime
      .setModel(trimmed)
      .pipe(Effect.mapError((cause) => input.mapError({ cause })));
  });
}

/**
 * Apply thinking/effort/context options via `setConfigOption` based on
 * what Gemini CLI's current ACP session exposes. Unknown options are
 * silently skipped.
 */
export function applyGeminiAcpConfigOptions<E>(input: {
  readonly runtime: GeminiAcpConfigOptionsRuntime;
  readonly modelOptions: GeminiModelOptions | null | undefined;
  readonly mapError: (context: GeminiAcpConfigOptionErrorContext) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    const configUpdates = resolveGeminiAcpConfigUpdates(
      yield* input.runtime.getConfigOptions,
      input.modelOptions,
    );
    for (const update of configUpdates) {
      yield* input.runtime
        .setConfigOption(update.configId, update.value)
        .pipe(Effect.mapError((cause) => input.mapError({ cause, configId: update.configId })));
    }
  });
}

function nonEmptyEnv(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function isTruthyEnv(value: string | undefined): boolean {
  if (!nonEmptyEnv(value)) {
    return false;
  }
  const normalized = value!.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}
