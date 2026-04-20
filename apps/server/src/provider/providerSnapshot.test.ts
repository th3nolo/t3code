import { describe, expect, it } from "vitest";
import type { ModelCapabilities } from "@t3tools/contracts";

import { providerModelsFromSettings } from "./providerSnapshot.ts";

const OPENCODE_CUSTOM_MODEL_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
  variantOptions: [{ value: "medium", label: "Medium", isDefault: true }],
  agentOptions: [{ value: "build", label: "Build", isDefault: true }],
};

describe("providerModelsFromSettings", () => {
  it("applies the provided capabilities to custom models", () => {
    const models = providerModelsFromSettings(
      [],
      "opencode",
      ["openai/gpt-5"],
      OPENCODE_CUSTOM_MODEL_CAPABILITIES,
    );

    expect(models).toEqual([
      {
        slug: "openai/gpt-5",
        name: "openai/gpt-5",
        isCustom: true,
        capabilities: OPENCODE_CUSTOM_MODEL_CAPABILITIES,
      },
    ]);
  });

  it("formats custom model names when requested", () => {
    const models = providerModelsFromSettings(
      [],
      "gemini",
      ["gemini-2.5-flash"],
      {
        reasoningEffortLevels: [],
        supportsFastMode: false,
        supportsThinkingToggle: false,
        contextWindowOptions: [],
        promptInjectedEffortLevels: [],
      },
      {
        formatCustomModelName: (slug) => `Formatted ${slug}`,
      },
    );

    expect(models).toEqual([
      {
        slug: "gemini-2.5-flash",
        name: "Formatted gemini-2.5-flash",
        isCustom: true,
        capabilities: {
          reasoningEffortLevels: [],
          supportsFastMode: false,
          supportsThinkingToggle: false,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
        },
      },
    ]);
  });
});
