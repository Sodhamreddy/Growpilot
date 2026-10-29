import { describe, expect, it, vi } from "vitest";
import type { ScoreImprovementSuggestion } from "./improvements.js";
import { composeScoreImprovementPreview, previewScoreImprovements } from "./improvement-preview.js";

const tenant = { workspaceId: "workspace", userId: "editor", role: "editor", correlationId: "preview-test" } as never;
const article = {
  title: "Home care planning questions", metaTitle: "Home care planning", metaDescription: null,
  bodyMarkdown: [
    "Start with the family's care priorities.",
    "## Care plan", "Discuss daily routines. [Our services](/services) [Care options](https://care.example/options)",
    "## Care plan", "Write down the family's questions.",
    "## Next steps", "Contact the care team to discuss your priorities.",
  ].join("\n\n"),
};
const section = (sectionId: string, id = `section-${sectionId}`): ScoreImprovementSuggestion => ({
  id, title: "Clarify care planning", reason: "Make this section easier for families to use.", priority: "high",
  target: "section", sectionId, instruction: "Clarify this section while preserving all facts and link destinations.",
});
const metadata = (target: "title" | "metaTitle" | "metaDescription", value: string, id: string = target): ScoreImprovementSuggestion => ({
  id, title: "Clarify the search summary", reason: "Help readers understand the article's purpose.", priority: "high", target, value,
});
const titleChange = metadata("metaTitle", "Home care planning: questions for your consultation");
function input(suggestions: ScoreImprovementSuggestion[]): Parameters<typeof previewScoreImprovements>[2] {
  return {
    business: { name: "Care Studio", industry: "Home care" },
    facts: [{ key: "service", value: "Home care consultations", confidence: 1, verified: true }],
    article: { ...article }, primaryKeyword: "home care planning", currentScore: 69.6, minimumScore: 70,
    gates: [], scoreComponents: [], suggestions, voice: null,
  };
}
const model = (sections: unknown) => vi.fn().mockResolvedValue({ parsed: { sections } });
const linkedBody = "Discuss your daily care routines. [Home care services](/services) [Available care options](https://care.example/options)";

describe("selected score improvement previews", () => {
  it("prepares metadata-only changes without spending an AI request", async () => {
    const generate = vi.fn();
    const result = await previewScoreImprovements({ generate } as never, tenant, input([titleChange]));

    expect(generate).not.toHaveBeenCalled();
    expect(result).toEqual({
      patch: { metaTitle: titleChange.value },
      changes: [{ suggestionId: titleChange.id, target: "metaTitle", before: article.metaTitle, after: titleChange.value, changed: true }],
    });
  });

  it("prepares several selected sections in one model request and combines their original positional IDs", async () => {
    const generate = model([
      { sectionId: "2", content: "List the questions you want to discuss with the care team." },
      { sectionId: "1", content: linkedBody },
    ]);
    const result = await previewScoreImprovements({ generate } as never, tenant, input([section("1"), titleChange, section("2")]));

    expect(generate).toHaveBeenCalledOnce();
    expect(generate.mock.calls[0]![1]).toMatchObject({ taskAlias: "editing_rewrite", promptVersion: "blog.score-improvements-preview.v1" });
    expect(result.changes.map(change => change.suggestionId)).toEqual(["section-1", "metaTitle", "section-2"]);
    expect(result.patch.metaTitle).toBe(titleChange.value);
    expect(result.patch.bodyMarkdown).toBe([
      "Start with the family's care priorities.",
      "## Care plan", linkedBody,
      "## Care plan", "List the questions you want to discuss with the care team.",
      "## Next steps", "Contact the care team to discuss your priorities.",
    ].join("\n\n"));
  });

  it("omits the body patch for a section that only changes whitespace", async () => {
    const generate = model([{ sectionId: "0", content: "  Start with the family's  care priorities.  " }]);
    const result = await previewScoreImprovements({ generate } as never, tenant, input([section("0"), titleChange]));

    expect(result.changes[0]?.changed).toBe(false);
    expect(result.patch).toEqual({ metaTitle: titleChange.value });
    expect(result.patch).not.toHaveProperty("bodyMarkdown");
  });

  it("keeps an entirely unchanged preview empty", () => {
    const result = composeScoreImprovementPreview(article, [section("0")], [{ sectionId: "0", content: "Start with the family's care priorities." }]);
    expect(result.patch).toEqual({});
    expect(result.changes).toEqual([expect.objectContaining({ changed: false })]);
  });

  it.each([
    ["new URL", `${linkedBody} [Extra source](https://unverified.example/source)`],
    ["dropped URL", "Discuss daily routines. [Our services](/services)"],
    ["changed destination", linkedBody.replace("/services)", "/unverified-services)")],
    ["new heading", `${linkedBody}\n\n## New section\n\nUnreviewed structure.`],
    ["indented heading", `${linkedBody}\n\n  ## New section\n\nUnreviewed structure.`],
    ["new image at an existing link destination", linkedBody.replace("[Home care services]", "![Home care services]")],
    ["HTML", `${linkedBody} <strong>More information</strong>`],
    ["empty body", "   "],
    ["oversized section", "a".repeat(100001)],
  ])("rejects a replacement with %s", async (_label, content) => {
    const generate = model([{ sectionId: "1", content }]);
    const source = input([section("1")]);
    const original = JSON.stringify(source);
    await expect(previewScoreImprovements({ generate } as never, tenant, source)).rejects.toMatchObject({ code: "provider_error" });
    expect(JSON.stringify(source)).toBe(original);
  });

  it.each([
    ["missing response sections", undefined],
    ["missing requested section", [{ sectionId: "0", content: "A clearer opening." }]],
    ["duplicate section", [{ sectionId: "0", content: "A clearer opening." }, { sectionId: "0", content: "Another opening." }]],
    ["unknown section", [{ sectionId: "0", content: "A clearer opening." }, { sectionId: "99", content: "Unknown content." }]],
    ["unselected section", [{ sectionId: "0", content: "A clearer opening." }, { sectionId: "3", content: "Contact our team." }]],
    ["malformed section", [{ sectionId: "0", content: "A clearer opening." }, { sectionId: "2", content: 12 }]],
    ["extra section", [{ sectionId: "0", content: "A clearer opening." }, { sectionId: "2", content: "Useful questions." }, { sectionId: "3", content: "Contact our team." }]],
  ])("rejects %s from the model", async (_label, sections) => {
    const generate = model(sections);
    await expect(previewScoreImprovements({ generate } as never, tenant, input([section("0"), section("2")]))).rejects.toMatchObject({ code: "provider_error" });
  });

  it.each([
    ["empty selection", []],
    ["duplicate suggestion IDs", [section("0", "same"), section("2", "same")]],
    ["duplicate sections", [section("0", "first"), section("0", "second")]],
    ["duplicate metadata targets", [titleChange, metadata("metaTitle", "A second replacement title", "second-title")]],
    ["unknown section", [section("99")]],
    ["too many suggestions", Array.from({ length: 9 }, (_, index) => section(String(index)))],
    ["oversized metadata", [metadata("metaTitle", "a".repeat(71))]],
  ] satisfies [string, ScoreImprovementSuggestion[]][])("rejects %s before calling the model", async (_label, suggestions) => {
    const generate = vi.fn();
    await expect(previewScoreImprovements({ generate } as never, tenant, input(suggestions))).rejects.toMatchObject({ code: "validation_failed" });
    expect(generate).not.toHaveBeenCalled();
  });

  it("bounds the final combined article even when each section is within its limit", () => {
    const large = "a".repeat(99990);
    expect(() => composeScoreImprovementPreview(article, [section("0"), section("2"), section("3")], [
      { sectionId: "0", content: large }, { sectionId: "2", content: large }, { sectionId: "3", content: large },
    ])).toThrow(expect.objectContaining({ code: "provider_error" }));
  });

  it.each([
    ["empty selection", []],
    ["duplicate IDs", [section("0", "same"), section("2", "same")]],
    ["duplicate fields", [titleChange, metadata("metaTitle", "Another title for the same field", "second")]],
    ["duplicate sections", [section("0", "first"), section("0", "second")]],
    ["unknown section", [section("99")]],
    ["too many suggestions", Array.from({ length: 9 }, (_, index) => section(String(index)))],
    ["oversized title", [metadata("title", "a".repeat(201))]],
    ["oversized SEO title", [metadata("metaTitle", "a".repeat(71))]],
    ["oversized description", [metadata("metaDescription", "a".repeat(161))]],
    ["empty suggestion ID", [section("0", "")]],
    ["blank suggestion ID", [section("0", "   ")]],
    ["oversized suggestion ID", [section("0", "a".repeat(81))]],
  ] satisfies [string, ScoreImprovementSuggestion[]][])("validates %s at the pure composition boundary too", (_label, suggestions) => {
    expect(() => composeScoreImprovementPreview(article, suggestions, [])).toThrow(expect.objectContaining({ code: "validation_failed" }));
  });

  it("allows improving existing image alt text while preserving its destination", () => {
    const source = { ...article, bodyMarkdown: "A care guide. ![Care](/care-team.jpg)" };
    const after = "A care guide. ![A caregiver discussing routines with a family](/care-team.jpg)";
    const result = composeScoreImprovementPreview(source, [section("0")], [{ sectionId: "0", content: after }]);
    expect(result.patch.bodyMarkdown).toBe(after);
  });

  it("uses bounded trimmed values without changing the selection's IDs or order", () => {
    const suggestions: ScoreImprovementSuggestion[] = [
      { ...metadata("metaTitle", `  ${"a".repeat(70)}  `, "chosen-title"), priority: "low" },
      metadata("metaDescription", "  A useful description of the family's home care questions.  ", "chosen-description"),
    ];
    const original = JSON.stringify(suggestions);
    const result = composeScoreImprovementPreview(article, suggestions, []);

    expect(result.patch.metaTitle).toHaveLength(70);
    expect(result.patch.metaDescription).toBe("A useful description of the family's home care questions.");
    expect(result.changes.map(change => change.suggestionId)).toEqual(["chosen-title", "chosen-description"]);
    expect(JSON.stringify(suggestions)).toBe(original);
  });

  it("does not mutate the original selection, article, facts or measured scores", async () => {
    const source = input([section("0"), titleChange]);
    const original = JSON.stringify(source);
    const generate = model([{ sectionId: "0", content: "Start by discussing the family's home care priorities." }]);
    await previewScoreImprovements({ generate } as never, tenant, source);
    expect(JSON.stringify(source)).toBe(original);
  });

  it("propagates model failure without producing a partial patch or changing source data", async () => {
    const source = input([titleChange, section("0")]);
    const original = JSON.stringify(source);
    const failure = new Error("Provider unavailable");
    const generate = vi.fn().mockRejectedValue(failure);
    await expect(previewScoreImprovements({ generate } as never, tenant, source)).rejects.toBe(failure);
    expect(JSON.stringify(source)).toBe(original);
  });
});
