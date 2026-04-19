import * as nodePath from "node:path";

import { type ThreadId, type TurnId } from "@t3tools/contracts";
import { Cause, Effect, FileSystem, Option, Schema } from "effect";

export const GEMINI_SESSION_SCHEMA_VERSION = 1 as const;

export const GeminiSessionTurnRecord = Schema.Struct({
  turnId: Schema.String,
  messageCountBefore: Schema.Number,
  messageCountAfter: Schema.Number,
  status: Schema.Literals(["completed", "incomplete"]),
});
export type GeminiSessionTurnRecord = typeof GeminiSessionTurnRecord.Type;

export const GeminiSessionMetadata = Schema.Struct({
  schemaVersion: Schema.Literal(GEMINI_SESSION_SCHEMA_VERSION),
  sessionId: Schema.String,
  chatFileRelativePath: Schema.optional(Schema.String),
  turns: Schema.Array(GeminiSessionTurnRecord),
});
export type GeminiSessionMetadata = typeof GeminiSessionMetadata.Type;

const decodeGeminiSessionMetadata = Schema.decodeUnknownEffect(
  Schema.fromJsonString(GeminiSessionMetadata),
);

export const GeminiResumeCursor = Schema.Struct({
  schemaVersion: Schema.Literal(GEMINI_SESSION_SCHEMA_VERSION),
  sessionId: Schema.String,
});
export type GeminiResumeCursor = typeof GeminiResumeCursor.Type;

const GeminiChatEnvelope = Schema.Struct({
  sessionId: Schema.optional(Schema.String),
  messages: Schema.Array(Schema.Unknown),
});
type GeminiChatEnvelope = typeof GeminiChatEnvelope.Type;

const decodeGeminiChatEnvelope = Schema.decodeUnknownEffect(
  Schema.fromJsonString(GeminiChatEnvelope),
);

export function parseGeminiResumeCursor(raw: unknown): GeminiResumeCursor | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  if (record["schemaVersion"] !== GEMINI_SESSION_SCHEMA_VERSION) {
    return undefined;
  }
  if (typeof record["sessionId"] !== "string" || record["sessionId"].trim().length === 0) {
    return undefined;
  }
  return {
    schemaVersion: GEMINI_SESSION_SCHEMA_VERSION,
    sessionId: record["sessionId"].trim(),
  };
}

export function resolveGeminiThreadPaths(input: {
  readonly providerStateDir: string;
  readonly threadId: ThreadId;
}) {
  const threadDir = nodePath.join(input.providerStateDir, "gemini", input.threadId);
  const home = nodePath.join(threadDir, "home");
  const metadataPath = nodePath.join(threadDir, "session-metadata.json");
  return { threadDir, home, metadataPath } as const;
}

export const readGeminiSessionMetadata = (metadataPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(metadataPath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return undefined;
    }
    const raw = yield* fs.readFileString(metadataPath).pipe(Effect.orElseSucceed(() => ""));
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return undefined;
    }
    return yield* decodeGeminiSessionMetadata(trimmed).pipe(
      Effect.matchCauseEffect({
        onFailure: (cause) =>
          Effect.logWarning("failed to parse gemini session metadata, ignoring", {
            path: metadataPath,
            issues: Cause.pretty(cause),
          }).pipe(Effect.as(undefined)),
        onSuccess: Effect.succeed,
      }),
    );
  });

export const writeGeminiSessionMetadata = (input: {
  readonly metadataPath: string;
  readonly metadata: GeminiSessionMetadata;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(nodePath.dirname(input.metadataPath), { recursive: true });
    const tempPath = `${input.metadataPath}.${process.pid}.${Date.now()}.tmp`;
    const encoded = `${JSON.stringify(input.metadata, null, 2)}\n`;
    yield* fs.writeFileString(tempPath, encoded).pipe(
      Effect.flatMap(() => fs.rename(tempPath, input.metadataPath)),
      Effect.ensuring(fs.remove(tempPath, { force: true }).pipe(Effect.ignore)),
    );
  });

export function appendGeminiTurn(
  metadata: GeminiSessionMetadata,
  turn: GeminiSessionTurnRecord,
): GeminiSessionMetadata {
  return {
    ...metadata,
    turns: [...metadata.turns, turn],
  };
}

export function updateLastGeminiTurnStatus(
  metadata: GeminiSessionMetadata,
  status: GeminiSessionTurnRecord["status"],
  overrides?: Partial<Omit<GeminiSessionTurnRecord, "turnId" | "status">>,
): GeminiSessionMetadata {
  if (metadata.turns.length === 0) {
    return metadata;
  }
  const previous = metadata.turns[metadata.turns.length - 1]!;
  return {
    ...metadata,
    turns: [
      ...metadata.turns.slice(0, -1),
      {
        ...previous,
        ...overrides,
        status,
      },
    ],
  };
}

export function truncateGeminiTurns(
  metadata: GeminiSessionMetadata,
  numTurns: number,
): {
  readonly next: GeminiSessionMetadata;
  readonly truncated: ReadonlyArray<GeminiSessionTurnRecord>;
} {
  const safeNum = Math.max(0, Math.trunc(numTurns));
  if (safeNum === 0 || metadata.turns.length === 0) {
    return { next: metadata, truncated: [] };
  }
  const nextLength = Math.max(0, metadata.turns.length - safeNum);
  return {
    next: {
      ...metadata,
      turns: metadata.turns.slice(0, nextLength),
    },
    truncated: metadata.turns.slice(nextLength),
  };
}

export function makeInitialGeminiMetadata(input: {
  readonly sessionId: string;
  readonly chatFileRelativePath?: string;
}): GeminiSessionMetadata {
  return {
    schemaVersion: GEMINI_SESSION_SCHEMA_VERSION,
    sessionId: input.sessionId,
    ...(input.chatFileRelativePath ? { chatFileRelativePath: input.chatFileRelativePath } : {}),
    turns: [],
  };
}

/**
 * Decide whether persisted metadata is safe to reuse for the incoming
 * session-start request.
 *
 * - **Resume path (`resumeSessionId` defined):** we require the persisted
 *   sessionId to exactly match. Reusing metadata that points at a
 *   different session would attribute turns to the wrong thread.
 * - **Fresh-start path (`resumeSessionId` undefined):** we accept
 *   persisted metadata optimistically. `afterSessionCreated` reconciles
 *   against the real ACP session id; if it diverges, metadata is reset
 *   to a fresh snapshot before any turn runs.
 */
export function canReusePersistedGeminiMetadata(
  persistedMetadata: GeminiSessionMetadata | undefined,
  resumeSessionId: string | undefined,
): boolean {
  if (persistedMetadata === undefined) return false;
  if (resumeSessionId === undefined) return true;
  return persistedMetadata.sessionId === resumeSessionId;
}

/**
 * Replace `chatFileRelativePath` if it differs (or is currently absent). Returns
 * the input metadata unchanged when the value already matches, so callers can
 * skip the persist step.
 */
export function withGeminiChatFileRelativePath(
  metadata: GeminiSessionMetadata,
  chatFileRelativePath: string,
): GeminiSessionMetadata {
  const trimmed = chatFileRelativePath.trim();
  if (trimmed.length === 0) {
    return metadata;
  }
  if (metadata.chatFileRelativePath === trimmed) {
    return metadata;
  }
  return {
    ...metadata,
    chatFileRelativePath: trimmed,
  };
}

export function makeGeminiTurnRecord(input: {
  readonly turnId: TurnId;
  readonly messageCountBefore: number;
  readonly messageCountAfter: number;
  readonly status: GeminiSessionTurnRecord["status"];
}): GeminiSessionTurnRecord {
  return {
    turnId: input.turnId,
    messageCountBefore: input.messageCountBefore,
    messageCountAfter: input.messageCountAfter,
    status: input.status,
  };
}

function uniqueAbsolutePaths(paths: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Set(paths.map((value) => nodePath.resolve(value)))];
}

const readGeminiChatEnvelope = (chatFilePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const raw = yield* fs.readFileString(chatFilePath);
    return yield* decodeGeminiChatEnvelope(raw);
  });

export const countPersistedGeminiMessages = (chatFilePath: string) =>
  Effect.map(readGeminiChatEnvelope(chatFilePath), (chat) => chat.messages.length);

export const truncatePersistedGeminiMessages = (input: {
  readonly chatFilePath: string;
  readonly messageCount: number;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    // Parse the raw JSON and shape-check it. We deliberately work off the
    // raw object (not the schema-decoded value) so unknown fields like
    // `metadata` or `model` survive the round-trip — schema decoding
    // would strip them. JSON.parse can legally return arrays or scalars;
    // narrow to a record before casting.
    const raw = yield* fs.readFileString(input.chatFilePath);
    const parsedUnknown: unknown = JSON.parse(raw);
    if (
      typeof parsedUnknown !== "object" ||
      parsedUnknown === null ||
      Array.isArray(parsedUnknown)
    ) {
      return yield* Effect.die(
        new Error(
          `Gemini chat file ${input.chatFilePath} is not a JSON object (got ${Array.isArray(parsedUnknown) ? "array" : typeof parsedUnknown}).`,
        ),
      );
    }
    const parsed = parsedUnknown as Record<string, unknown>;
    const messages = Array.isArray(parsed["messages"]) ? parsed["messages"] : [];
    const nextMessageCount = Math.max(0, Math.trunc(input.messageCount));
    const nextMessages = messages.slice(0, nextMessageCount);
    const nextChat = { ...parsed, messages: nextMessages };
    const tempPath = `${input.chatFilePath}.${process.pid}.${Date.now()}.tmp`;
    yield* fs.writeFileString(tempPath, `${JSON.stringify(nextChat, null, 2)}\n`).pipe(
      Effect.flatMap(() => fs.rename(tempPath, input.chatFilePath)),
      Effect.ensuring(fs.remove(tempPath, { force: true }).pipe(Effect.ignore)),
    );
    return nextMessages.length;
  });

/**
 * Relative path (under the per-thread Gemini home) where Gemini CLI
 * persists chat files. The CLI writes them to `$HOME/.gemini/tmp/`
 * followed by a per-session UUID dir and a `chats/` subdir:
 *
 *   $HOME/.gemini/tmp/<session-uuid>/chats/<timestamp>.json
 *
 * This is **not a public contract** — it's the Gemini CLI package's
 * internal layout as of April 2026 (gemini CLI ≈ v0.x). The
 * chat-file resolution logic below scans for `<anything>/chats/*.json`
 * under `tmp/`; if a future CLI release restructures this, resume +
 * rollback will silently no-op until we update the pattern.
 */
const GEMINI_CLI_CHATS_DIR_SEGMENT = `${nodePath.sep}chats${nodePath.sep}`;

export const resolveGeminiChatFile = (input: {
  readonly home: string;
  readonly sessionId: string;
  readonly chatFileRelativePath?: string;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = nodePath.resolve(input.home);

    const explicitPath = input.chatFileRelativePath
      ? nodePath.resolve(home, input.chatFileRelativePath)
      : undefined;
    if (explicitPath) {
      const explicitExists = yield* fs.exists(explicitPath).pipe(Effect.orElseSucceed(() => false));
      if (explicitExists) {
        const explicitChat = yield* readGeminiChatEnvelope(explicitPath).pipe(Effect.option);
        if (Option.isSome(explicitChat)) {
          const sessionId = explicitChat.value.sessionId?.trim();
          if (!sessionId || sessionId === input.sessionId) {
            return {
              absolutePath: explicitPath,
              relativePath: nodePath.relative(home, explicitPath),
            } as const;
          }
        }
      }
    }

    const tmpRoot = nodePath.join(home, "tmp");
    const tmpExists = yield* fs.exists(tmpRoot).pipe(Effect.orElseSucceed(() => false));
    if (!tmpExists) {
      return undefined;
    }

    const entries = yield* fs
      .readDirectory(tmpRoot, { recursive: true })
      .pipe(Effect.orElseSucceed(() => []));
    const candidatePaths = uniqueAbsolutePaths(
      entries
        .filter((entry) => entry.endsWith(".json"))
        .filter((entry) => entry.includes(GEMINI_CLI_CHATS_DIR_SEGMENT))
        .map((entry) => nodePath.resolve(tmpRoot, entry)),
    );

    if (entries.length > 0 && candidatePaths.length === 0) {
      // tmp/ has content but nothing under */chats/* — likely a Gemini
      // CLI release that restructured the layout. Surface early so
      // resume-with-truncate failures aren't silent.
      yield* Effect.logWarning(
        "Gemini CLI tmp/ directory has entries but no */chats/*.json matches; " +
          "chat-file resolution may be out of date with the installed CLI.",
        { tmpRoot, entryCount: entries.length },
      );
    }

    for (const candidatePath of candidatePaths) {
      const candidate = yield* readGeminiChatEnvelope(candidatePath).pipe(Effect.option);
      if (Option.isNone(candidate)) {
        continue;
      }
      if (candidate.value.sessionId?.trim() === input.sessionId) {
        return {
          absolutePath: candidatePath,
          relativePath: nodePath.relative(home, candidatePath),
        } as const;
      }
    }

    return undefined;
  });
