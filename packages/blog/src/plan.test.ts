import { describe, it, expect } from "vitest";
import { buildContentPlan, type ClusterInput } from "./plan.js";

/**
 * The regression these guard: with no keyword data provider every term has a
 * null opportunityScore, and the planner used to substitute one constant for
 * all of them. That made every cluster score identical, so the intent weight
 * became the only thing deciding what got written — and a stray consumer
 * long-tail outranked the business's core commercial terms purely because a
 * model had labelled it "transactional".
 */

const term = (id: string, t: string, relevance: number | null) => ({
  id, term: t, relevance, opportunityScore: null, volume: null,
});

describe("buildContentPlan — ranking without market data", () => {
  it("plans unused keywords below the first twelve results", () => {
    const input: ClusterInput[] = Array.from({ length: 15 }, (_, i) => ({
      id: `c${i}`, label: `term ${i}`, intent: "commercial",
      terms: [{ id: `k${i}`, term: `term ${i}`, opportunityScore: 100 - i, volume: 100 }],
    }));
    const plan = buildContentPlan(input, { limit: 12, excludedKeywordIds: new Set(Array.from({ length: 12 }, (_, i) => `k${i}`)) });
    expect(plan.map(p => p.primaryKeywordId)).toEqual(["k12", "k13", "k14"]);
  });
  const clusters: ClusterInput[] = [
    {
      id: "c1", label: "printer driver update", intent: "transactional",
      terms: [term("k1", "printer driver update", 0.15)],
    },
    {
      id: "c2", label: "digital marketing agency", intent: "commercial",
      terms: [term("k2", "digital marketing agency", 0.95)],
    },
  ];

  it("puts a highly relevant commercial term above a barely relevant transactional one", () => {
    const plan = buildContentPlan(clusters, { limit: 2 });
    expect(plan[0]?.primaryKeywordId).toBe("k2");
  });

  it("does not let the intent label alone decide the order", () => {
    const plan = buildContentPlan(clusters, { limit: 2 });
    const [first, second] = plan;
    expect(first!.priority).toBeGreaterThan(second!.priority);
    expect(first!.intent).toBe("commercial");
  });

  it("still prefers opportunity score when a provider supplies one", () => {
    const withData: ClusterInput[] = [
      {
        id: "c1", label: "a", intent: "commercial",
        terms: [{ id: "k1", term: "a", relevance: 0.1, opportunityScore: 90, volume: 1000 }],
      },
      {
        id: "c2", label: "b", intent: "commercial",
        terms: [{ id: "k2", term: "b", relevance: 0.9, opportunityScore: 20, volume: 10 }],
      },
    ];
    expect(buildContentPlan(withData, { limit: 2 })[0]?.primaryKeywordId).toBe("k1");
  });

  it("leads a cluster with its most relevant term", () => {
    const cluster: ClusterInput[] = [{
      id: "c1", label: "seo", intent: "commercial",
      terms: [term("low", "seo tips", 0.2), term("high", "seo services", 0.9)],
    }];
    expect(buildContentPlan(cluster, { limit: 1 })[0]?.primaryKeywordId).toBe("high");
  });

  it("gives a term with no signal at all a mid-pack score, not a winning one", () => {
    const mixed: ClusterInput[] = [
      { id: "c1", label: "unknown", intent: "commercial", terms: [term("k1", "unknown", null)] },
      { id: "c2", label: "core", intent: "commercial", terms: [term("k2", "core offer", 0.9)] },
    ];
    expect(buildContentPlan(mixed, { limit: 2 })[0]?.primaryKeywordId).toBe("k2");
  });

  it("spreads publish dates at the requested cadence", () => {
    const plan = buildContentPlan(clusters, { limit: 2, cadencePerWeek: 2, startAt: new Date("2026-01-01") });
    const gapDays =
      (plan[1]!.publishDate.getTime() - plan[0]!.publishDate.getTime()) / 86_400_000;
    expect(gapDays).toBeCloseTo(3.5, 1);
  });
});

describe("topic titles", () => {
  const pillar = (t: string, intent: "commercial" | "transactional" | "informational") =>
    buildContentPlan(
      [{ id: "c", label: t, intent, terms: [term("k", t, 0.9)] }],
      { limit: 1 },
    )[0]!.title;

  it("spells industry acronyms the way the industry spells them", () => {
    expect(pillar("seo optimization services", "commercial")).toContain("SEO");
    expect(pillar("voip phone system setup", "commercial")).toContain("VoIP");
    expect(pillar("ppc campaign management", "commercial")).toContain("PPC");
    expect(pillar("social media optimization smo", "commercial")).toContain("SMO");
    expect(pillar("remote it support", "commercial")).toContain("IT");
  });

  it("never renders an acronym as a capitalised word", () => {
    const title = pillar("seo optimization services", "commercial");
    expect(title).not.toMatch(/\bSeo\b/);
    expect(pillar("voip management", "commercial")).not.toMatch(/\bVoip\b/);
  });

  it("is deterministic — the same term always yields the same headline", () => {
    expect(pillar("cloud migration services", "commercial"))
      .toBe(pillar("cloud migration services", "commercial"));
  });

  it("does not put every commercial topic under one formula", () => {
    const terms = [
      "cloud migration services", "email marketing services", "network security",
      "managed it services", "ecommerce development", "lead generation services",
    ];
    const titles = terms.map((t) => pillar(t, "commercial"));
    expect(new Set(titles).size).toBeGreaterThan(1);

    // No single phrasing may account for the whole calendar.
    const guides = titles.filter((t) => t.includes("buyer's guide")).length;
    expect(guides).toBeLessThan(titles.length);
  });

  it("capitalises product names that were lower-cased at seed time", () => {
    expect(pillar("email management for microsoft 365", "commercial")).toContain("Microsoft 365");
    expect(pillar("wordpress website maintenance", "commercial")).toContain("WordPress");
    expect(pillar("mobile app development ios android", "transactional")).toContain("iOS");
  });

  it("leaves a term that is already a question as a question", () => {
    const plan = buildContentPlan(
      [{
        id: "c", label: "seo", intent: "informational",
        terms: [term("h", "seo services", 0.9), term("q", "how does seo work", 0.8),
                term("x", "seo pricing", 0.7)],
      }],
      { limit: 4 },
    );
    const question = plan.find((t) => t.primaryKeywordId === "q");
    expect(question?.title).toBe("How does SEO work?");
  });
});

describe("observed search performance", () => {
  it("boosts observed opportunities modestly without inventing demand", async () => {
    const { searchPerformanceBoost } = await import("./plan.js");
    expect(searchPerformanceBoost(0, 0)).toBe(0);
    expect(searchPerformanceBoost(99, 0)).toBe(0);
    expect(searchPerformanceBoost(1000, 0)).toBeGreaterThan(searchPerformanceBoost(1000, 500));
    expect(searchPerformanceBoost(100000000, 0)).toBeLessThanOrEqual(10);
  });
});
