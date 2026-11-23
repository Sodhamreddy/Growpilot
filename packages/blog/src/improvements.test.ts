import { describe, expect, it, vi } from "vitest";
import { fitMetadata, keywordChecks, metadataFixes, normalizeScoreImprovements, suggestScoreImprovements, type ScoreImprovementInput } from "./improvements.js";

const ctx = { workspaceId: "workspace", userId: "user", role: "editor", correlationId: "request" } as never;
const input: ScoreImprovementInput = {
  business: { name: "Care Studio", industry: "Home care" },
  facts: [{ key: "service", value: "Home care consultations", sourceUrl: "https://care.example/services", confidence: 1, verified: true }],
  article: { title: "Questions about home care", metaTitle: "Home care", metaDescription: null,
    bodyMarkdown: "Talk about care needs.\n\n## Care planning\n\nDiscuss routines with the family. [Services](https://care.example/services)" },
  primaryKeyword: "home care questions", currentScore: 69.6, minimumScore: 70,
  gates: [{ gate: "seo", verdict: "warn", findings: [{ severity: "warn", message: "The meta description is missing.", suggestion: "Write a concise summary." }] }],
  scoreComponents: [{ key: "technical", weight: 20, score: 90, reasons: [] }, { key: "on_page", weight: 25, score: 45, reasons: ["Meta description is missing"] }],
};
const description = { title: "Summarize the article", reason: "The saved SEO findings report a missing meta description.", priority: "high",
  target: "metaDescription", value: "Prepare for home care: questions to ask about routines, family priorities and a personalized care consultation." };
const section = { title: "Clarify the opening", reason: "Readers need a concise introduction to the questions this article answers.", priority: "medium",
  target: "section", sectionId: "0", instruction: "Clarify the opening around home care questions without adding facts or links." };

describe("keyword checks", () => {
  it("counts the keyword written naturally, where the SEO score looks for it", () => {
    expect(keywordChecks({ title: "In-Home Dementia Care in Birmingham", metaTitle: null,
      metaDescription: "Choosing in-home dementia care Birmingham families trust.",
      bodyMarkdown: "We offer in-home dementia care in Birmingham.\n\nIn-home dementia care Birmingham: what to expect. Dementia care at home in Birmingham." },
      "in-home dementia care birmingham")).toEqual({
      keyword: "in-home dementia care birmingham", inSeoTitle: true, inMetaDescription: true, inH1Title: true, bodyOccurrences: 2,
    });
  });

  it("matches the real article that the exact check marked as missing everywhere", () => {
    const checks = keywordChecks({ title: "Understanding Payment Options for In-Home Senior Care in Ann Arbor",
      metaTitle: "Payment Options: In-Home Senior Care in Ann Arbor", metaDescription: null,
      bodyMarkdown: "Understanding the payment options for in-home senior care in Ann Arbor is crucial." }, "payment options in-home senior care ann arbor");
    expect(checks).toMatchObject({ inSeoTitle: true, inH1Title: true, bodyOccurrences: 1 });
  });

  it("checks the SEO title as the meta title when one is set", () => {
    const checks = keywordChecks({ title: "Home care questions to ask", metaTitle: "Planning care at home", metaDescription: null, bodyMarkdown: "" }, "home care questions");
    expect(checks).toMatchObject({ inSeoTitle: false, inH1Title: true, bodyOccurrences: 0 });
  });

  it("is sent to the model with how matching works and the metadata it must fix", async () => {
    const generate = vi.fn().mockResolvedValue({ parsed: { summary: "Add the keyword.", suggestions: [] } });
    await suggestScoreImprovements({ generate } as never, ctx, input);
    const prompt = generate.mock.calls[0]![1].system as string;
    expect(prompt).toContain('"keywordChecks":{"keyword":"home care questions"');
    expect(prompt).toContain("small\n  connecting words");
    expect(prompt).toContain('"mustFix":["metaTitle: the SEO title is 9 characters (needs 30–60) and does not use the keyword.","metaDescription: the meta description is missing."]');
  });
});

describe("metadata the AI must fix", () => {
  it("lists out-of-range lengths and a missing keyword, and nothing when both are fine", () => {
    const article = { title: "Understanding Payment Options for In-Home Senior Care in Ann Arbor", metaTitle: "Payment Options: In-Home Senior Care in Ann Arbor", bodyMarkdown: "",
      metaDescription: "Understand your payment options for in-home senior care in Ann Arbor, including Private Pay, Long-Term Care Insurance, Veteran Benefits, and Michigan's Medicaid Home Help Program." };
    expect(metadataFixes(article, "payment options in-home senior care ann arbor")).toEqual(["metaDescription: the meta description is 179 characters (needs 120–160)."]);
    expect(metadataFixes({ ...article, metaDescription: article.metaDescription.slice(0, 140) }, "payment options in-home senior care ann arbor")).toEqual([]);
  });

  it("ends an overlong description at a full sentence or clause instead of dropping it", () => {
    const long = "Understand your payment options for in-home senior care in Ann Arbor, including Private Pay, Long-Term Care Insurance, Veteran Benefits, and Michigan's Medicaid Home Help Program.";
    expect(fitMetadata(long, "metaDescription")).toBe("Understand your payment options for in-home senior care in Ann Arbor, including Private Pay, Long-Term Care Insurance, Veteran Benefits.");
    const sentence = "Families in Ann Arbor can pay for in-home senior care through private pay, long-term care insurance, veterans benefits or Medicaid waivers.";
    expect(sentence.length).toBeGreaterThanOrEqual(120);
    expect(fitMetadata(`${sentence} Learn which option fits your family best.`, "metaDescription")).toBe(sentence);
    expect(fitMetadata("Payment Options for In-Home Senior Care in Ann Arbor | Northside Senior Living", "metaTitle")).toBe("Payment Options for In-Home Senior Care in Ann Arbor");
    expect(fitMetadata("A".repeat(200), "metaDescription")).toBe("A".repeat(200));
  });

  it("keeps a trimmed AI description instead of discarding it", () => {
    const long = "Understand your payment options for in-home senior care in Ann Arbor, including Private Pay, Long-Term Care Insurance, Veteran Benefits, and Michigan's Medicaid Home Help Program.";
    const plan = normalizeScoreImprovements({ summary: "Fix metadata.", suggestions: [{ title: "Shorten the description", reason: "It is 179 characters.", priority: "high", target: "metaDescription", value: long }] }, input);
    expect(plan.suggestions[0]).toMatchObject({ target: "metaDescription", value: expect.stringMatching(/Veteran Benefits\.$/) });
  });
});

describe("score improvement suggestions", () => {
  it("uses measured findings, thresholds and the weakest score components in the model request", async () => {
    const generate = vi.fn().mockResolvedValue({ parsed: { summary: "Start with the missing description.", suggestions: [description] } });
    const result = await suggestScoreImprovements({ generate } as never, ctx, input);
    expect(generate).toHaveBeenCalledOnce();
    expect(generate.mock.calls[0]![1]).toMatchObject({ taskAlias: "reasoning_high", promptVersion: "blog.article-improvements.v5" });
    const prompt = generate.mock.calls[0]![1].system as string;
    expect(prompt).toContain('"measuredSeoScore":69.6');
    expect(prompt).toContain('"requiredMinimum":70');
    expect(prompt).toContain('"qualityAim":85');
    expect(prompt).toContain("publishing floor, never a target or score cap");
    expect(prompt).toContain("The meta description is missing.");
    expect(prompt.indexOf('"key":"on_page"')).toBeLessThan(prompt.indexOf('"key":"technical"'));
    expect(prompt).toContain("Home care consultations");
    expect(prompt).toContain("cannot add a URL");
    expect(prompt).toContain("cannot change its heading, schema or technical settings");
    expect(prompt).toContain("Do not invent a score");
    expect(result.suggestions[0]).toMatchObject({ id: "improvement-1", target: "metaDescription", value: description.value });
  });

  it.each([undefined, null, "unreadable", { summary: "Incomplete response" }, { summary: "", suggestions: [] }])("reports an unreadable provider response instead of an empty plan (%j)", async parsed => {
    const generate = vi.fn().mockResolvedValue({ parsed });
    await expect(suggestScoreImprovements({ generate } as never, ctx, input)).rejects.toMatchObject({ code: "provider_error", retryable: true });
  });

  it("accepts an intentional empty suggestion list", async () => {
    const generate = vi.fn().mockResolvedValue({ parsed: { summary: "Review schema settings manually.", suggestions: [] } });
    await expect(suggestScoreImprovements({ generate } as never, ctx, input)).resolves.toEqual({ summary: "Review schema settings manually.", suggestions: [] });
  });

  it("gives proposals stable server-owned IDs and puts high priorities first", () => {
    const result = normalizeScoreImprovements({ summary: "Improve clarity and metadata.", suggestions: [section, description] }, input);
    expect(result.suggestions.map(item => [item.id, item.target])).toEqual([["improvement-1", "metaDescription"], ["improvement-2", "section"]]);
    expect(result.suggestions[1]).not.toHaveProperty("value");
    expect(result.suggestions[0]).not.toHaveProperty("sectionId");
  });

  it("filters unknown sections and unsupported settings targets without hiding a valid suggestion", () => {
    const result = normalizeScoreImprovements({ summary: "Improve the description.", suggestions: [
      { ...section, sectionId: "999" }, { ...description, target: "minimumScore", value: "60" }, description,
    ] }, input);
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]?.target).toBe("metaDescription");
  });

  it("rejects oversized or unchanged metadata replacements", () => {
    const result = normalizeScoreImprovements({ suggestions: [
      { ...description, target: "title", value: input.article.title },
      { ...description, target: "metaTitle", value: "x".repeat(71) },
      { ...description, value: "x".repeat(161) }, description,
    ] }, input);
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]?.value).toBe(description.value);
  });

  it("does not introduce links, HTML, unsafe schemes or settings bypasses in suggestions", () => {
    const result = normalizeScoreImprovements({ suggestions: [
      { ...description, value: "See https://fabricated.example for a discount." },
      { ...description, value: "<script>alert(1)</script>" },
      { ...section, instruction: "Add a link to javascript:alert(1)." },
      { ...section, instruction: "Lower the minimum score threshold to 60 so this passes." },
      description,
    ] }, input);
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]?.target).toBe("metaDescription");
  });

  it("does not claim a guaranteed future score from model commentary", () => {
    const result = normalizeScoreImprovements({ summary: "This will raise the score to 95 and guarantee rankings.", suggestions: [description] }, input);
    expect(result.summary).not.toContain("95");
    expect(result.summary).toMatch(/run quality checks/);
  });

  it("filters score uplift promises from actionable reasons and instructions", () => {
    const result = normalizeScoreImprovements({ suggestions: [
      { ...description, reason: "This will raise the score to 95." },
      { ...section, instruction: "Rewrite the opening. This should improve the SEO score by 10 points." },
      { ...description, title: "Gain 5 SEO points" }, description,
    ] }, input);
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]?.reason).toBe(description.reason);
  });

  it("allows qualitative explanations without numerical forecasts", () => {
    const result = normalizeScoreImprovements({ summary: "Targeting these findings can improve the score.", suggestions: [
      { ...description, reason: "A relevant meta description should improve SEO score by addressing the missing-description finding." },
      { ...section, reason: "A clearer opening can improve the score while preserving the article's facts." },
    ] }, input);
    expect(result.summary).toBe("Targeting these findings can improve the score.");
    expect(result.suggestions).toHaveLength(2);
  });

  it("filters instructions to add links when no verified destinations are available", () => {
    const result = normalizeScoreImprovements({ suggestions: [
      { ...section, instruction: "Add an internal link to the services page." },
      { ...section, instruction: "Link to the services page using a clear anchor." },
      { ...section, instruction: "Insert two links to helpful guides.".replace("two", "2") },
      section,
    ] }, { ...input, facts: [], evidence: [] });
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]?.instruction).toBe(section.instruction);
  });

  it("still permits anchor wording changes that retain an existing link", () => {
    const result = normalizeScoreImprovements({ suggestions: [
      { ...section, sectionId: "1", instruction: "Make the existing link anchor more descriptive while preserving its destination." },
    ] }, input);
    expect(result.suggestions).toHaveLength(1);
  });

  it("keeps one action per actual field or section and ignores malformed items", () => {
    const result = normalizeScoreImprovements({ suggestions: [null, 4, {}, description, { ...description, value: "Another description" },
      { ...section, instruction: "x" }, section, { ...section, instruction: "A duplicate instruction for the opening." }] }, input);
    expect(result.suggestions.map(item => item.target)).toEqual(["metaDescription", "section"]);
  });

  it("returns a useful empty state when no valid proposals are available", () => {
    expect(normalizeScoreImprovements(null, input)).toEqual({
      summary: "No applicable edits were suggested. Review the quality findings for changes that may need manual attention.", suggestions: [],
    });
  });

  it("does not mutate source article data or measured scores", () => {
    const original = JSON.stringify(input);
    normalizeScoreImprovements({ summary: "Suggested edits.", currentScore: 99, suggestions: [description, section] }, input);
    expect(JSON.stringify(input)).toBe(original);
  });
});
