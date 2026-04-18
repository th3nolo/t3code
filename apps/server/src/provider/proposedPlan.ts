export const PROPOSED_PLAN_BLOCK_REGEX = /<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/i;

export function extractProposedPlanMarkdown(text: string | null | undefined): string | undefined {
  if (!text) {
    return undefined;
  }
  const match = PROPOSED_PLAN_BLOCK_REGEX.exec(text);
  const planMarkdown = match?.[1]?.trim();
  return planMarkdown && planMarkdown.length > 0 ? planMarkdown : undefined;
}
