import { describe, expect, it } from "vitest";
import { containsKeyphrase, countKeyphrase, keyphraseWords } from "./keyphrase.js";

const KEYWORD = "payment options in-home senior care ann arbor";

describe("keyphrase matching", () => {
  it("counts a researched keyword written as natural English", () => {
    expect(containsKeyphrase("Payment Options for In-Home Senior Care in Ann Arbor", KEYWORD)).toBe(true);
    expect(containsKeyphrase("Understanding Payment Options for In-Home Senior Care in Ann Arbor", KEYWORD)).toBe(true);
    expect(containsKeyphrase("Payment Options: In-Home Senior Care in Ann Arbor", KEYWORD)).toBe(true);
  });

  it("still needs every main word, together and in order", () => {
    expect(containsKeyphrase("Payment options for senior care in Ann Arbor", KEYWORD)).toBe(false);
    expect(containsKeyphrase("Ann Arbor senior care: payment options for in-home help", KEYWORD)).toBe(false);
    expect(containsKeyphrase("Payment options and other ways to fund in-home senior care in Ann Arbor", KEYWORD)).toBe(false);
  });

  it("treats simple plurals and possessives alike", () => {
    expect(containsKeyphrase("Michigan's payment option for in-home senior care in Ann Arbor", `michigan ${KEYWORD}`)).toBe(true);
    expect(containsKeyphrase("Michigan's dental implant options", "michigan dental implants option")).toBe(true);
  });

  it("counts each use in body text, ignoring link targets", () => {
    const body = "Families ask about payment options for in-home senior care in Ann Arbor.\n\n" +
      "[Read our guide](https://example.com/payment-options-in-home-senior-care-ann-arbor) to payment options for in-home senior care in Ann Arbor.";
    expect(countKeyphrase(body, KEYWORD)).toBe(2);
  });

  it("falls back to a plain search for a phrase of only small words", () => {
    expect(keyphraseWords("in the")).toEqual([]);
    expect(countKeyphrase("Out and in the open, in the end.", "in the")).toBe(2);
    expect(containsKeyphrase(null, KEYWORD)).toBe(false);
  });
});
