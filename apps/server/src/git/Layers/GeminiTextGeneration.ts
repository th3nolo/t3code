/**
 * GeminiTextGeneration – Text generation layer using the Gemini CLI.
 *
 * Implements the TextGenerationShape contract against `gemini` running in
 * headless mode (`gemini --prompt ... --output-format json`).
 *
 * Gemini's headless JSON output is a wrapper of the form:
 *   { "response": "<string containing stringified JSON>", "stats": { ... } }
 *
 * We therefore decode the outer envelope first, then parse the nested
 * `response` string against the caller's schema. Attachments are not
 * materialized here — git text generation only needs textual context.
 *
 * @module GeminiTextGeneration
 */
import { Effect, FileSystem, Layer, Option, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ChatAttachment, GeminiModelSelection, TextGenerationError } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";

import {
  type ThreadTitleGenerationResult,
  type TextGenerationShape,
  TextGeneration,
} from "../Services/TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "../Prompts.ts";
import {
  normalizeCliError,
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "../Utils.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  GEMINI_KEYRING_NEUTRALIZING_ENV,
  resolveGeminiUserLaunchArgs,
  seedGeminiCliHomeAuth,
  writeGeminiCliSettings,
} from "../../provider/acp/GeminiAcpSupport.ts";
import { ServerSettingsService } from "../../serverSettings.ts";

const GEMINI_TIMEOUT_MS = 180_000;
const GEMINI_JSON_RETRY_SUFFIX = "\n\nReturn valid JSON only.";

/**
 * Schema for the wrapper JSON returned by `gemini --output-format json`.
 * Gemini emits the model's reply as a string under `response`; additional
 * telemetry fields (e.g. `stats`) are tolerated and ignored.
 */
const GeminiOutputEnvelope = Schema.Struct({
  response: Schema.String,
});

/**
 * Slice out the first top-level JSON object from an arbitrary string. Gemini
 * sometimes prefixes/suffixes the model reply with code fences or prose, so
 * we scan for a balanced `{...}` block before handing to the JSON decoder.
 */
function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return trimmed;
  }

  const start = trimmed.indexOf("{");
  if (start < 0) {
    return trimmed;
  }

  let depth = 0;
  let inString = false;
  let escaping = false;
  for (let index = start; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return trimmed.slice(start, index + 1);
      }
    }
  }

  return trimmed.slice(start);
}

interface GeminiJsonDecodeError {
  readonly _tag: "GeminiJsonDecodeError";
  readonly detail: string;
  readonly cause?: unknown;
}

const makeGeminiTextGeneration = Effect.gen(function* () {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const serverConfig = yield* Effect.service(ServerConfig);
  const serverSettingsService = yield* Effect.service(ServerSettingsService);

  const readStreamAsString = <E>(
    operation: string,
    stream: Stream.Stream<Uint8Array, E>,
  ): Effect.Effect<string, TextGenerationError> =>
    stream.pipe(
      Stream.decodeText(),
      Stream.runFold(
        () => "",
        (acc, chunk) => acc + chunk,
      ),
      Effect.mapError((cause) =>
        normalizeCliError("gemini", operation, cause, "Failed to collect process output"),
      ),
    );

  const removeDirectoryQuietly = (path: string | undefined) =>
    path === undefined
      ? Effect.void
      : fileSystem.remove(path, { recursive: true, force: true }).pipe(Effect.ignore);

  // Stage attachments under a per-request temp dir and return the directory
  // plus the list of `@{...}` tokens to inject into the prompt so Gemini CLI
  // reads them via `--include-directories`. Caller is responsible for cleanup
  // (via removeDirectoryQuietly) so we don't depend on Scope.
  const stageAttachments = (
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle",
    attachments: ReadonlyArray<ChatAttachment> | undefined,
  ): Effect.Effect<
    { readonly directory: string | undefined; readonly promptTokens: ReadonlyArray<string> },
    TextGenerationError
  > =>
    Effect.gen(function* () {
      if (!attachments || attachments.length === 0) {
        return { directory: undefined, promptTokens: [] } as const;
      }
      const stageDir = yield* fileSystem.makeTempDirectory({ prefix: "t3-gemini-textgen-" }).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "Failed to stage attachments for Gemini text generation.",
              cause,
            }),
        ),
      );
      const tokens: Array<string> = [];
      for (const attachment of attachments) {
        const attachmentPath = resolveAttachmentPath({
          attachmentsDir: serverConfig.attachmentsDir,
          attachment,
        });
        if (!attachmentPath) {
          yield* removeDirectoryQuietly(stageDir);
          return yield* new TextGenerationError({
            operation,
            detail: `Invalid attachment id '${attachment.id}'.`,
          });
        }
        const safeFileName = `${attachment.id}_${attachment.name}`.replace(
          /[^a-zA-Z0-9._-]+/g,
          "_",
        );
        const target = `${stageDir}/${safeFileName}`;
        yield* fileSystem.copy(attachmentPath, target).pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation,
                detail: `Failed to stage attachment '${attachment.id}'.`,
                cause,
              }),
          ),
        );
        tokens.push(`@{${safeFileName}}`);
      }
      return { directory: stageDir, promptTokens: tokens } as const;
    });

  const runGeminiJson = Effect.fn("runGeminiJson")(function* <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    modelSelection,
    attachments,
  }: {
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: GeminiModelSelection;
    attachments?: ReadonlyArray<ChatAttachment> | undefined;
  }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
    const geminiSettings = yield* Effect.map(
      serverSettingsService.getSettings,
      (settings) => settings.providers.gemini,
    ).pipe(Effect.catch(() => Effect.undefined));

    const userArgs = resolveGeminiUserLaunchArgs(geminiSettings?.launchArgs ?? null).argv;
    // "auto" is a T3 sentinel the user-facing model picker surfaces as
    // "let Gemini pick" — we omit --model entirely in that case so Gemini
    // applies its own default model selection.
    const modelArgs =
      modelSelection.model && modelSelection.model !== "auto"
        ? (["--model", modelSelection.model] as const)
        : ([] as const);

    // Use a per-request Gemini home so headless text-generation runs can't
    // collide with interactive sessions. Settings disable checkpointing,
    // folder-trust, and sandboxing regardless of caller's home. Cleanup is
    // handled via Effect.ensuring at the return so we don't require Scope.
    const geminiHome = yield* fileSystem.makeTempDirectory({ prefix: "t3-gemini-home-" }).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail: "Failed to prepare Gemini CLI home.",
            cause,
          }),
      ),
    );
    yield* writeGeminiCliSettings({ home: geminiHome }).pipe(
      Effect.orElseSucceed(() => geminiHome),
    );
    // Seed the scratch home with the user's Gemini auth so
    // `gemini --prompt` doesn't trip a re-auth prompt.
    yield* seedGeminiCliHomeAuth({ home: geminiHome }).pipe(
      Effect.orElseSucceed(() => [] as ReadonlyArray<string>),
    );

    const staged = yield* stageAttachments(operation, attachments);
    const includeArgs: ReadonlyArray<string> = staged.directory
      ? (["--include-directories", staged.directory] as const)
      : ([] as const);
    const promptWithTokens =
      staged.promptTokens.length > 0
        ? `${prompt}\n\nAttachments:\n${staged.promptTokens.join(" ")}`
        : prompt;
    const cleanup = Effect.all(
      [removeDirectoryQuietly(geminiHome), removeDirectoryQuietly(staged.directory)],
      { discard: true, concurrency: "unbounded" },
    );

    const runGeminiCommand = Effect.fn("runGeminiJson.runGeminiCommand")(function* (
      effectivePrompt: string,
    ) {
      const command = ChildProcess.make(
        geminiSettings?.binaryPath || "gemini",
        [
          ...userArgs,
          ...includeArgs,
          ...modelArgs,
          "--output-format",
          "json",
          "--prompt",
          effectivePrompt,
        ],
        {
          cwd,
          // Gemini CLI reads config from `$HOME/.gemini/` (and
          // `%USERPROFILE%\.gemini` on Windows). Point both at the scratch
          // home so settings.json + seeded auth are honoured.
          // Neutralize keyring/DBus vars before HOME/USERPROFILE override
          // to keep libsecret from prompting during headless text gen.
          env: {
            ...process.env,
            ...GEMINI_KEYRING_NEUTRALIZING_ENV,
            HOME: geminiHome,
            USERPROFILE: geminiHome,
          },
          shell: process.platform === "win32",
        },
      );

      const child = yield* commandSpawner
        .spawn(command)
        .pipe(
          Effect.mapError((cause) =>
            normalizeCliError("gemini", operation, cause, "Failed to spawn Gemini CLI process"),
          ),
        );

      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          readStreamAsString(operation, child.stdout),
          readStreamAsString(operation, child.stderr),
          child.exitCode.pipe(
            Effect.mapError((cause) =>
              normalizeCliError("gemini", operation, cause, "Failed to read Gemini CLI exit code"),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );

      if (exitCode !== 0) {
        const stderrDetail = stderr.trim();
        const stdoutDetail = stdout.trim();
        const detail = stderrDetail.length > 0 ? stderrDetail : stdoutDetail;
        return yield* new TextGenerationError({
          operation,
          detail:
            detail.length > 0
              ? `Gemini CLI command failed: ${detail}`
              : `Gemini CLI command failed with code ${exitCode}.`,
        });
      }

      return stdout;
    });

    // Single run that:
    //   1. Spawns the CLI
    //   2. Parses the outer `{ "response": ... }` envelope
    //   3. Parses the inner JSON against outputSchemaJson
    // Surfaces decode failures as GeminiJsonDecodeError so the outer retry
    // loop can distinguish them from fatal CLI errors and retry once with a
    // "return valid JSON only" suffix.
    const attempt = (
      effectivePrompt: string,
    ): Effect.Effect<
      S["Type"],
      TextGenerationError | GeminiJsonDecodeError,
      S["DecodingServices"]
    > =>
      Effect.gen(function* () {
        const rawStdout = yield* runGeminiCommand(effectivePrompt).pipe(
          Effect.scoped,
          Effect.timeoutOption(GEMINI_TIMEOUT_MS),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new TextGenerationError({
                    operation,
                    detail: "Gemini CLI request timed out.",
                  }),
                ),
              onSome: (value) => Effect.succeed(value),
            }),
          ),
        );

        const envelope = yield* Schema.decodeEffect(Schema.fromJsonString(GeminiOutputEnvelope))(
          extractJsonObject(rawStdout),
        ).pipe(
          Effect.catchTag("SchemaError", (cause) =>
            Effect.fail<GeminiJsonDecodeError>({
              _tag: "GeminiJsonDecodeError",
              detail: "Gemini CLI returned unexpected output format.",
              cause,
            }),
          ),
        );

        const innerJson = extractJsonObject(envelope.response);
        if (innerJson.length === 0) {
          return yield* Effect.fail<GeminiJsonDecodeError>({
            _tag: "GeminiJsonDecodeError",
            detail: "Gemini CLI returned empty structured output.",
          });
        }

        return yield* Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson))(innerJson).pipe(
          Effect.catchTag("SchemaError", (cause) =>
            Effect.fail<GeminiJsonDecodeError>({
              _tag: "GeminiJsonDecodeError",
              detail: "Gemini returned invalid structured output.",
              cause,
            }),
          ),
        );
      });

    // First attempt uses the original prompt. On JSON decode failure, retry
    // once with an explicit "return valid JSON only" instruction. On the
    // second failure, surface a TextGenerationError (step 25).
    return yield* attempt(promptWithTokens).pipe(
      Effect.catchIf(
        (error): error is GeminiJsonDecodeError =>
          typeof error === "object" &&
          error !== null &&
          "_tag" in error &&
          (error as { _tag: string })._tag === "GeminiJsonDecodeError",
        () => attempt(`${promptWithTokens}${GEMINI_JSON_RETRY_SUFFIX}`),
      ),
      Effect.catchIf(
        (error): error is GeminiJsonDecodeError =>
          typeof error === "object" &&
          error !== null &&
          "_tag" in error &&
          (error as { _tag: string })._tag === "GeminiJsonDecodeError",
        (error) =>
          Effect.fail(
            new TextGenerationError({
              operation,
              detail: error.detail,
              ...(error.cause !== undefined ? { cause: error.cause } : {}),
            }),
          ),
      ),
      Effect.ensuring(cleanup),
    );
  });

  // ---------------------------------------------------------------------------
  // TextGenerationShape methods
  // ---------------------------------------------------------------------------

  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = Effect.fn(
    "GeminiTextGeneration.generateCommitMessage",
  )(function* (input) {
    const { prompt, outputSchema } = buildCommitMessagePrompt({
      branch: input.branch,
      stagedSummary: input.stagedSummary,
      stagedPatch: input.stagedPatch,
      includeBranch: input.includeBranch === true,
    });

    if (input.modelSelection.provider !== "gemini") {
      return yield* new TextGenerationError({
        operation: "generateCommitMessage",
        detail: "Invalid model selection.",
      });
    }

    const generated = yield* runGeminiJson({
      operation: "generateCommitMessage",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      subject: sanitizeCommitSubject(generated.subject),
      body: generated.body.trim(),
      ...("branch" in generated && typeof generated.branch === "string"
        ? { branch: sanitizeFeatureBranchName(generated.branch) }
        : {}),
    };
  });

  const generatePrContent: TextGenerationShape["generatePrContent"] = Effect.fn(
    "GeminiTextGeneration.generatePrContent",
  )(function* (input) {
    const { prompt, outputSchema } = buildPrContentPrompt({
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      commitSummary: input.commitSummary,
      diffSummary: input.diffSummary,
      diffPatch: input.diffPatch,
    });

    if (input.modelSelection.provider !== "gemini") {
      return yield* new TextGenerationError({
        operation: "generatePrContent",
        detail: "Invalid model selection.",
      });
    }

    const generated = yield* runGeminiJson({
      operation: "generatePrContent",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      title: sanitizePrTitle(generated.title),
      body: generated.body.trim(),
    };
  });

  const generateBranchName: TextGenerationShape["generateBranchName"] = Effect.fn(
    "GeminiTextGeneration.generateBranchName",
  )(function* (input) {
    const { prompt, outputSchema } = buildBranchNamePrompt({
      message: input.message,
      attachments: input.attachments,
    });

    if (input.modelSelection.provider !== "gemini") {
      return yield* new TextGenerationError({
        operation: "generateBranchName",
        detail: "Invalid model selection.",
      });
    }

    const generated = yield* runGeminiJson({
      operation: "generateBranchName",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
      ...(input.attachments ? { attachments: input.attachments } : {}),
    });

    return {
      branch: sanitizeBranchFragment(generated.branch),
    };
  });

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = Effect.fn(
    "GeminiTextGeneration.generateThreadTitle",
  )(function* (input) {
    const { prompt, outputSchema } = buildThreadTitlePrompt({
      message: input.message,
      attachments: input.attachments,
    });

    if (input.modelSelection.provider !== "gemini") {
      return yield* new TextGenerationError({
        operation: "generateThreadTitle",
        detail: "Invalid model selection.",
      });
    }

    const generated = yield* runGeminiJson({
      operation: "generateThreadTitle",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
      ...(input.attachments ? { attachments: input.attachments } : {}),
    });

    return {
      title: sanitizeThreadTitle(generated.title),
    } satisfies ThreadTitleGenerationResult;
  });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGenerationShape;
});

export const GeminiTextGenerationLive = Layer.effect(TextGeneration, makeGeminiTextGeneration);
