import { describe, expect, it } from "vitest";

import { formatAppModelOptionName } from "./providerModelNames";

describe("formatAppModelOptionName", () => {
  it("formats Gemini model names for UI display", () => {
    expect(formatAppModelOptionName("gemini", "gemini-2.5-flash")).toBe("Gemini 2.5 Flash");
  });

  it("preserves non-Gemini model names", () => {
    expect(formatAppModelOptionName("codex", "gpt-5.4")).toBe("gpt-5.4");
  });
});
