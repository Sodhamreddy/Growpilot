import { describe, expect, it, vi } from "vitest";
import type { GateRunResult } from "@ob/pipeline";
import { improveGeneratedArticleQuality, parseArticle, type GenerateArticleInput } from "./article.js";

const tenant = { workspaceId: "w", userId: "u", role: "owner", correlationId: "c" } as const;
const input: GenerateArticleInput = {
  business: { name: "Care" }, facts: [], evidence: [], voice: null,
  brief: { angle: "Practical planning", audience: "Families", searchIntent: "informational", outline: [{ heading: "Plan", level: 2, guidance: "Explain practical decisions" }],
    mustCoverFacts: [], targetWordCount: 900, ctaGuidance: "Contact Care for details.", internalLinkTargets: [{ url: "https://care.example/services", anchor: "care services" }] },
  primaryKeyword: "home care planning", secondaryKeywords: [], title: "Home care planning for local families",
};
const draftText = (marker: string, extra = "") => `---\nmeta_title: Home care planning for local families\nmeta_description: Home care planning helps families compare practical options, prepare useful questions, and understand what to discuss before making their next decision.\nslug: home-care-planning\n---\n# Home care planning for local families\n\n## Plan\n${marker}\n${"Practical guidance for families. ".repeat(100)}\n${extra}`;
const initial = parseArticle(draftText("Original"), input);
const assessment = (score: number, failure?: "grounding" | "seo"): GateRunResult => ({
  score: { total: score, components: [{ key: "onPage", label: "On-page SEO", weight: 15, score: 60, reasons: ["Improve the description."] }] },
  voiceScore: 90, publishable: !failure, blockingReasons: [],
  gates: [{ gate: "grounding", verdict: failure === "grounding" ? "fail" : "pass", score: 100, findings: [] },
    { gate: "seo", verdict: failure === "seo" ? "fail" : "pass", score: null, findings: [] }],
});
const gateway = (...texts: string[]) => ({ generate: vi.fn().mockImplementation(async () => ({ text: texts.shift() ?? draftText("Revised") })) });

describe("bounded first-draft SEO improvement", () => {
  it("continues above 70 towards the quality target and never caps a better result", async () => {
    const ai = gateway(draftText("First improvement"), draftText("Second improvement"));
    const check = vi.fn().mockResolvedValueOnce(assessment(78)).mockResolvedValueOnce(assessment(94));
    const result = await improveGeneratedArticleQuality(ai as never, tenant, input, initial, assessment(67), check);
    expect(result.assessment.score.total).toBe(94);
    expect(result.targetScore).toBe(85);
    expect(result.attempts).toBe(2);
    expect(result.improved).toBe(true);
  });

  it("stops after two attempts even when the target is unmet", async () => {
    const ai = gateway(draftText("First"), draftText("Second"));
    const check = vi.fn().mockResolvedValueOnce(assessment(74)).mockResolvedValueOnce(assessment(82));
    const result = await improveGeneratedArticleQuality(ai as never, tenant, input, initial, assessment(65), check);
    expect(result.stoppedReason).toBe("attempt_limit");
    expect(result.assessment.score.total).toBe(82);
    expect(ai.generate).toHaveBeenCalledTimes(2);
  });

  it("honors a higher workspace minimum with a buffer", async () => {
    const ai = gateway(draftText("Higher target"));
    const result = await improveGeneratedArticleQuality(ai as never, tenant, input, initial, assessment(89), vi.fn().mockResolvedValue(assessment(98)), 92);
    expect(result.targetScore).toBe(97);
    expect(result.assessment.score.total).toBe(98);
  });

  it("does not spend on an already strong, passing draft", async () => {
    const ai = gateway();
    const result = await improveGeneratedArticleQuality(ai as never, tenant, input, initial, assessment(96), vi.fn());
    expect(result.article).toBe(initial);
    expect(result.attempts).toBe(0);
    expect(ai.generate).not.toHaveBeenCalled();
  });

  it.each([assessment(62), assessment(95, "grounding"), assessment(95, "seo")])("keeps the original when a candidate regresses or fails a gate %#", async (checked) => {
    const result = await improveGeneratedArticleQuality(gateway(draftText("Changed")) as never, tenant, input, initial, assessment(72), vi.fn().mockResolvedValue(checked));
    expect(result.article).toBe(initial);
    expect(result.assessment.score.total).toBe(72);
    expect(result.improved).toBe(false);
  });

  it("rejects invented URLs before paying to assess the candidate", async () => {
    const check = vi.fn();
    const result = await improveGeneratedArticleQuality(gateway(draftText("Changed", "[Invented](https://care.example/made-up)")) as never,
      tenant, input, initial, assessment(65), check);
    expect(result.article).toBe(initial);
    expect(check).not.toHaveBeenCalled();
  });

  it("preserves long-form coverage even when a truncated replacement could score higher", async () => {
    const longDraft = parseArticle(`${draftText("Original")}\n${"Detailed supported guidance. ".repeat(400)}`, input);
    const shorterDraft = draftText("Shortened").replace("Practical guidance for families. ".repeat(100), "Useful guidance. ".repeat(110));
    const candidate = parseArticle(shorterDraft, input);
    expect(candidate.wordCount).toBeGreaterThan(200);
    expect(candidate.wordCount).toBeLessThan(longDraft.wordCount * 0.6);
    const check = vi.fn().mockResolvedValue(assessment(96));
    const result = await improveGeneratedArticleQuality(gateway(shorterDraft) as never, tenant, input, longDraft, assessment(68), check);
    expect(result.article).toBe(longDraft);
    expect(result.assessment.score.total).toBe(68);
    expect(result.improved).toBe(false);
    expect(check).not.toHaveBeenCalled();
  });

  it("allows exact supplied URLs and keeps grounding rules in the rewrite prompt", async () => {
    const ai = gateway(draftText("Changed", "[Care services](https://care.example/services)"));
    const result = await improveGeneratedArticleQuality(ai as never, tenant, input, initial, assessment(65), vi.fn().mockResolvedValue(assessment(89)));
    expect(result.improved).toBe(true);
    expect(ai.generate.mock.calls[0]![1].system).toContain("invent links");
    expect(ai.generate.mock.calls[0]![1].system).toContain("Preserve the topic, editorial requirements");
  });

  it("preserves the best assessed draft if a later provider call fails", async () => {
    const ai = gateway(draftText("First improvement"));
    ai.generate.mockResolvedValueOnce({ text: draftText("First improvement") }).mockRejectedValueOnce(new Error("Unavailable"));
    const result = await improveGeneratedArticleQuality(ai as never, tenant, input, initial, assessment(65), vi.fn().mockResolvedValue(assessment(79)));
    expect(result.assessment.score.total).toBe(79);
    expect(result.article.bodyMarkdown).toContain("First improvement");
    expect(result.stoppedReason).toBe("unavailable");
  });
});
