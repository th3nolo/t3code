import { describe, expect, it } from "vitest";

import { extractProposedPlanMarkdown, PROPOSED_PLAN_BLOCK_REGEX } from "./proposedPlan.ts";

describe("extractProposedPlanMarkdown", () => {
  it("returns undefined for null, undefined, or empty input", () => {
    expect(extractProposedPlanMarkdown(null)).toBeUndefined();
    expect(extractProposedPlanMarkdown(undefined)).toBeUndefined();
    expect(extractProposedPlanMarkdown("")).toBeUndefined();
    expect(extractProposedPlanMarkdown("no plan block here")).toBeUndefined();
  });

  it("extracts markdown between <proposed_plan> tags", () => {
    const text = "intro\n<proposed_plan>\n- step 1\n- step 2\n</proposed_plan>\noutro";
    expect(extractProposedPlanMarkdown(text)).toBe("- step 1\n- step 2");
  });

  it("returns undefined when the block is empty or whitespace", () => {
    expect(extractProposedPlanMarkdown("<proposed_plan></proposed_plan>")).toBeUndefined();
    expect(extractProposedPlanMarkdown("<proposed_plan>\n  \n</proposed_plan>")).toBeUndefined();
  });

  it("matches case-insensitively via the exported regex", () => {
    expect(PROPOSED_PLAN_BLOCK_REGEX.test("<PROPOSED_PLAN>body</PROPOSED_PLAN>")).toBe(true);
  });
});
