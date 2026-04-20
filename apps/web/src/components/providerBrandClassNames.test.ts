import { describe, expect, it } from "vitest";

import {
  CLAUDE_PROVIDER_ICON_CLASS_NAME,
  GEMINI_PROVIDER_ICON_CLASS_NAME,
  normalizeProviderBrandKey,
  providerIconClassName,
} from "./providerBrandClassNames";

describe("normalizeProviderBrandKey", () => {
  it("normalizes known provider aliases", () => {
    expect(normalizeProviderBrandKey("cursorAgent")).toBe("cursor");
    expect(normalizeProviderBrandKey("openCodeCli")).toBe("opencode");
  });
});

describe("providerIconClassName", () => {
  it("returns brand classes for Claude and Gemini", () => {
    expect(providerIconClassName("claudeAgent", "fallback")).toBe(CLAUDE_PROVIDER_ICON_CLASS_NAME);
    expect(providerIconClassName("gemini", "fallback")).toBe(GEMINI_PROVIDER_ICON_CLASS_NAME);
  });

  it("preserves the fallback for unbranded providers", () => {
    expect(providerIconClassName("codex", "fallback")).toBe("fallback");
  });
});
