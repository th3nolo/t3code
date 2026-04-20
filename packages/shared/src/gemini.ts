function trimOrEmpty(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function formatTitleCaseToken(token: string): string {
  const normalized = trimOrEmpty(token);
  if (!normalized) {
    return "";
  }
  if (/^\d+(?:\.\d+)*$/u.test(normalized)) {
    return normalized;
  }

  const lower = normalized.toLowerCase();
  switch (lower) {
    case "ai":
      return "AI";
    case "api":
      return "API";
    case "gpt":
      return "GPT";
    default:
      return lower[0]?.toUpperCase() + lower.slice(1);
  }
}

function formatGeminiBody(body: string): string {
  const tokens = body
    .split(/[-_]+/u)
    .map((token) => trimOrEmpty(token))
    .filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return "Gemini";
  }

  const preview = tokens[tokens.length - 1]?.toLowerCase() === "preview" ? tokens.pop() : undefined;
  const label = `Gemini ${tokens.map((token) => formatTitleCaseToken(token)).join(" ")}`.trim();
  return preview ? `${label} (Preview)` : label;
}

export function formatGeminiModelDisplayName(model: string | null | undefined): string {
  const trimmed = trimOrEmpty(model);
  if (!trimmed) {
    return "";
  }
  if (trimmed.toLowerCase() === "auto") {
    return "Auto";
  }

  const autoMatch = /^auto-gemini-(.+)$/iu.exec(trimmed);
  if (autoMatch) {
    return `Auto (${formatGeminiBody(autoMatch[1] ?? "")})`;
  }

  if (!/^gemini[-_]?/iu.test(trimmed)) {
    return trimmed;
  }

  return formatGeminiBody(trimmed.replace(/^gemini[-_]?/iu, ""));
}
