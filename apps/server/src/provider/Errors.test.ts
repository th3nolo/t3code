import { assert, describe, it } from "@effect/vitest";

import { providerErrorDetailFromCause } from "./Errors.ts";

describe("providerErrorDetailFromCause", () => {
  it("prefers a real Error message", () => {
    assert.equal(
      providerErrorDetailFromCause(new Error("Gemini runtime failed"), "fallback"),
      "Gemini runtime failed",
    );
  });

  it("accepts plain objects with a string message", () => {
    assert.equal(
      providerErrorDetailFromCause({ message: "plain object failure" }, "fallback"),
      "plain object failure",
    );
  });

  it("falls back to a tagged description when message is missing", () => {
    assert.equal(
      providerErrorDetailFromCause(
        { _tag: "FileSystemError", method: "writeFileString" },
        "Failed to prepare Gemini ACP session.",
      ),
      "Failed to prepare Gemini ACP session. (FileSystemError)",
    );
  });

  it("returns the fallback when no useful detail is present", () => {
    assert.equal(
      providerErrorDetailFromCause(undefined, "Failed to start Gemini ACP runtime."),
      "Failed to start Gemini ACP runtime.",
    );
  });
});
