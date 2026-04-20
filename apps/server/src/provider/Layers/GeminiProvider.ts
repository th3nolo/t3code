import type {
  GeminiSettings,
  ModelCapabilities,
  ServerProvider,
  ServerProviderAuth,
  ServerProviderModel,
  ServerSettingsError,
} from "@t3tools/contracts";
import {
  Cause,
  Effect,
  Equal,
  Exit,
  FileSystem,
  Layer,
  Option,
  Result,
  Stream,
  SynchronizedRef,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  detailFromResult,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
} from "../providerSnapshot.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { GeminiProvider } from "../Services/GeminiProvider.ts";
import type { AcpSessionRuntimeShape } from "../acp/AcpSessionRuntime.ts";
import {
  buildGeminiCapabilitiesFromConfigOptions,
  findGeminiModelConfigOption,
  flattenGeminiSessionConfigSelectOptions,
  type GeminiAcpFlavor,
  initializeGeminiCliHome,
  makeGeminiAcpRuntime,
  resolveCachedGeminiFlavor,
  resolveGeminiAcpFlavor,
  resolveGeminiAuthMethod,
  validateGeminiLaunchArgs,
} from "../acp/GeminiAcpSupport.ts";
import { ServerSettingsService } from "../../serverSettings.ts";

const PROVIDER = "gemini" as const;

const EMPTY_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

/**
 * Gemini built-in models. Gemini does not expose model-picker or
 * model-capability metadata over ACP, so capabilities stay empty and
 * we ship a static list aligned to what Gemini CLI's `VALID_GEMINI_MODELS`
 * accepts via `--model` / `/model` (packages/core/src/config/models.ts).
 *
 * `auto` is the default sentinel the UI maps to whichever current-gen
 * Gemini model Gemini CLI prefers — matches the CLI's own `auto` alias.
 *
 * Preview slugs (Gemini 3 tier) require preview access on the user's
 * Google account; if unavailable Gemini CLI silently downgrades to the
 * matching 2.5 GA tier, so surfacing them here is safe.
 *
 * Users can pin niche / date-stamped / custom-tools variants via the
 * Custom Models setting — no need to enumerate them here.
 */
const BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "auto",
    name: "Auto",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "gemini-3.1-pro-preview",
    name: "Gemini 3.1 Pro (Preview)",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "gemini-3-flash-preview",
    name: "Gemini 3 Flash (Preview)",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

export function getGeminiBuiltInModels(): ReadonlyArray<ServerProviderModel> {
  return BUILT_IN_MODELS;
}

function geminiAuthLabel(method: string | undefined): ServerProviderAuth {
  switch (method) {
    case "gemini-api-key":
      return { status: "authenticated", type: method, label: "Gemini API Key" };
    case "vertex-ai":
      return { status: "authenticated", type: method, label: "Vertex AI" };
    case "compute-default-credentials":
      return {
        status: "authenticated",
        type: method,
        label: "Google Compute Default Credentials",
      };
    case "oauth-personal":
      return {
        status: "authenticated",
        type: method,
        label: "Google Account (OAuth)",
      };
    default:
      // Probe ran successfully and explicitly returned no method — that's
      // a conclusive "no creds", not "we couldn't tell". Returning
      // `unauthenticated` lets makeManagedServerProvider's enrichSnapshot
      // skip background capability discovery (it's gated on this status).
      return { status: "unauthenticated" };
  }
}

function buildInitialGeminiSnapshot(geminiSettings: GeminiSettings): ServerProvider {
  const checkedAt = new Date().toISOString();
  const models = providerModelsFromSettings(
    BUILT_IN_MODELS,
    PROVIDER,
    geminiSettings.customModels,
    EMPTY_CAPABILITIES,
  );

  if (!geminiSettings.enabled) {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Gemini is disabled in T3 Code settings.",
      },
    });
  }

  return buildServerProvider({
    provider: PROVIDER,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Checking Gemini CLI availability...",
    },
  });
}

const runGeminiCommand = Effect.fn("runGeminiCommand")(function* (args: ReadonlyArray<string>) {
  const geminiSettings = yield* Effect.service(ServerSettingsService).pipe(
    Effect.flatMap((service) => service.getSettings),
    Effect.map((settings) => settings.providers.gemini),
  );
  const command = ChildProcess.make(geminiSettings.binaryPath, [...args], {
    shell: process.platform === "win32",
  });
  return yield* spawnAndCollect(geminiSettings.binaryPath, command);
});

export const checkGeminiProviderStatus = Effect.fn("checkGeminiProviderStatus")(
  function* (): Effect.fn.Return<
    ServerProvider,
    ServerSettingsError,
    ChildProcessSpawner.ChildProcessSpawner | ServerSettingsService | FileSystem.FileSystem
  > {
    const geminiSettings = yield* Effect.service(ServerSettingsService).pipe(
      Effect.flatMap((service) => service.getSettings),
      Effect.map((settings) => settings.providers.gemini),
    );
    const checkedAt = new Date().toISOString();
    const models = providerModelsFromSettings(
      BUILT_IN_MODELS,
      PROVIDER,
      geminiSettings.customModels,
      EMPTY_CAPABILITIES,
    );

    if (!geminiSettings.enabled) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Gemini is disabled in T3 Code settings.",
        },
      });
    }

    const launchArgsError = validateGeminiLaunchArgs(geminiSettings.launchArgs);
    if (launchArgsError) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: geminiSettings.enabled,
        checkedAt,
        models,
        probe: {
          installed: true,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: launchArgsError.message,
        },
      });
    }

    const versionProbe = yield* runGeminiCommand(["--version"]).pipe(
      Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(versionProbe)) {
      const error = versionProbe.failure;
      return buildServerProvider({
        provider: PROVIDER,
        enabled: geminiSettings.enabled,
        checkedAt,
        models,
        probe: {
          installed: !isCommandMissingCause(error),
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: isCommandMissingCause(error)
            ? "Gemini CLI (`gemini`) is not installed or not on PATH."
            : `Failed to execute Gemini CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
        },
      });
    }

    if (Option.isNone(versionProbe.success)) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: geminiSettings.enabled,
        checkedAt,
        models,
        probe: {
          installed: true,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: "Gemini CLI is installed but timed out while running `gemini --version`.",
        },
      });
    }

    const versionResult = versionProbe.success.value;
    const parsedVersion = parseGenericCliVersion(
      `${versionResult.stdout}\n${versionResult.stderr}`,
    );
    if (versionResult.code !== 0) {
      const detail = detailFromResult(versionResult);
      return buildServerProvider({
        provider: PROVIDER,
        enabled: geminiSettings.enabled,
        checkedAt,
        models,
        probe: {
          installed: true,
          version: parsedVersion,
          status: "error",
          auth: { status: "unknown" },
          message: detail
            ? `Gemini CLI is installed but failed to run. ${detail}`
            : "Gemini CLI is installed but failed to run.",
        },
      });
    }

    const authMethod = yield* resolveGeminiAuthMethod();
    const auth = geminiAuthLabel(authMethod);
    const unauthenticatedMessage =
      auth.status !== "authenticated"
        ? "No Gemini auth method detected. Run `gemini auth login`, set GEMINI_API_KEY, or configure Vertex/ADC environment variables."
        : undefined;

    return buildServerProvider({
      provider: PROVIDER,
      enabled: geminiSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: parsedVersion,
        status: auth.status === "authenticated" ? "ready" : "warning",
        auth,
        ...(unauthenticatedMessage ? { message: unauthenticatedMessage } : {}),
      },
    });
  },
);

// ── ACP-driven model capability discovery ──────────────────────────────
// Spins up a short-lived Gemini ACP session in an isolated temp home,
// optionally switches the session to each built-in model via
// `setConfigOption("model", slug)`, and reads the resulting
// `configOptions` to derive per-model ModelCapabilities. Mirrors
// CursorProvider.discoverCursorModelCapabilitiesViaAcp.

const GEMINI_ACP_DISCOVERY_TIMEOUT = "15 seconds";
const GEMINI_ACP_MODEL_CAPABILITY_TIMEOUT = "6 seconds";
const GEMINI_ACP_DISCOVERY_CONCURRENCY = 2;
const GEMINI_REFRESH_INTERVAL = "1 hour";

function hasGeminiModelCapabilities(model: Pick<ServerProviderModel, "capabilities">): boolean {
  return (
    (model.capabilities?.reasoningEffortLevels.length ?? 0) > 0 ||
    model.capabilities?.supportsFastMode === true ||
    model.capabilities?.supportsThinkingToggle === true ||
    (model.capabilities?.contextWindowOptions.length ?? 0) > 0 ||
    (model.capabilities?.promptInjectedEffortLevels.length ?? 0) > 0
  );
}

function normalizeUnknownError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

const withGeminiAcpProbe = <A, E, R>(input: {
  readonly geminiSettings: GeminiSettings;
  readonly flavorCacheRef?: SynchronizedRef.SynchronizedRef<Map<string, GeminiAcpFlavor>>;
  readonly cwd?: string;
  readonly useRuntime: (runtime: AcpSessionRuntimeShape) => Effect.Effect<A, E, R>;
}) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const flavorCacheRef =
      input.flavorCacheRef ?? (yield* SynchronizedRef.make(new Map<string, GeminiAcpFlavor>()));
    const probeHome = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-gemini-acp-cap-probe-",
    });
    yield* initializeGeminiCliHome({ home: probeHome }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
    );
    const flavor = yield* resolveCachedGeminiFlavor({
      cacheRef: flavorCacheRef,
      binaryPath: input.geminiSettings.binaryPath,
      probe: resolveGeminiAcpFlavor({
        childProcessSpawner: spawner,
        geminiSettings: input.geminiSettings,
        cwd: input.cwd ?? process.cwd(),
        home: probeHome,
        clientInfo: { name: "t3-code-gemini-provider-probe", version: "0.0.0" },
      }).pipe(Effect.map((result) => result.flavor)),
    });

    const runtime = yield* makeGeminiAcpRuntime({
      childProcessSpawner: spawner,
      geminiSettings: input.geminiSettings,
      cwd: input.cwd ?? process.cwd(),
      home: probeHome,
      flavor,
      clientInfo: { name: "t3-code-gemini-provider-probe", version: "0.0.0" },
      authMethodId: (yield* resolveGeminiAuthMethod()) ?? "oauth-personal",
    });
    return yield* input.useRuntime(runtime);
  }).pipe(Effect.scoped);

export const discoverGeminiCapabilitiesViaAcp = (input: {
  readonly geminiSettings: GeminiSettings;
  readonly existingModels: ReadonlyArray<ServerProviderModel>;
  readonly flavorCacheRef?: SynchronizedRef.SynchronizedRef<Map<string, GeminiAcpFlavor>>;
  readonly cwd?: string;
}): Effect.Effect<
  ReadonlyArray<ServerProviderModel>,
  Error,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> =>
  withGeminiAcpProbe({
    geminiSettings: input.geminiSettings,
    ...(input.flavorCacheRef !== undefined ? { flavorCacheRef: input.flavorCacheRef } : {}),
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    useRuntime: (runtime) =>
      Effect.gen(function* () {
        const started = yield* runtime.start();
        const initialConfigOptions = started.sessionSetupResult.configOptions ?? [];
        const modelOption = findGeminiModelConfigOption(initialConfigOptions);
        const modelChoices = flattenGeminiSessionConfigSelectOptions(modelOption);

        // If Gemini CLI's ACP session doesn't expose a model picker or any
        // other config options, leave each built-in model with EMPTY
        // capabilities — still accurate, just no toggles to render.
        if (initialConfigOptions.length === 0) {
          return [] as ReadonlyArray<ServerProviderModel>;
        }

        const currentModelValue =
          modelOption?.type === "select"
            ? modelOption.currentValue?.trim() || undefined
            : undefined;
        const capabilitiesBySlug = new Map<string, ModelCapabilities>();
        if (currentModelValue) {
          capabilitiesBySlug.set(
            currentModelValue,
            buildGeminiCapabilitiesFromConfigOptions(initialConfigOptions),
          );
        } else {
          // No explicit current model — apply the session-level capabilities
          // to every existing built-in; they still reflect what the CLI
          // offers.
          for (const model of input.existingModels) {
            if (!model.isCustom) {
              capabilitiesBySlug.set(
                model.slug,
                buildGeminiCapabilitiesFromConfigOptions(initialConfigOptions),
              );
            }
          }
        }

        // Per-model deep probe: only if Gemini exposed a model selector AND
        // we have models that lack capabilities. Otherwise session-level
        // caps are the answer.
        const needsPerModelProbe =
          modelOption !== undefined &&
          modelChoices.length > 0 &&
          input.existingModels.some(
            (model) => !model.isCustom && !hasGeminiModelCapabilities(model),
          );

        if (needsPerModelProbe) {
          const targetSlugs = new Set(
            input.existingModels.filter((model) => !model.isCustom).map((model) => model.slug),
          );
          const probedCapabilities: ReadonlyArray<
            readonly [string, ModelCapabilities] | undefined
          > = yield* Effect.forEach(
            modelChoices,
            (modelChoice) => {
              const modelSlug = modelChoice.value.trim();
              if (!modelSlug || !targetSlugs.has(modelSlug) || capabilitiesBySlug.has(modelSlug)) {
                // Not Effect.void — outer forEach filters on `entry !== undefined`.
                return Effect.void.pipe(
                  Effect.as<readonly [string, ModelCapabilities] | undefined>(undefined),
                );
              }
              return withGeminiAcpProbe({
                geminiSettings: input.geminiSettings,
                ...(input.flavorCacheRef !== undefined
                  ? { flavorCacheRef: input.flavorCacheRef }
                  : {}),
                ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
                useRuntime: (probeRuntime) =>
                  Effect.gen(function* () {
                    const probeStarted = yield* probeRuntime.start();
                    const probeConfigOptions = probeStarted.sessionSetupResult.configOptions ?? [];
                    const probeModelOption = findGeminiModelConfigOption(probeConfigOptions);
                    const probeCurrentValue =
                      probeModelOption?.type === "select"
                        ? probeModelOption.currentValue?.trim() || undefined
                        : undefined;
                    const nextConfigOptions =
                      probeCurrentValue === modelSlug
                        ? probeConfigOptions
                        : yield* probeRuntime
                            .setConfigOption(probeModelOption?.id ?? modelOption!.id, modelSlug)
                            .pipe(
                              Effect.map(
                                (response) => response.configOptions ?? probeConfigOptions,
                              ),
                            );
                    return [
                      modelSlug,
                      buildGeminiCapabilitiesFromConfigOptions(nextConfigOptions),
                    ] as const;
                  }),
              }).pipe(
                Effect.timeout(GEMINI_ACP_MODEL_CAPABILITY_TIMEOUT),
                Effect.retry({ times: 2 }),
                Effect.catchCause((cause) =>
                  Effect.logWarning("Gemini ACP capability probe failed", {
                    modelSlug,
                    cause: Cause.pretty(cause),
                  }).pipe(Effect.as<readonly [string, ModelCapabilities] | undefined>(undefined)),
                ),
              );
            },
            { concurrency: GEMINI_ACP_DISCOVERY_CONCURRENCY },
          );
          for (const entry of probedCapabilities) {
            if (!entry) continue;
            capabilitiesBySlug.set(entry[0], entry[1]);
          }
        }

        return input.existingModels.map((model) => {
          if (model.isCustom) return model;
          const caps = capabilitiesBySlug.get(model.slug);
          return caps ? { ...model, capabilities: caps } : model;
        });
      }),
  }).pipe(Effect.mapError(normalizeUnknownError));

export const GeminiProviderLive = Layer.effect(
  GeminiProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const flavorCacheRef = yield* SynchronizedRef.make(new Map<string, GeminiAcpFlavor>());

    const checkProvider = checkGeminiProviderStatus().pipe(
      Effect.provideService(ServerSettingsService, serverSettings),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
    );

    return yield* makeManagedServerProvider<GeminiSettings>({
      getSettings: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.gemini),
        Effect.orDie,
      ),
      streamSettings: serverSettings.streamChanges.pipe(
        Stream.map((settings) => settings.providers.gemini),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      initialSnapshot: buildInitialGeminiSnapshot,
      checkProvider,
      enrichSnapshot: ({ settings, snapshot, publishSnapshot }) => {
        // Skip when disabled, unauthenticated, or when every built-in model
        // already carries capabilities (nothing to probe).
        if (
          !settings.enabled ||
          snapshot.auth.status === "unauthenticated" ||
          !snapshot.models.some((model) => !model.isCustom && !hasGeminiModelCapabilities(model))
        ) {
          return Effect.void;
        }

        return Effect.gen(function* () {
          const discoveryExit = yield* Effect.exit(
            discoverGeminiCapabilitiesViaAcp({
              geminiSettings: settings,
              existingModels: snapshot.models,
              flavorCacheRef,
            }).pipe(Effect.timeout(GEMINI_ACP_DISCOVERY_TIMEOUT)),
          );
          if (Exit.isFailure(discoveryExit)) {
            yield* Effect.logWarning("Gemini ACP capability discovery failed", {
              cause: Cause.pretty(discoveryExit.cause),
            });
            return;
          }
          const enriched: ReadonlyArray<ServerProviderModel> = discoveryExit.value;
          if (enriched.length === 0) return;
          yield* publishSnapshot({
            ...snapshot,
            models: providerModelsFromSettings(
              enriched,
              PROVIDER,
              settings.customModels,
              EMPTY_CAPABILITIES,
            ),
          });
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.catchCause((cause) =>
            Effect.logWarning("Gemini ACP background capability enrichment failed", {
              models: snapshot.models.map((model) => model.slug),
              cause: Cause.pretty(cause),
            }).pipe(Effect.asVoid),
          ),
        );
      },
      refreshInterval: GEMINI_REFRESH_INTERVAL,
    });
  }),
);
