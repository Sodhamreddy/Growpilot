import { describe, it, expect } from "vitest";
import { fitToX, hashtagsIn, X_LIMIT, ensureParagraphs, paragraphCount } from "./text.js";

/**
 * Fitting an X post to 280 characters.
 *
 * The rule that matters: shorter is fine, cut off is not. A post that ends
 * halfway through a sentence reads as broken, which is worse than one that
 * says a little less.
 */

const sentence = (n: number) => `Sentence number ${n} says one clear thing about flossing.`; // 55 chars

describe("breaking a caption into paragraphs", () => {
  const block = (n: number) => Array.from({ length: n }, (_, i) => `Sentence ${i + 1} ends here.`).join(" ");

  it("leaves a caption that already has line breaks alone", () => {
    expect(ensureParagraphs("One.\n\nTwo.")).toBe("One.\n\nTwo.");
  });

  it("splits a block at sentence ends into 4 to 7 even paragraphs", () => {
    expect(paragraphCount(ensureParagraphs(block(6)))).toBe(4);
    expect(paragraphCount(ensureParagraphs(block(10)))).toBe(5);
    expect(paragraphCount(ensureParagraphs(block(20)))).toBe(7);
  });

  it("never rewords: joining the paragraphs gives the original back", () => {
    expect(ensureParagraphs(block(9)).replace(/\n\n/g, " ")).toBe(block(9));
  });

  it("leaves a short block of three sentences or fewer as it is", () => {
    expect(ensureParagraphs(block(3))).toBe(block(3));
  });
});

describe("fitting an X post", () => {
  it("leaves a post that fits alone", () => {
    const post = "Bleeding gums when you start flossing again is normal. Keep going for a week. #GumHealth";
    expect(fitToX(post)).toBe(post);
  });

  it("drops extra hashtags before any words", () => {
    const body = Array.from({ length: 4 }, (_, i) => sentence(i + 1)).join(" "); // 219
    const post = `${body} #GumHealthMatters #FlossingEveryNight #DentalCareTips #OralHealthDaily`; // 290
    expect(post.length).toBeGreaterThan(X_LIMIT);
    const out = fitToX(post);
    expect(out.length).toBeLessThanOrEqual(X_LIMIT);
    expect(out.startsWith(body)).toBe(true);
    expect(hashtagsIn(out)).toEqual(["#GumHealthMatters", "#FlossingEveryNight", "#DentalCareTips"]);
  });

  it("drops whole sentences, never half of one, and keeps a hashtag", () => {
    const body = Array.from({ length: 7 }, (_, i) => sentence(i + 1)).join(" ");
    const out = fitToX(`${body} #GumHealth #FlossingTips`);
    expect(out.length).toBeLessThanOrEqual(X_LIMIT);
    expect(out).toMatch(/\. #GumHealth$/);
    // Every sentence kept is complete.
    for (const kept of out.replace(/ #GumHealth$/, "").split(/(?<=\.)\s+/)) expect(kept).toMatch(/flossing\.$/);
  });

  it("returns the post unchanged rather than cutting a sentence that cannot fit", () => {
    const long = `${"word ".repeat(70).trim()} and it never ends #Tag`;
    expect(fitToX(long)).toBe(long);
  });

  it("collapses line breaks into single spaces", () => {
    expect(fitToX("One line.\nTwo line.  #Tag")).toBe("One line. Two line. #Tag");
  });
});
