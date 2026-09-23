import { describe, it, expect } from "vitest";
import { isAllowedCitation } from "./article.js";

/**
 * Which outbound links survive into a published article.
 *
 * A model asked to cite a source will produce a confident, plausible URL that
 * often 404s — and a dead link in published content is worse than no link,
 * because it looks like sloppiness to a reader and to a crawler. So the set of
 * citable domains is fixed and everything else is dropped.
 *
 * The host check is the part worth pinning: matching by suffix rather than by
 * host boundary would let a lookalike domain through.
 */

describe("allowed citations", () => {
  it("accepts a listed domain", () => {
    expect(isAllowedCitation("https://www.medicaid.gov")).toBe(true);
    expect(isAllowedCitation("https://www.ssa.gov")).toBe(true);
  });

  it("accepts a path on a listed domain", () => {
    expect(isAllowedCitation("https://www.medicaid.gov/medicaid/eligibility")).toBe(true);
  });

  it("accepts a subdomain of a listed domain", () => {
    expect(isAllowedCitation("https://data.medicaid.gov/datasets")).toBe(true);
  });

  it("accepts http as well as https", () => {
    expect(isAllowedCitation("http://www.cdc.gov")).toBe(true);
  });
});

describe("what must be refused", () => {
  it("refuses a lookalike domain that merely ends with an allowed one", () => {
    // The reason the check is host-boundary rather than `endsWith`: a suffix
    // match would accept every one of these.
    expect(isAllowedCitation("https://evil-medicaid.gov")).toBe(false);
    expect(isAllowedCitation("https://notmedicaid.gov")).toBe(false);
  });

  it("refuses an allowed name used as a subdomain of somewhere else", () => {
    expect(isAllowedCitation("https://www.medicaid.gov.attacker.com")).toBe(false);
    expect(isAllowedCitation("https://ssa.gov.phishing.net")).toBe(false);
  });

  it("refuses an arbitrary site", () => {
    expect(isAllowedCitation("https://random-health-blog.com/article")).toBe(false);
    expect(isAllowedCitation("https://en.wikipedia.org/wiki/Medicaid")).toBe(false);
  });

  it("refuses a non-web scheme", () => {
    expect(isAllowedCitation("javascript:alert(1)")).toBe(false);
    expect(isAllowedCitation("data:text/html;base64,PHNjcmlwdD4=")).toBe(false);
    expect(isAllowedCitation("file:///etc/passwd")).toBe(false);
  });

  it("refuses something that is not a URL at all", () => {
    expect(isAllowedCitation("")).toBe(false);
    expect(isAllowedCitation("medicaid.gov")).toBe(false);
    expect(isAllowedCitation("see the Medicaid website")).toBe(false);
  });

  it("ignores case in the host", () => {
    expect(isAllowedCitation("https://WWW.MEDICAID.GOV/eligibility")).toBe(true);
    expect(isAllowedCitation("https://EVIL-MEDICAID.GOV")).toBe(false);
  });
});
