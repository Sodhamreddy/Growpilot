import { describe, it, expect } from "vitest";
import {
  starterInstructions, fillMissingInstructions, type InstructionSource,
} from "./instructions.js";

/**
 * Instructions written from a client's own profile.
 *
 * What these pin down, in order of how much damage the failure does:
 *
 *  - Nothing is invented. A missing field drops its sentence. The failure this
 *    prevents is instructions that confidently describe a business that does
 *    not exist, which a person then approves because it reads plausibly.
 *  - A customer's own edit is never overwritten, however much richer the
 *    profile has since become.
 *  - The text is specific to this client. Generic instructions are no better
 *    than the empty box they replaced.
 */

const homecare: InstructionSource = {
  name: "Assured Home Nursing",
  industry: "Home Health Care",
  audience: "Adult children arranging care for an ageing parent",
  description: "A nurse-led home care agency serving the Kansas City metro.",
  usp: "Every care plan is written by a registered nurse",
  primaryCta: "Call for a free in-home assessment",
  services: ["Personal care", "Companion care", "24 hour care", "Respite care"],
  locations: ["Kansas City", "Overland Park"],
};

const bare: InstructionSource = {
  name: "Someone's Business",
  industry: null, audience: null, description: null, usp: null, primaryCta: null,
  services: [], locations: [],
};

describe("using what the profile has", () => {
  it("writes the audience into the blog topic instructions", () => {
    const p = starterInstructions(homecare);
    expect(p.blog!.topics).toContain("Adult children arranging care for an ageing parent");
  });

  it("names the services the topics should be anchored in", () => {
    const p = starterInstructions(homecare);
    expect(p.blog!.topics).toContain("Personal care");
    expect(p.blog!.topics).toContain("Respite care");
  });

  it("uses the call to action as the article's closing step", () => {
    expect(starterInstructions(homecare).blog!.article)
      .toContain("Call for a free in-home assessment");
  });

  it("carries the USP into the article instructions", () => {
    expect(starterInstructions(homecare).blog!.article)
      .toContain("Every care plan is written by a registered nurse");
  });

  it("fills all five generated boxes", () => {
    const p = starterInstructions(homecare);
    for (const text of [p.blog!.topics, p.blog!.article,
                        p.social!.topics, p.social!.post, p.social!.image]) {
      expect(text!.length).toBeGreaterThan(80);
    }
  });

  it("leaves reference empty, for a real example the customer supplies", () => {
    // Generating a fake article to imitate makes output worse while looking
    // like the box was done.
    const p = starterInstructions(homecare);
    expect(p.blog!.reference).toBeUndefined();
    expect(p.social!.reference).toBeUndefined();
  });
});

describe("what happens when the profile is thin", () => {
  it("still produces usable instructions for every box", () => {
    const p = starterInstructions(bare);
    for (const text of [p.blog!.topics, p.blog!.article,
                        p.social!.topics, p.social!.post, p.social!.image]) {
      expect(text!.length).toBeGreaterThan(80);
    }
  });

  it("never invents a fact to fill a gap", () => {
    /*
     * The dangerous failure. Instructions that describe services, an audience
     * or a differentiator the business never claimed get approved because they
     * read plausibly, and every article afterwards is built on them.
     */
    const all = Object.values(starterInstructions(bare).blog!)
      .concat(Object.values(starterInstructions(bare).social!) as string[])
      .join("\n");
    for (const invented of [
      "undefined", "null", "Personal care", "Kansas City",
      "registered nurse", "free in-home assessment",
    ]) {
      expect(all, invented).not.toContain(invented);
    }
  });

  it("drops the sentence rather than leaving a dangling phrase", () => {
    const topics = starterInstructions(bare).blog!.topics!;
    // "Lean towards:" and "Avoid:" are headers and legitimately end in a
    // colon; what must not survive is a sentence whose value went missing.
    expect(topics).not.toContain("Anchor topics in what");
    expect(topics).not.toMatch(/:\s*$/);
    expect(topics).not.toMatch(/:\s*\n\s*\n/);
  });

  it("uses the business name when there is nothing else", () => {
    expect(starterInstructions(bare).blog!.article).toContain("Someone's Business");
  });

  it("ignores blank strings the same as missing ones", () => {
    const blank = { ...bare, audience: "   ", usp: "", services: ["", "  "] };
    const p = starterInstructions(blank);
    expect(p.blog!.topics).not.toContain("Write for    .");
    expect(p.blog!.article).not.toContain("What sets this business apart");
  });
});

describe("punctuation around extracted values", () => {
  it("does not double a full stop the website already wrote", () => {
    /*
     * Extracted fields come out as the site wrote them, which is sometimes a
     * complete sentence. Kleza's USP ended in a full stop and rendered as
     * "...Human Intelligence.. Let that show", which is the kind of thing a
     * customer reads as the product being sloppy.
     */
    const p = starterInstructions({
      ...homecare,
      usp: "Care plans written by a registered nurse.",
      primaryCta: "Call today.",
      audience: "Families arranging care.",
    });
    const all = [p.blog!.topics, p.blog!.article, p.social!.topics,
                 p.social!.post, p.social!.image].join("\n");
    // Two full stops with a space after, i.e. a sentence ended twice. A bare
    // /\.\./ also catches the deliberate ellipsis in "Tag someone who...".
    expect(all).not.toMatch(/\.\.(?!\.)\s/);
    expect(all).not.toContain("nurse.. ");
  });

  it("still ends the sentence when the value has no full stop", () => {
    expect(starterInstructions(homecare).blog!.article)
      .toContain("Every care plan is written by a registered nurse. Let that show");
  });
});

describe("the industry caution", () => {
  it("warns against medical advice for home care", () => {
    const p = starterInstructions(homecare);
    expect(p.blog!.article).toContain("never give medical advice");
    expect(p.social!.post).toContain("never give medical advice");
  });

  it("warns against dosing advice for a pharmacy", () => {
    const p = starterInstructions({ ...homecare, industry: "Retail Pharmacy" });
    expect(p.blog!.article).toContain("dosing advice");
  });

  it("recognises home care however the site words it", () => {
    for (const industry of ["Senior Home Care", "In-Home Nursing", "Caregiving Agency"]) {
      const p = starterInstructions({ ...homecare, industry });
      expect(p.blog!.article, industry).toContain("medical advice");
    }
  });

  it("adds no caution for a business where it would not apply", () => {
    const p = starterInstructions({ ...homecare, industry: "Digital Marketing" });
    expect(p.blog!.article).not.toContain("medical advice");
  });
});

describe("the house rules survive", () => {
  it("bans em dashes in both article and post instructions", () => {
    const p = starterInstructions(homecare);
    expect(p.blog!.article).toContain("Em dashes");
    expect(p.social!.post).toContain("Em dashes");
  });

  it("does not itself contain an em dash", () => {
    // Instructions that break their own rule teach the model the wrong thing.
    const p = starterInstructions(homecare);
    const all = [
      p.blog!.topics, p.blog!.article, p.social!.topics, p.social!.post, p.social!.image,
    ].join("\n");
    expect(all).not.toContain("—");
  });
});

describe("filling only what is empty", () => {
  it("leaves a customer's own instructions untouched", () => {
    const mine = "Only ever write about respite care. Nothing else.";
    const filled = fillMissingInstructions({ blog: { topics: mine } }, homecare);
    expect(filled.blog!.topics).toBe(mine);
  });

  it("fills the boxes beside the one that was written", () => {
    const filled = fillMissingInstructions({ blog: { topics: "Mine." } }, homecare);
    expect(filled.blog!.article!.length).toBeGreaterThan(80);
    expect(filled.social!.post!.length).toBeGreaterThan(80);
  });

  it("treats a box cleared to whitespace as empty", () => {
    const filled = fillMissingInstructions({ blog: { topics: "   " } }, homecare);
    expect(filled.blog!.topics!.length).toBeGreaterThan(80);
  });

  it("keeps a reference the customer pasted in", () => {
    const article = "Here is an article we liked...";
    const filled = fillMissingInstructions({ blog: { reference: article } }, homecare);
    expect(filled.blog!.reference).toBe(article);
  });

  it("keeps words to avoid", () => {
    const filled = fillMissingInstructions(
      { social: { wordsToAvoid: ["synergy", "leverage"] } }, homecare,
    );
    expect(filled.social!.wordsToAvoid).toEqual(["synergy", "leverage"]);
  });

  it("is safe to run repeatedly", () => {
    // Runs after every crawl, so a second pass must change nothing.
    const once = fillMissingInstructions(null, homecare);
    const twice = fillMissingInstructions(once, homecare);
    expect(twice).toEqual(once);
  });

  it("handles a business with no prompts at all", () => {
    const filled = fillMissingInstructions(undefined, homecare);
    expect(filled.blog!.topics!.length).toBeGreaterThan(80);
  });
});
