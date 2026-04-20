import { type ProviderKind } from "@t3tools/contracts";
import { formatGeminiModelDisplayName } from "@t3tools/shared/gemini";

export function formatAppModelOptionName(
  provider: ProviderKind,
  model: string | null | undefined,
): string {
  const trimmed = model?.trim();
  if (!trimmed) {
    return "";
  }

  switch (provider) {
    case "gemini":
      return formatGeminiModelDisplayName(trimmed);
    default:
      return trimmed;
  }
}
