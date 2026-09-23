import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseListing, looksBlocked, listingSearchUrl } from "./scrape.js";

/**
 * Parsing a Google Maps listing.
 *
 * Both fixtures are real responses captured from the live site, not written by
 * hand: `maps-stadium.html` is Stadium Pharmacy's actual place panel, and
 * `blocked.html` is the CAPTCHA page Google served to the headless browser on
 * its first request to Search. Hand-written markup would test my idea of the
 * shape rather than the shape.
 *
 * The failure that matters most here is a confident wrong number. Google's
 * markup is unversioned and will change; when it does, this parser must return
 * null rather than a value it scraped from the wrong element. Most of what
 * follows is about that.
 */

const fixture = (name: string) =>
  readFileSync(join(__dirname, "fixtures", name), "utf8");

describe("a real listing", () => {
  const html = fixture("maps-stadium.html");

  it("reads the rating and review count", () => {
    // Verified against the live listing: 4.5 stars, 47 reviews.
    const stats = parseListing(html);
    expect(stats.rating).toBe(4.5);
    expect(stats.reviewCount).toBe(47);
    expect(stats.blocked).toBe(false);
  });

  it("reads the listing title", () => {
    expect(parseListing(html).title).toContain("Stadium Pharmacy");
  });

  it("strips Google's own suffix from the title", () => {
    // "… - Google Maps" is noise for a name a person is meant to recognise.
    expect(parseListing(html).title).not.toMatch(/Google (Maps|Search)/);
  });
});

describe("not taking a neighbour's numbers", () => {
  it("pairs the rating with its own review count", () => {
    /*
     * The bug this prevents. A Maps page carries the surrounding map, so the
     * page for one pharmacy also contains other businesses' ratings and
     * counts. Reading the first rating and the first count independently
     * reported a 3.2 and an 11 that belonged to a restaurant nearby.
     */
    const html = `
      <div class="review-card">3.2</div><span>11 reviews</span>
      <div class="jANrlb">
        <div class="fontDisplayLarge">4.5</div>
        <button><div><span>47 reviews</span></div></button>
      </div>
      <div class="other">4.3</div><span>3 reviews</span>`;
    const stats = parseListing(html);
    expect(stats.rating).toBe(4.5);
    expect(stats.reviewCount).toBe(47);
  });

  it("does not reach across an arbitrary distance for a count", () => {
    // A rating with no count near it must not borrow one from further down
    // the page; that count belongs to something else.
    const filler = "<div>x</div>".repeat(200);
    const html = `<div class="fontDisplayLarge">4.5</div>${filler}<span>999 reviews</span>`;
    expect(parseListing(html).reviewCount).not.toBe(999);
  });
});

describe("a blocked response", () => {
  const html = fixture("blocked.html");

  it("is recognised rather than parsed", () => {
    /*
     * The dangerous case. A CAPTCHA page is valid HTML that parses cleanly and
     * yields nothing, which is indistinguishable from a business with no
     * reviews unless it is named. Stadium Pharmacy showing "0 reviews" when it
     * has 47 is worse than showing nothing.
     */
    const stats = parseListing(html);
    expect(stats.blocked).toBe(true);
    expect(stats.rating).toBeNull();
    expect(stats.reviewCount).toBeNull();
  });

  it("detects the phrasings Google actually uses", () => {
    expect(looksBlocked("Our systems have detected unusual traffic")).toBe(true);
    expect(looksBlocked('<form id="captcha-form">')).toBe(true);
    expect(looksBlocked("Before you continue to Google")).toBe(true);
    expect(looksBlocked("<div>4.5</div><span>47 reviews</span>")).toBe(false);
  });
});

describe("refusing to guess", () => {
  it("returns nulls when the markup changes shape", () => {
    // What a layout change looks like: everything parses, nothing matches.
    const stats = parseListing("<html><body><div>Some other page</div></body></html>");
    expect(stats.rating).toBeNull();
    expect(stats.reviewCount).toBeNull();
    expect(stats.blocked).toBe(false);
  });

  it("rejects a rating outside 0 to 5", () => {
    // The same page carries postal codes and phone numbers. An unbounded
    // decimal match once reported a rating of 64055 from an address.
    expect(parseListing('<div class="fontDisplayLarge">64055</div><span>47 reviews</span>').rating)
      .toBeNull();
  });

  it("handles an empty document", () => {
    expect(parseListing("")).toEqual({
      rating: null, reviewCount: null, title: null, blocked: false,
    });
  });

  it("reads a thousands separator", () => {
    const html = '<div class="fontDisplayLarge">4.2</div><button><span>1,284 reviews</span></button>';
    expect(parseListing(html).reviewCount).toBe(1284);
  });

  it("reads a comma decimal separator", () => {
    // Pinned to en-US, but a redirect can still serve another locale.
    const html = '<div class="fontDisplayLarge">4,5</div><button><span>47 reviews</span></button>';
    expect(parseListing(html).rating).toBe(4.5);
  });

  it("accepts a whole-number rating", () => {
    const html = '<div class="fontDisplayLarge">5</div><button><span>8 reviews</span></button>';
    expect(parseListing(html).rating).toBe(5);
  });

  it("reads a single review without tripping on the singular", () => {
    const html = '<div class="fontDisplayLarge">5</div><button><span>1 review</span></button>';
    expect(parseListing(html).reviewCount).toBe(1);
  });
});

describe("building the lookup URL", () => {
  it("includes the street address, so a chain resolves to one branch", () => {
    const url = listingSearchUrl({
      name: "Stadium Pharmacy",
      streetAddress: "4811 S Arrowhead Dr",
      locality: "Independence",
      region: "MO",
    });
    expect(decodeURIComponent(url)).toContain("4811 S Arrowhead Dr");
    expect(decodeURIComponent(url)).toContain("Independence");
  });

  it("pins the language and region", () => {
    /*
     * Not cosmetic. An unpinned request can be answered in another language,
     * where "reviews" is a different word, every pattern misses, and the
     * result is nulls that read as a business with no reviews.
     */
    const url = listingSearchUrl({ name: "Kleza" });
    expect(url).toContain("hl=en");
    expect(url).toContain("gl=us");
  });

  it("works with only a name", () => {
    expect(listingSearchUrl({ name: "Kleza" })).toContain("Kleza");
  });

  it("skips blank address parts", () => {
    const url = listingSearchUrl({
      name: "Kleza", streetAddress: "  ", locality: null, region: undefined,
    });
    expect(decodeURIComponent(url)).toMatch(/search\/Kleza\?/);
  });

  it("escapes characters that would break the URL", () => {
    const url = listingSearchUrl({ name: "Tom & Jerry's Pharmacy #2" });
    expect(() => new URL(url)).not.toThrow();
  });
});
