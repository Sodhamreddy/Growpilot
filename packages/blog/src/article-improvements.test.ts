import { describe, expect, it, vi } from "vitest";
import { DEFAULT_VOICE_PROFILE } from "@ob/voice";
import { improvementLinkTargets, normalizeScoreImprovements, suggestScoreImprovements, type ScoreImprovementInput, type ScoreImprovementSuggestion } from "./improvements.js";
import { composeScoreImprovementPreview, previewScoreImprovements } from "./improvement-preview.js";

const tenant = { workspaceId: "workspace", userId: "editor", role: "editor", correlationId: "all-checks" } as never;
const input: ScoreImprovementInput = {
  business: { name: "Care Team" }, facts: [{ key: "service", value: "Home care consultations", confidence: 1, verified: true }],
  article: { title: "Home care questions", metaTitle: "Home Care Questions for Families", metaDescription: null,
    bodyMarkdown: "Discuss care needs with your family.\n\n## Options\n\n[Our services](/services) explain the support available.\n\n## Next steps\n\nContact the care team to discuss your priorities." },
  primaryKeyword: "home care questions", currentScore: 90, minimumScore: 70, currentVoiceScore: 40, minimumVoiceScore: 80,
  voice: { profile: DEFAULT_VOICE_PROFILE, bannedTerms: ["guaranteed"], preferredTerms: [{ use: "consultation", insteadOf: "sales call" }], samples: [] },
  evidence: [{ sourceUrl: "https://care.example/about", heading: "Our service", content: "Care Team offers home care consultations." }],
  gates: [{ gate: "brand", verdict: "fail", findings: [{ severity: "error", message: "Banned term appears in the copy." }] },
    { gate: "grounding", verdict: "fail", findings: [{ severity: "error", message: "A business claim lacks support." }] }], scoreComponents: [],
};
const whole: ScoreImprovementSuggestion = { id: "whole", target: "article", title: "Improve the complete article",
  reason: "Address voice, unsupported claims and readability together.", priority: "high",
  instruction: "Remove unsupported guarantees, follow the approved voice, improve readability and retain supported advice.", checks: ["brand", "facts", "readability", "seo", "conversion"] };

describe("complete article improvement planning", () => {
  it("uses voice rules, evidence, all findings and separate thresholds even when SEO is already high", async () => {
    const generate = vi.fn().mockResolvedValue({ parsed: { summary: "Improve factual support and brand style.", suggestions: [whole], followUps: [] } });
    const plan = await suggestScoreImprovements({ generate } as never, tenant, input);
    const request = generate.mock.calls[0]![1];
    expect(request.system).toContain("Review ALL quality areas");
    expect(request.system).toContain("guaranteed"); expect(request.system).toContain("sales call");
    expect(request.system).toContain("Care Team offers home care consultations.");
    expect(request.system).toContain('"measuredSeoScore":90'); expect(request.system).toContain('"measuredBrandVoiceScore":40');
    expect(request.system).toContain('"requiredVoiceMinimum":80'); expect(request.system).toContain("A business claim lacks support.");
    expect(plan.suggestions[0]).toMatchObject({ target: "article", checks: whole.checks });
  });
  it("reports missing brand setup explicitly even when the model omits that follow-up", () => {
    const plan = normalizeScoreImprovements({ summary: "Improve clarity.", suggestions: [whole] }, { ...input, voice: null });
    expect(plan.followUps).toContainEqual(expect.objectContaining({ area: "brand", message: expect.stringContaining("No approved brand voice") }));
    expect(plan.followUps?.[0]?.action).toContain("cannot approve");
  });
  it("keeps a whole-article action and metadata while dropping overlapping sections", () => {
    const plan = normalizeScoreImprovements({ summary: "Review all findings.", suggestions: [whole,
      { ...whole, target: "section", sectionId: "0", instruction: "Clarify the opening." },
      { title: "Add a description", reason: "A summary is missing.", priority: "high", target: "metaDescription", value: "Questions to discuss with the home care team." }] }, input);
    expect(plan.suggestions.map(suggestion => suggestion.target)).toEqual(["article", "metaDescription"]);
  });
  it("allows removing an unsupported guarantee but does not introduce one into metadata", () => {
    const plan = normalizeScoreImprovements({ suggestions: [whole,
      { title: "Promise results", reason: "This sounds confident.", priority: "high", target: "metaDescription", value: "We guarantee the best care results." }] }, input);
    expect(plan.suggestions).toHaveLength(1); expect(plan.suggestions[0]?.target).toBe("article");
  });
  it("preserves actionable manual follow-ups and rejects threshold bypasses", () => {
    const plan = normalizeScoreImprovements({ suggestions: [], followUps: [
      { area: "publishing", message: "Structured data is missing.", action: "Configure Article structured data on the publishing site." },
      { area: "publishing", message: "Cannot pass checks.", action: "Lower the minimum score threshold to 50." },
      { area: "unknown", message: "Unknown task", action: "Do something." },
    ] }, input);
    expect(plan.followUps).toEqual([{ area: "publishing", message: "Structured data is missing.", action: "Configure Article structured data on the publishing site." }]);
  });
  it("offers only valid source destinations from verified facts or retrieved evidence", () => {
    const targets = improvementLinkTargets({ facts: [
      { key: "approved", value: "Service", confidence: 1, verified: true, sourceUrl: "https://care.example/services" },
      { key: "unverified", value: "Claim", confidence: .1, verified: false, sourceUrl: "https://unknown.example" },
      { key: "unsafe", value: "Claim", confidence: 1, verified: true, sourceUrl: "javascript:alert(1)" },
    ], evidence: input.evidence });
    expect(targets.map(target => target.url)).toEqual(["https://care.example/services", "https://care.example/about"]);
  });
});

describe("complete article improvement previews", () => {
  const improved = `${input.article.bodyMarkdown.replace("## Options", "## Choose suitable care options")}\n\n## Questions to discuss\n\nWrite down the family's priorities and ask the team about the available support.`;
  it("prepares the complete body and metadata in one request using approved voice and evidence", async () => {
    const generate = vi.fn().mockResolvedValue({ parsed: { sections: [{ sectionId: "article", content: improved }] } });
    const metadata: ScoreImprovementSuggestion = { id: "description", target: "metaDescription", title: "Clarify the summary", reason: "Describe the article clearly.", priority: "high", value: "Home care questions for families to discuss with the care team." };
    const result = await previewScoreImprovements({ generate } as never, tenant, { ...input, voice: input.voice!, suggestions: [whole, metadata] });
    expect(generate).toHaveBeenCalledOnce();
    expect(generate.mock.calls[0]![1].system).toContain("approved brand voice");
    expect(generate.mock.calls[0]![1].system).toContain("Care Team offers home care consultations.");
    expect(result.patch).toEqual({ bodyMarkdown: improved, metaDescription: metadata.value });
    expect(result.changes.map(change => change.target)).toEqual(["article", "metaDescription"]);
  });
  it("rejects overlapping full-body and positional section changes", () => {
    const section: ScoreImprovementSuggestion = { ...whole, id: "section", target: "section", sectionId: "0" };
    expect(() => composeScoreImprovementPreview(input.article, [whole, section], [{ sectionId: "article", content: improved }])).toThrow();
  });
  it("can add an exact evidence-backed citation while preserving existing destinations", async () => {
    const content = `${improved}\n\nRead about [our care team](https://care.example/about).`;
    const action = { ...whole, instruction: "Add a relevant source link to support the existing service description and improve clarity." };
    const generate = vi.fn().mockResolvedValue({ parsed: { sections: [{ sectionId: "article", content }] } });
    const result = await previewScoreImprovements({ generate } as never, tenant, { ...input, voice: input.voice!, suggestions: [action] });
    expect(result.patch.bodyMarkdown).toContain("[our care team](https://care.example/about)");
    expect(generate.mock.calls[0]![1].system).toContain("verifiedLinkTargets");
  });
  it("rejects a short summary in place of a long article", () => {
    const article = { ...input.article, bodyMarkdown: "Detailed practical explanation. ".repeat(500) };
    expect(() => composeScoreImprovementPreview(article, [whole], [{ sectionId: "article", content: "Summary with no useful detail. ".repeat(50) }])).toThrow();
  });
  it.each([`${improved}\n\n[Invented proof](https://unverified.example)`, `${improved}\n\n# Duplicate article title`, `${improved}\n\n<script>alert(1)</script>`])(
    "rejects unsafe or unverified whole-article output %#", content => {
      expect(() => composeScoreImprovementPreview(input.article, [whole], [{ sectionId: "article", content }])).toThrow();
    },
  );
});
