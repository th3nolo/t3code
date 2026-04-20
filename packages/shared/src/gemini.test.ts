import { describe, expect, it } from "vitest";

import { formatGeminiModelDisplayName } from "./gemini.ts";

describe("formatGeminiModelDisplayName", () => {
  it("formats current branch Gemini slugs cleanly", () => {
    expect(formatGeminiModelDisplayName("auto")).toBe("Auto");
    expect(formatGeminiModelDisplayName("gemini-2.5-flash")).toBe("Gemini 2.5 Flash");
    expect(formatGeminiModelDisplayName("gemini-3.1-pro-preview")).toBe("Gemini 3.1 Pro (Preview)");
  });

  it("formats auto-gemini aliases and preserves non-gemini slugs", () => {
    expect(formatGeminiModelDisplayName("auto-gemini-3")).toBe("Auto (Gemini 3)");
    expect(formatGeminiModelDisplayName("custom/internal-model")).toBe("custom/internal-model");
  });
});
