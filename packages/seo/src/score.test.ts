import { describe, it, expect } from "vitest";
import { scoreArticle, SCORE_WEIGHTS, type ScoreInput } from "./score.js";

function input(overrides: Partial<ScoreInput> = {}): ScoreInput {
  return {
    title: "A complete guide to dental implants in Hyderabad",
    metaDescription:
      "Everything you need to know about dental implants in Hyderabad: the procedure, recovery time, costs and how to choose a clinic you can trust today.",
    // A realistic body: the primary keyword appears a handful of times across
    // ~1200 words, which is a healthy density rather than an absent or
    // stuffed one.
    bodyMarkdown: [
      "## What implants are",
      `Dental implants replace a missing tooth root with a titanium post. ${"The post fuses with the jawbone over several months. ".repeat(100)}`,
      "## The procedure",
      `Fitting dental implants takes two appointments. ${"Your dentist will check the site and plan the placement. ".repeat(100)}`,
      "## Costs",
      "Book a consultation to discuss dental implants and what they would cost for you.",
    ].join("\n\n"),
    primaryKeyword: "dental implants",
    secondaryKeywords: ["implant cost", "recovery"],
    headings: [
      { level: 1, text: "A complete guide to dental implants" },
      { level: 2, text: "What implants are" },
      { level: 2, text: "The procedure" },
      { level: 2, text: "Costs" },
    ],
    internalLinks: [
      { url: "/services", anchor: "our implant service" },
      { url: "/about", anchor: "our clinic" },
      { url: "/contact", anchor: "book a consultation" },
    ],
    externalLinks: [{ url: "https://example.org/study", anchor: "a 2024 study" }],
    schemaJsonLd: {
      "@type": "Article",
      headline: "A complete guide",
      datePublished: "2026-01-01",
      author: { "@type": "Person", name: "Dr X" },
    },
    images: [{ src: "/a.png", alt: "An implant diagram" }],
    hasCta: true,
    ctaText: "Book a consultation",
    ...overrides,
  };
}

describe("scoreArticle", () => {
  it("uses exactly the weights from spec §7.1, summing to 100", () => {
    const total = Object.values(SCORE_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBe(100);
    expect(SCORE_WEIGHTS).toEqual({
      technical: 20,
      contentQuality: 25,
      onPage: 15,
      internalLinking: 10,
      schema: 10,
      authority: 10,
      conversion: 10,
    });
  });

  it("returns a total between 0 and 100", () => {
    const { total } = scoreArticle(input());
    expect(total).toBeGreaterThanOrEqual(0);
    expect(total).toBeLessThanOrEqual(100);
  });

  it("reports every component with its weight and reasons", () => {
    const { components } = scoreArticle(input());
    expect(components).toHaveLength(7);
    for (const c of components) {
      expect(c.reasons.length).toBeGreaterThan(0);
      expect(c.weight).toBe(SCORE_WEIGHTS[c.key]);
      expect(c.score).toBeGreaterThanOrEqual(0);
      expect(c.score).toBeLessThanOrEqual(100);
    }
  });

  it("computes the total as the weighted sum of its components", () => {
    const { total, components } = scoreArticle(input());
    const expected = components.reduce((sum, c) => sum + (c.score * c.weight) / 100, 0);
    expect(total).toBeCloseTo(Math.round(expected * 10) / 10, 1);
  });

  it("scores a good article above a thin one", () => {
    const good = scoreArticle(input()).total;
    const thin = scoreArticle(
      input({
        bodyMarkdown: "Short.",
        headings: [],
        internalLinks: [],
        externalLinks: [],
        schemaJsonLd: null,
        hasCta: false,
        metaDescription: null,
      }),
    ).total;
    expect(good).toBeGreaterThan(thin);
    expect(thin).toBeLessThan(40);
  });

  it("caps content quality at 50 when the semantic pass has not run, and says so", () => {
    const c = scoreArticle(input()).components.find((x) => x.key === "contentQuality")!;
    expect(c.score).toBeLessThanOrEqual(50);
    expect(c.reasons.join(" ")).toMatch(/capped at 50/);
  });

  it("raises content quality once semantic scores are supplied", () => {
    const without = scoreArticle(input()).components.find((c) => c.key === "contentQuality")!.score;
    const with_ = scoreArticle(
      input({ semantic: { intentAlignment: 90, topicalDepth: 85, originality: 80 } }),
    ).components.find((c) => c.key === "contentQuality")!.score;
    expect(with_).toBeGreaterThan(without);
  });

  it("penalises keyword stuffing rather than rewarding it", () => {
    const normal = scoreArticle(input()).components.find((c) => c.key === "onPage")!.score;
    const stuffed = scoreArticle(
      input({ bodyMarkdown: "dental implants ".repeat(300) }),
    ).components.find((c) => c.key === "onPage")!.score;
    expect(stuffed).toBeLessThan(normal);
  });

  it("zeroes internal linking for an orphaned article and explains why", () => {
    const c = scoreArticle(input({ internalLinks: [] })).components.find((x) => x.key === "internalLinking")!;
    expect(c.score).toBe(0);
    expect(c.reasons.join(" ")).toMatch(/orphaned/);
  });

  it("penalises generic anchor text", () => {
    const good = scoreArticle(input()).components.find((c) => c.key === "internalLinking")!.score;
    const generic = scoreArticle(
      input({
        internalLinks: [
          { url: "/a", anchor: "click here" },
          { url: "/b", anchor: "read more" },
          { url: "/c", anchor: "learn more" },
        ],
      }),
    ).components.find((c) => c.key === "internalLinking")!.score;
    expect(generic).toBeLessThan(good);
  });

  it("zeroes schema when none is present", () => {
    expect(
      scoreArticle(input({ schemaJsonLd: null })).components.find((c) => c.key === "schema")!.score,
    ).toBe(0);
  });

  it("flags missing required Article properties", () => {
    const c = scoreArticle(
      input({ schemaJsonLd: { "@type": "Article", headline: "x" } }),
    ).components.find((x) => x.key === "schema")!;
    expect(c.reasons.join(" ")).toMatch(/missing: datePublished, author/);
  });

  it("zeroes conversion with no CTA", () => {
    const c = scoreArticle(input({ hasCta: false })).components.find((x) => x.key === "conversion")!;
    expect(c.score).toBe(0);
    expect(c.reasons.join(" ")).toMatch(/cannot convert/);
  });

  it("reflects the grounded-claim ratio in authority", () => {
    const low = scoreArticle(input({ groundedClaimRatio: 0.2 })).components.find((c) => c.key === "authority")!.score;
    const high = scoreArticle(input({ groundedClaimRatio: 1 })).components.find((c) => c.key === "authority")!.score;
    expect(high).toBeGreaterThan(low);
  });

  it("penalises technical blockers", () => {
    const c = scoreArticle(
      input({ technical: { https: false, indexable: false } }),
    ).components.find((x) => x.key === "technical")!;
    expect(c.score).toBeLessThan(30);
    expect(c.reasons.join(" ")).toMatch(/noindex/);
  });

  it("is deterministic", () => {
    expect(scoreArticle(input())).toEqual(scoreArticle(input()));
  });
});
