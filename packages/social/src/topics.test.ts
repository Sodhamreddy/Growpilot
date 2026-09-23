import { describe, it, expect, vi } from "vitest";
import { generateCategoryTopics, stripDashes, AUDIENCES, FORMATS, type PoolInput } from "./topics.js";

/**
 * What survives from the model into the topic pool.
 *
 * Two properties carry weight here. The dash rule, because the reference
 * planner treats it as absolute and a model trained on prose full of them will
 * slip however firmly it is told; enforcing it in code rather than only in the
 * prompt is the difference between a rule and a hope. And duplicate rejection,
 * because 144 titles is more than any prompt reliably holds in view.
 */

const ctx = { workspaceId: "w", userId: "u", role: "owner", correlationId: "c" } as never;

const base: PoolInput = {
  business: {
    name: "Assured Home Nursing",
    industry: "Home Health Care",
    audience: "Seniors and their families",
    usp: null,
    description: null,
  },
  facts: [{ key: "service", value: "Dementia care", confidence: 1, verified: true }],
  locations: ["Metro Detroit, Michigan"],
  category: { name: "Alzheimer's & Dementia Care", description: "Memory loss stage by stage." },
  count: 3,
  existingTitles: [],
  wordsToAvoid: [],
  // Pinned so date tests do not drift with the wall clock.
  today: new Date("2026-09-01T00:00:00Z"),
};

const topic = (over: Record<string, unknown> = {}) => ({
  title: "Reading aloud still works when conversation has stopped",
  hook: "In mid-stage dementia the plot stops landing. The voice does not.",
  audience: "Caregiver specific",
  format: "Carousel",
  imageIdea: "Hands holding an open hardback on a lap blanket.",
  occasion: "",
  postDate: "",
  dateRule: "",
  recommended: false,
  recommendedWhy: "",
  ...over,
});

const gatewayReturning = (topics: unknown[], rejected: unknown[] = []) =>
  ({ generate: vi.fn().mockResolvedValue({ parsed: { topics, rejected } }) }) as never;

describe("stripping dashes", () => {
  it("replaces an em dash between words with a comma", () => {
    expect(stripDashes("The voice — not the plot")).toBe("The voice, not the plot");
  });

  it("replaces an en dash the same way", () => {
    expect(stripDashes("ten – fifteen minutes")).toBe("ten, fifteen minutes");
  });

  it("leaves hyphens in compound words alone", () => {
    // The rule is about dashes as punctuation, not hyphens as spelling.
    expect(stripDashes("mid-stage dementia, over-the-shoulder")).toBe(
      "mid-stage dementia, over-the-shoulder",
    );
  });

  it("does not leave a doubled comma behind", () => {
    expect(stripDashes("one, — two")).toBe("one, two");
  });

  it("does not leave a space before punctuation", () => {
    expect(stripDashes("a thought — . next")).toBe("a thought,. next");
  });

  it("leaves clean text untouched", () => {
    const clean = "Pick something they knew before they were twenty-five.";
    expect(stripDashes(clean)).toBe(clean);
  });
});

describe("what reaches the pool", () => {
  it("keeps a well-formed topic", async () => {
    const [t] = await generateCategoryTopics(gatewayReturning([topic()]), ctx, base)
      .then((r) => r.topics);
    expect(t!.title).toContain("Reading aloud");
    expect(t!.audience).toBe("Caregiver specific");
    expect(t!.format).toBe("Carousel");
  });

  it("strips dashes from every field, not just the title", async () => {
    const { topics } = await generateCategoryTopics(
      gatewayReturning([topic({
        title: "The voice — not the plot",
        hook: "It settles someone — and asks nothing of them.",
        imageIdea: "Warm lamp — evening light.",
      })]),
      ctx,
      base,
    );
    expect(topics[0]!.title).not.toMatch(/[—–]/);
    expect(topics[0]!.hook).not.toMatch(/[—–]/);
    expect(topics[0]!.imageIdea).not.toMatch(/[—–]/);
  });

  it("drops a topic already in the pool", async () => {
    const { topics } = await generateCategoryTopics(
      gatewayReturning([topic(), topic({ title: "Something else" })]),
      ctx,
      { ...base, existingTitles: ["Reading aloud still works when conversation has stopped"] },
    );
    expect(topics).toHaveLength(1);
    expect(topics[0]!.title).toBe("Something else");
  });

  it("drops a duplicate within one response", async () => {
    const { topics } = await generateCategoryTopics(
      gatewayReturning([topic(), topic()]),
      ctx,
      base,
    );
    expect(topics).toHaveLength(1);
  });

  it("ignores case when comparing titles", async () => {
    const { topics } = await generateCategoryTopics(
      gatewayReturning([topic({ title: "READING ALOUD STILL WORKS WHEN CONVERSATION HAS STOPPED" })]),
      ctx,
      { ...base, existingTitles: ["Reading aloud still works when conversation has stopped"] },
    );
    expect(topics).toHaveLength(0);
  });

  it("skips a topic with no hook", async () => {
    // A title with nothing behind it cannot be reviewed, which is the whole
    // reason the hook exists.
    const { topics } = await generateCategoryTopics(
      gatewayReturning([topic({ hook: "" }), topic({ title: "Another" })]),
      ctx,
      base,
    );
    expect(topics).toHaveLength(1);
    expect(topics[0]!.title).toBe("Another");
  });

  it("falls back for an audience outside the configured set", async () => {
    const { topics } = await generateCategoryTopics(
      gatewayReturning([topic({ audience: "Martians" })]),
      ctx,
      base,
    );
    expect(AUDIENCES).toContain(topics[0]!.audience);
    expect(topics[0]!.audience).toBe("General");
  });

  it("falls back for a format outside the configured set", async () => {
    const { topics } = await generateCategoryTopics(
      gatewayReturning([topic({ format: "Hologram" })]),
      ctx,
      base,
    );
    expect(FORMATS).toContain(topics[0]!.format);
  });

  it("never returns more than asked for", async () => {
    const many = Array.from({ length: 10 }, (_, i) => topic({ title: `Topic ${i}` }));
    const { topics } = await generateCategoryTopics(gatewayReturning(many), ctx, base);
    expect(topics).toHaveLength(3);
  });

  it("survives a malformed response", async () => {
    for (const bad of [undefined, "not an array", [null, 7]]) {
      const g = { generate: vi.fn().mockResolvedValue({ parsed: { topics: bad } }) } as never;
      expect((await generateCategoryTopics(g, ctx, base)).topics).toEqual([]);
    }
  });
});

describe("rejections are carried through", () => {
  it("returns what the model declined and why", async () => {
    const { rejected } = await generateCategoryTopics(
      gatewayReturning([], [{ topic: "World Dementia Day", reason: "A ribbon, no action." }]),
      ctx,
      base,
    );
    expect(rejected).toEqual([{ topic: "World Dementia Day", reason: "A ribbon, no action." }]);
  });

  it("ignores a malformed rejection rather than failing the run", async () => {
    const { rejected } = await generateCategoryTopics(
      gatewayReturning([], [null, { reason: "no topic named" }, { topic: "Kept", reason: "ok" }]),
      ctx,
      base,
    );
    expect(rejected).toEqual([{ topic: "Kept", reason: "ok" }]);
  });
});

describe("the prompt carries the rules", () => {
  it("forbids dashes and invented figures", async () => {
    const g = gatewayReturning([]);
    await generateCategoryTopics(g, ctx, base);
    const system: string = (g as never as { generate: { mock: { calls: never[][] } } })
      .generate.mock.calls[0]![1]["system"];
    expect(system).toContain("Never use an em dash or an en dash");
    expect(system).toContain("Never invent a statistic");
    expect(system).toContain("seek emergency help");
  });

  it("passes the words the brand does not use", async () => {
    const g = gatewayReturning([]);
    await generateCategoryTopics(g, ctx, { ...base, wordsToAvoid: ["peace of mind", "loved ones"] });
    const system: string = (g as never as { generate: { mock: { calls: never[][] } } })
      .generate.mock.calls[0]![1]["system"];
    expect(system).toContain("peace of mind");
    expect(system).toContain("loved ones");
  });

  it("names the category it is planning for", async () => {
    const g = gatewayReturning([]);
    await generateCategoryTopics(g, ctx, base);
    const system: string = (g as never as { generate: { mock: { calls: never[][] } } })
      .generate.mock.calls[0]![1]["system"];
    expect(system).toContain("Alzheimer's & Dementia Care");
    expect(system).toContain("Memory loss stage by stage.");
  });
});

describe("dates are kept only when they can be checked", () => {
  it("keeps a date that parses and carries its rule", async () => {
    const { topics } = await generateCategoryTopics(
      gatewayReturning([topic({
        occasion: "Labor Day",
        postDate: "2026-09-07",
        dateRule: "1st Monday of September",
      })]),
      ctx,
      base,
    );
    expect(topics[0]!.postDate).toBe("2026-09-07");
    expect(topics[0]!.occasion).toBe("Labor Day");
    expect(topics[0]!.dateRule).toBe("1st Monday of September");
  });

  it("drops a date with no rule behind it", async () => {
    /*
     * The rule is what makes the date checkable. An observance fixed by a
     * rule moves every year, so a bare date is an assertion a reviewer has no
     * way to verify, and a post on the wrong day looks exactly like one on
     * the right day until it publishes.
     */
    const { topics } = await generateCategoryTopics(
      gatewayReturning([topic({ postDate: "2026-09-07", dateRule: "" })]),
      ctx,
      base,
    );
    expect(topics[0]!.postDate).toBeNull();
  });

  it("drops a malformed date", async () => {
    for (const bad of ["Sep 7 2026", "2026-9-7", "next Monday", "2026-13-45"]) {
      const { topics } = await generateCategoryTopics(
        gatewayReturning([topic({ postDate: bad, dateRule: "1st Monday" })]),
        ctx,
        base,
      );
      expect(topics[0]!.postDate, bad).toBeNull();
    }
  });

  it("leaves an evergreen topic undated", async () => {
    const { topics } = await generateCategoryTopics(gatewayReturning([topic()]), ctx, base);
    expect(topics[0]!.postDate).toBeNull();
    expect(topics[0]!.occasion).toBeNull();
  });
});

describe("recommendations", () => {
  it("keeps a recommendation with its reason", async () => {
    const { topics } = await generateCategoryTopics(
      gatewayReturning([topic({ recommended: true, recommendedWhy: "Timely for autumn." })]),
      ctx,
      base,
    );
    expect(topics[0]!.recommended).toBe(true);
    expect(topics[0]!.recommendedWhy).toBe("Timely for autumn.");
  });

  it("drops a reason on a topic that was not recommended", async () => {
    // A reason without a recommendation is noise on the card.
    const { topics } = await generateCategoryTopics(
      gatewayReturning([topic({ recommended: false, recommendedWhy: "Strong." })]),
      ctx,
      base,
    );
    expect(topics[0]!.recommendedWhy).toBeNull();
  });

  it("treats anything other than true as not recommended", async () => {
    for (const bad of ["true", 1, "yes", null]) {
      const { topics } = await generateCategoryTopics(
        gatewayReturning([topic({ recommended: bad })]),
        ctx,
        base,
      );
      expect(topics[0]!.recommended, String(bad)).toBe(false);
    }
  });

  it("strips dashes from the reason too", async () => {
    const { topics } = await generateCategoryTopics(
      gatewayReturning([topic({ recommended: true, recommendedWhy: "Timely — and unusual." })]),
      ctx,
      base,
    );
    expect(topics[0]!.recommendedWhy).not.toMatch(/[—–]/);
  });
});

describe("dates must be in the future", () => {
  it("drops an observance dated in a past year", async () => {
    /*
     * The failure this catches: a model with no clock dates observances from
     * its training data. A probe run in September 2026 returned New Year's Day
     * 2025 and Thanksgiving 2024, which would schedule posts into the past.
     */
    const { topics } = await generateCategoryTopics(
      gatewayReturning([topic({
        occasion: "Thanksgiving",
        postDate: "2024-11-28",
        dateRule: "Fourth Thursday of November",
      })]),
      ctx,
      base,
    );
    expect(topics[0]!.postDate).toBeNull();
  });

  it("keeps a date later this year", async () => {
    const { topics } = await generateCategoryTopics(
      gatewayReturning([topic({
        occasion: "Thanksgiving",
        postDate: "2026-11-26",
        dateRule: "Fourth Thursday of November",
      })]),
      ctx,
      base,
    );
    expect(topics[0]!.postDate).toBe("2026-11-26");
  });

  it("keeps a date next year", async () => {
    // An observance already past this year belongs to next year.
    const { topics } = await generateCategoryTopics(
      gatewayReturning([topic({
        occasion: "New Year's Day",
        postDate: "2027-01-01",
        dateRule: "Always January 1st",
      })]),
      ctx,
      base,
    );
    expect(topics[0]!.postDate).toBe("2027-01-01");
  });

  it("keeps a date landing on today itself", async () => {
    const { topics } = await generateCategoryTopics(
      gatewayReturning([topic({ postDate: "2026-09-01", dateRule: "Always the 1st" })]),
      ctx,
      base,
    );
    expect(topics[0]!.postDate).toBe("2026-09-01");
  });

  it("tells the model what day it is", async () => {
    const g = gatewayReturning([]);
    await generateCategoryTopics(g, ctx, base);
    const system: string = (g as never as { generate: { mock: { calls: never[][] } } })
      .generate.mock.calls[0]![1]["system"];
    expect(system).toContain("TODAY: 2026-09-01");
    expect(system).toContain("must be in the future");
  });
});
