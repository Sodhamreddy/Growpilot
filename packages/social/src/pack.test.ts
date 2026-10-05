import { describe, it, expect, vi } from "vitest";
import { writeContentPack, normalisePack, packWarnings, brandTag, overlayText, type PackInput } from "./pack.js";

/**
 * What survives from the model into a content pack.
 *
 * The mechanical rules are enforced in code (dashes, hashtag shape, the brand
 * tag last, slide count) and the rest become warnings. A warning that fails to
 * fire is silent: the post looks finished and gets approved as it is.
 */

const ctx = { workspaceId: "w", userId: "u", role: "owner", correlationId: "c" } as never;

const sentence = "You notice it at the sink on a Tuesday night when the floss finally comes out.";
const caption = Array.from({ length: 12 }, () => sentence).join("\n\n");

const good = {
  caption,
  shortCaption: "Bleeding when you floss again is the gums catching up, not a sign to stop. Give it a week of gentle nightly flossing first. #GumHealth",
  hashtags: ["#FlossingTips", "#GumHealth", "#FamilyDentist", "#WorkingAdults", "#OralCare", "#DentalHabits", "#CityDental"],
  imageBrief: "A bathroom sink at night, a hand holding floss, warm light. ".repeat(8),
  altText: "A hand holding dental floss over a white bathroom sink in warm evening light at home.",
  formatExtra: "",
};

const input: PackInput = {
  business: { name: "Northside Dental", industry: "Dental clinic", audience: null, usp: null, description: null },
  facts: [{ key: "service", value: "General dentistry", confidence: 1, verified: true }],
  locations: [],
  voice: null,
  post: {
    title: "Why your gums bleed when you start flossing again",
    hook: "Bleeding is the gums catching up.",
    audience: "Working adults",
    format: "Static Image",
    occasion: null,
    date: "2026-10-12",
    imageIdea: "A bathroom sink at night.",
    categoryName: "Everyday Oral Care",
  },
  prompts: { post: "", image: "", reference: "", wordsToAvoid: ["journey"] },
  brandColors: ["#1f6fe8 (primary)"],
};

describe("brand tag", () => {
  it("joins the business name into one tag", () => {
    expect(brandTag("Northside Dental")).toBe("#NorthsideDental");
    expect(brandTag("A&B home-care co.")).toBe("#ABHomeCareCo");
  });
});

describe("normalising a pack", () => {
  it("puts the brand tag last and keeps the list at eight", () => {
    const pack = normalisePack(
      { ...good, hashtags: ["#NorthsideDental", ...good.hashtags, "#Extra1", "#Extra2"] },
      { format: "Static Image", brandName: "Northside Dental" },
    );
    expect(pack.hashtags).toHaveLength(8);
    expect(pack.hashtags.at(-1)).toBe("#NorthsideDental");
    expect(pack.hashtags.filter((t) => t === "#NorthsideDental")).toHaveLength(1);
  });

  it("makes hashtags well formed and removes duplicates", () => {
    const pack = normalisePack(
      { ...good, hashtags: ["gum health", "#GumHealth", "##oral-care"] },
      { format: "Static Image", brandName: "Northside Dental" },
    );
    expect(pack.hashtags).toEqual(["#gumhealth", "#oralcare", "#NorthsideDental"]);
  });

  it("strips dashes from every text field", () => {
    const pack = normalisePack(
      { ...good, caption: "Two minutes — twice a day", shortCaption: "Short – sharp" },
      { format: "Static Image", brandName: "Northside Dental" },
    );
    expect(pack.caption).toBe("Two minutes, twice a day");
    expect(pack.shortCaption).toBe("Short, sharp");
  });

  it("keeps the caption's paragraphs while stripping dashes inside them", () => {
    const pack = normalisePack(
      { ...good, caption: "First — idea.\n\nSecond idea.\n\n\n\nThird idea." },
      { format: "Static Image", brandName: "Northside Dental" },
    );
    expect(pack.caption).toBe("First, idea.\n\nSecond idea.\n\nThird idea.");
  });

  it("keeps the short caption and alt text on one line", () => {
    const pack = normalisePack(
      { ...good, shortCaption: "Line one\nline two", altText: "A sink\nat night." },
      { format: "Static Image", brandName: "Northside Dental" },
    );
    expect(pack.shortCaption).toBe("Line one line two");
    expect(pack.altText).toBe("A sink at night.");
  });

  it("empties formatExtra for a static post and caps a carousel at four slides", () => {
    expect(normalisePack({ ...good, formatExtra: "Slide 1: x" }, { format: "Quote", brandName: "B" }).formatExtra).toBe("");
    const carousel = normalisePack(
      { ...good, formatExtra: "Slide 1 (cover): a\n\nSlide 2: b\nSlide 3: c\nSlide 4: d\nSlide 5: e" },
      { format: "Carousel", brandName: "B" },
    );
    expect(carousel.formatExtra.split("\n")).toEqual(["Slide 1 (cover): a", "Slide 2: b", "Slide 3: c", "Slide 4: d"]);
  });

  it("survives a response with nothing in it", () => {
    const pack = normalisePack(undefined, { format: "Static Image", brandName: "Northside Dental" });
    expect(pack.caption).toBe("");
    expect(pack.hashtags).toEqual(["#NorthsideDental"]);
  });
});

describe("the text on the image", () => {
  it("pulls the headline and subline out of the brief", () => {
    expect(overlayText('Warm kitchen. Brand blue #1f6fe8 band. Cover headline "Ask her what she wants" with subline "Not what she remembers."'))
      .toBe("Ask her what she wants\n\nNot what she remembers.");
  });

  it("accepts curly quotes and a headline on its own", () => {
    expect(overlayText("Cover headline: “Floss tonight”")).toBe("Floss tonight");
  });

  it("is empty when the brief has no overlay copy", () => {
    expect(overlayText("A sink at night.")).toBe("");
  });

  it("is filled in when a pack is normalised", () => {
    const pack = normalisePack(
      { ...good, imageBrief: `${good.imageBrief} Cover headline "Floss tonight" with subline "Bleeding means start."` },
      { format: "Static Image", brandName: "B" },
    );
    expect(pack.imageText).toBe("Floss tonight\n\nBleeding means start.");
  });
});

describe("pack warnings", () => {
  const norm = (over: Record<string, unknown> = {}, format = "Static Image") =>
    normalisePack({ ...good, ...over }, { format, brandName: "Northside Dental" });

  it("passes a pack that meets every measurement", () => {
    expect(packWarnings(norm(), { format: "Static Image", bannedTerms: [] })).toEqual([]);
  });

  it("flags a short caption, an X post over 280 and missing hashtags", () => {
    // One unbroken 300-character "sentence": fitting it would mean cutting it, so it stays and is flagged.
    const warnings = packWarnings(
      norm({ caption: "Too short.", shortCaption: "x".repeat(300), hashtags: ["#One"] }),
      { format: "Static Image", bannedTerms: [] },
    );
    expect(warnings).toEqual(expect.arrayContaining([
      "Caption is 2 words; aim for 120 to 200.",
      "X post is 300 characters with its hashtags; X allows 280.",
      "The X post has no hashtag. End it with one or two.",
      "2 hashtags; the target is exactly 8.",
    ]));
  });

  it("does not flag a caption a word short of an old limit", () => {
    const para = (n: number) => Array.from({ length: n }, () => "word").join(" ");
    const words149 = [para(40), para(40), para(40), para(29)].join("\n\n");
    expect(packWarnings(norm({ caption: words149 }), { format: "Static Image", bannedTerms: [] })).toEqual([]);
  });

  it("breaks a caption that came back as one block into paragraphs", () => {
    const block = Array.from({ length: 10 }, (_, i) => `Sentence ${i + 1} is about gums.`).join(" ");
    const pack = norm({ caption: block });
    expect(pack.caption.split("\n\n")).toHaveLength(5);
    expect(pack.caption.replace(/\n\n/g, " ")).toBe(block);
  });

  it("flags a caption too short to break into paragraphs", () => {
    expect(packWarnings(norm({ caption: `${"word ".repeat(130).trim()}.` }), { format: "Static Image", bannedTerms: [] }))
      .toContain("Caption is one block of text; break it into 4 to 7 short paragraphs.");
  });

  it("fits an X post that runs long without cutting a sentence", () => {
    const long = `${"Floss gently every night this week. ".repeat(9).trim()} #GumHealth #Flossing`;
    const pack = norm({ shortCaption: long });
    expect(pack.shortCaption.length).toBeLessThanOrEqual(280);
    expect(pack.shortCaption).toMatch(/week\. #GumHealth$/);
  });

  it("flags words the brand avoids, ignoring case", () => {
    const warnings = packWarnings(norm({ caption: `${caption}\n\nYour Journey starts here.` }), {
      format: "Static Image", bannedTerms: ["journey"],
    });
    expect(warnings).toContain('Uses words the brand avoids: "journey".');
  });

  it("matches banned words whole, so a colour or a longer word is not flagged", () => {
    const pack = norm({ imageBrief: `${good.imageBrief} Brand blue #1f6fe8 band. A secure latch.` });
    expect(packWarnings(pack, { format: "Static Image", bannedTerms: ["#1", "cure"] })).toEqual([]);
    const claims = norm({ caption: `${caption}\n\nWe are the #1 clinic in town.` });
    expect(packWarnings(claims, { format: "Static Image", bannedTerms: ["#1"] })).toContain('Uses words the brand avoids: "#1".');
  });

  it("flags a carousel without four slides", () => {
    const warnings = packWarnings(norm({ formatExtra: "Slide 1 (cover): a" }, "Carousel"), {
      format: "Carousel", bannedTerms: [],
    });
    expect(warnings).toContain("A carousel needs exactly 4 slides.");
  });
});

describe("writing a pack", () => {
  it("asks for structured JSON and returns the normalised pack with its warnings", async () => {
    const generate = vi.fn().mockResolvedValue({ parsed: { ...good, caption: "Too short." } });
    const result = await writeContentPack({ generate } as never, ctx, input);

    const call = generate.mock.calls[0]![1];
    expect(call.taskAlias).toBe("structured_json");
    expect(call.system).toContain("BRAND TAG: #NorthsideDental");
    expect(call.system).toContain("#1f6fe8 (primary)");
    expect(call.system).toContain("Never use these words: journey");
    expect(result.pack.hashtags.at(-1)).toBe("#NorthsideDental");
    expect(result.warnings[0]).toMatch(/^Caption is 2 words/);
  });
});
