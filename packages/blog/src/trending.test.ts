import { describe, it, expect, vi } from "vitest";
import { suggestTrendingTopics, type TrendingInput } from "./trending.js";

/**
 * The normaliser is what stands between a model's output and something a
 * customer is told is true about their business. These pin the claims it is
 * allowed to pass through — particularly locations, which must never be
 * invented: a topic angled at a city the business does not operate in is a
 * hallucination wearing the right JSON shape.
 */

const base: TrendingInput = {
  business: {
    name: "Kleza",
    industry: "Digital Marketing",
    audience: "Growing businesses",
    usp: null,
    description: null,
  },
  facts: [{ key: "service", value: "SEO", confidence: 1, verified: true }],
  services: ["SEO optimisation", "Cloud migration"],
  locations: ["Headquarters, Overland Park", "ODC, Madhapur"],
  existingTitles: [],
  limit: 5,
};

function gatewayReturning(topics: unknown) {
  return {
    generate: vi.fn().mockResolvedValue({ parsed: { topics } }),
  } as never;
}

const ctx = { workspaceId: "w", userId: "u", role: "owner", correlationId: "c" } as never;

const topic = (over: Record<string, unknown> = {}) => ({
  title: "A topic",
  rationale: "Because.",
  primaryKeyword: "a topic",
  intent: "commercial",
  service: "SEO optimisation",
  location: "",
  fit: 0.8,
  ...over,
});

describe("suggestTrendingTopics — prerequisites", () => {
  it("returns nothing and calls no model when there are no services", async () => {
    const gateway = gatewayReturning([topic()]);
    const result = await suggestTrendingTopics(gateway, ctx, { ...base, services: [] });
    expect(result).toEqual([]);
    expect((gateway as unknown as { generate: ReturnType<typeof vi.fn> }).generate)
      .not.toHaveBeenCalled();
  });

  it("asks the model when services exist", async () => {
    const gateway = gatewayReturning([topic()]);
    await suggestTrendingTopics(gateway, ctx, base);
    expect((gateway as unknown as { generate: ReturnType<typeof vi.fn> }).generate)
      .toHaveBeenCalledOnce();
  });
});

describe("suggestTrendingTopics — locations are never invented", () => {
  it("keeps a location the business actually operates in", async () => {
    const gateway = gatewayReturning([topic({ location: "Overland Park" })]);
    const [result] = await suggestTrendingTopics(gateway, ctx, base);
    expect(result!.location).toBe("Overland Park");
  });

  it("drops a location the business has no presence in", async () => {
    const gateway = gatewayReturning([topic({ location: "Singapore" })]);
    const [result] = await suggestTrendingTopics(gateway, ctx, base);
    expect(result!.location).toBe("");
  });

  it("drops every location when the business has none recorded", async () => {
    const gateway = gatewayReturning([topic({ location: "Overland Park" })]);
    const [result] = await suggestTrendingTopics(gateway, ctx, { ...base, locations: [] });
    expect(result!.location).toBe("");
  });
});

describe("suggestTrendingTopics — output hygiene", () => {
  it("does not repeat a title that is already planned", async () => {
    const gateway = gatewayReturning([topic({ title: "Existing piece" }), topic({ title: "Fresh" })]);
    const result = await suggestTrendingTopics(gateway, ctx, {
      ...base,
      existingTitles: ["Existing piece"],
    });
    expect(result.map((t) => t.title)).toEqual(["Fresh"]);
  });

  it("de-duplicates within one response", async () => {
    const gateway = gatewayReturning([topic({ title: "Same" }), topic({ title: "same" })]);
    expect(await suggestTrendingTopics(gateway, ctx, base)).toHaveLength(1);
  });

  it("drops entries with no title rather than shipping a blank row", async () => {
    const gateway = gatewayReturning([topic({ title: "  " }), topic({ title: "Real" })]);
    const result = await suggestTrendingTopics(gateway, ctx, base);
    expect(result.map((t) => t.title)).toEqual(["Real"]);
  });

  it("honours the requested limit even when the model returns more", async () => {
    const gateway = gatewayReturning(
      Array.from({ length: 12 }, (_, i) => topic({ title: `Topic ${i}` })),
    );
    expect(await suggestTrendingTopics(gateway, ctx, { ...base, limit: 3 })).toHaveLength(3);
  });

  it("clamps fit into 0–1 and defaults a missing one", async () => {
    const gateway = gatewayReturning([
      topic({ title: "High", fit: 5 }),
      topic({ title: "Low", fit: -2 }),
      topic({ title: "None", fit: undefined }),
    ]);
    const result = await suggestTrendingTopics(gateway, ctx, base);
    expect(result.map((t) => t.fit)).toEqual([1, 0, 0.5]);
  });

  it("falls back to informational for an unrecognised intent", async () => {
    const gateway = gatewayReturning([topic({ intent: "wishful" })]);
    const [result] = await suggestTrendingTopics(gateway, ctx, base);
    expect(result!.intent).toBe("informational");
  });

  it("falls back to the title when no keyword is given", async () => {
    const gateway = gatewayReturning([topic({ title: "Cloud Costs", primaryKeyword: "" })]);
    const [result] = await suggestTrendingTopics(gateway, ctx, base);
    expect(result!.primaryKeyword).toBe("cloud costs");
  });

  it("returns nothing when the model returns a malformed body", async () => {
    expect(await suggestTrendingTopics(gatewayReturning(undefined), ctx, base)).toEqual([]);
    expect(await suggestTrendingTopics(gatewayReturning("not an array"), ctx, base)).toEqual([]);
    expect(await suggestTrendingTopics(gatewayReturning([null, 7]), ctx, base)).toEqual([]);
  });
});
