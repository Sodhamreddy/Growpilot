import { describe, it, expect, vi } from "vitest";
import {
  describeGoogleError, placeReviews, listGbpReviews, listGbpLocations, replyToGbpReview, searchPlaces,
} from "./google.js";
import { humanReplyReason, firstName, normaliseReply, draftReviewReply } from "./reply.js";

/**
 * Reviews: what Google sends, what it means when it refuses, and which
 * reviews never get a generated reply.
 */

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("reading reviews from Google", () => {
  it("reads a listing's totals and latest reviews from Places, in the reviewer's own words", async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://places.googleapis.com/v1/places/abc");
      expect(new Headers(init?.headers).get("X-Goog-FieldMask")).toContain("reviews");
      return json({
        id: "abc", displayName: { text: "Assured Home Nursing" }, rating: 4.8, userRatingCount: 57,
        googleMapsUri: "https://maps.google.com/?cid=1",
        reviews: [{
          name: "places/abc/reviews/r1", rating: 5,
          text: { text: "Very caring nurses", languageCode: "en" },
          originalText: { text: "बहुत अच्छी देखभाल", languageCode: "hi" },
          authorAttribution: { displayName: "Priya Raman", uri: "https://g/u/1", photoUri: "https://g/p/1" },
          publishTime: "2026-09-20T10:00:00Z", googleMapsUri: "https://maps.google.com/r1",
        }],
      });
    });
    const { place, reviews } = await placeReviews("key", "abc", fetcher as never);
    expect(place).toMatchObject({ title: "Assured Home Nursing", rating: 4.8, reviewCount: 57 });
    expect(reviews[0]).toMatchObject({
      externalId: "places/abc/reviews/r1", rating: 5, comment: "बहुत अच्छी देखभाल", languageCode: "hi",
      authorName: "Priya Raman", reviewUrl: "https://maps.google.com/r1", googleReply: null,
    });
  });

  it("finds listings by name for a person to choose from", async () => {
    const fetcher = vi.fn(async () => json({ places: [{ id: "p1", displayName: { text: "Kleza" }, formattedAddress: "Hyderabad" }] }));
    expect(await searchPlaces("key", "Kleza Hyderabad", fetcher as never)).toEqual([
      { placeId: "p1", title: "Kleza", address: "Hyderabad", mapsUri: null, rating: null, reviewCount: null },
    ]);
  });

  it("reads every Business Profile review, page by page, with the replies", async () => {
    const pages = [
      { reviews: [{ name: "accounts/1/locations/2/reviews/a", starRating: "TWO", comment: "Late", createTime: "2026-09-01T00:00:00Z", updateTime: "2026-09-01T00:00:00Z", reviewer: { displayName: "Sam" } }], averageRating: 4.1, totalReviewCount: 2, nextPageToken: "n" },
      { reviews: [{ name: "accounts/1/locations/2/reviews/b", starRating: "FIVE", createTime: "2026-08-01T00:00:00Z", reviewer: { isAnonymous: true }, reviewReply: { comment: "Thanks!", updateTime: "2026-08-02T00:00:00Z" } }] },
    ];
    const fetcher = vi.fn(async (url: string) => {
      expect(url).toContain("/v4/accounts/1/locations/2/reviews");
      return json(pages[new URL(url).searchParams.get("pageToken") ? 1 : 0]);
    });
    const res = await listGbpReviews("t", "accounts/1/locations/2", { fetcher: fetcher as never });
    expect(res.totalReviewCount).toBe(2);
    expect(res.reviews.map((r) => [r.rating, r.authorName, r.googleReply?.comment ?? null])).toEqual([
      [2, "Sam", null], [5, "A Google user", "Thanks!"],
    ]);
  });

  it("names listings by account, as the reviews API needs them", async () => {
    const fetcher = vi.fn(async (url: string) => url.includes("/v1/accounts?")
      ? json({ accounts: [{ name: "accounts/1" }] })
      : json({ locations: [{ name: "locations/2", title: "Kleza", metadata: { placeId: "p1" } }] }));
    expect(await listGbpLocations("t", fetcher as never)).toEqual([
      { name: "accounts/1/locations/2", title: "Kleza", address: null, placeId: "p1", mapsUri: null },
    ]);
  });

  it("posts a reply to the review's own reply resource", async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://mybusiness.googleapis.com/v4/accounts/1/locations/2/reviews/a/reply");
      expect(init?.method).toBe("PUT");
      return json({ comment: "Thank you, Sam.", updateTime: "2026-09-30T00:00:00Z" });
    });
    expect(await replyToGbpReview("t", "accounts/1/locations/2/reviews/a", "Thank you, Sam.", fetcher as never))
      .toEqual({ comment: "Thank you, Sam.", updatedAt: "2026-09-30T00:00:00Z" });
  });
});

describe("what Google's refusals mean", () => {
  it("recognises a project Google has not approved for Business Profile yet", () => {
    const e = describeGoogleError(429, {
      error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded for quota metric 'Requests'",
        details: [{ reason: "RATE_LIMIT_EXCEEDED", metadata: { quota_limit_value: "0" } }] },
    }, "gbp");
    expect(e.kind).toBe("access_pending");
    expect(e.permanent).toBe(true);
    // The same status with real quota is only a rate limit, and is retried.
    expect(describeGoogleError(429, { error: { status: "RESOURCE_EXHAUSTED", message: "Too many" } }, "gbp").kind).toBe("rate");
  });

  it("says which switch to turn on", () => {
    const off = { error: { status: "PERMISSION_DENIED", message: "Places API (New) has not been used in project 1 before or it is disabled.", details: [{ reason: "SERVICE_DISABLED" }] } };
    expect(describeGoogleError(403, off, "places").message).toMatch(/Places API \(New\) is not turned on/);
    expect(describeGoogleError(403, { error: { message: "This API method requires billing to be enabled." } }, "places").kind).toBe("billing");
    expect(describeGoogleError(400, { error: { message: "API key not valid. Please pass a valid API key." } }, "places").kind).toBe("key");
    expect(describeGoogleError(400, { error: "invalid_grant" }, "oauth").message).toMatch(/Connect Google again/);
    // An AI Studio key reaches Gemini only.
    expect(describeGoogleError(401, { error: { status: "UNAUTHENTICATED", message: "API keys are not supported by this API.", details: [{ reason: "CREDENTIALS_MISSING" }] } }, "places").message)
      .toMatch(/starts with AIza/);
  });
});

describe("which reviews a person must answer", () => {
  it("withholds replies to legal threats, injuries and one-star complaints", () => {
    expect(humanReplyReason("I will contact my lawyer about this", 2)).toMatch(/legal action/);
    expect(humanReplyReason("The nurse left and my father was injured", 3)).toMatch(/injury/);
    expect(humanReplyReason("Rude and slow.", 1)).toMatch(/One-star/);
  });

  it("drafts the rest, including a one-star rating with no words", () => {
    expect(humanReplyReason("Lovely team, very kind", 5)).toBeNull();
    expect(humanReplyReason(null, 1)).toBeNull();
  });

  it("does not call the model for a review a person must answer", async () => {
    const gateway = { generate: vi.fn() };
    const draft = await draftReviewReply(gateway as never, {} as never, {
      business: { name: "X", industry: null, audience: null, usp: null }, listingName: "X", facts: [], contact: null,
      voice: null, wordsToAvoid: [], review: { authorName: "Sam", rating: 1, comment: "Terrible, never again", languageCode: null },
    });
    expect(gateway.generate).not.toHaveBeenCalled();
    expect(draft).toMatchObject({ body: "", requiresHumanEdit: true });
  });

  it("uses a real first name only", () => {
    expect(firstName("Priya Raman")).toBe("Priya");
    expect(firstName("A Google user")).toBeNull();
    expect(firstName("xx_99_gamer")).toBeNull();
  });

  it("cleans a reply to what Google accepts", () => {
    expect(normaliseReply("Thank you, Priya — we are glad.\n\n\n\nSee you soon.")).toBe("Thank you, Priya, we are glad.\n\nSee you soon.");
    expect(normaliseReply("x".repeat(5000))).toHaveLength(4096);
  });
});

describe("reading a Google Maps link through the crawler", () => {
  it("accepts Google Maps links only, so the crawler cannot be pointed elsewhere", async () => {
    const { isMapsLink } = await import("./google.js");
    expect(isMapsLink("https://maps.app.goo.gl/AbC123")).toBe(true);
    expect(isMapsLink("https://www.google.com/maps/place/Northside+Dental/@1,2,17z")).toBe(true);
    expect(isMapsLink("https://www.google.co.in/maps/place/X")).toBe(true);
    expect(isMapsLink("https://goo.gl/maps/xyz")).toBe(true);
    expect(isMapsLink("https://www.google.com/search?q=x")).toBe(false);
    expect(isMapsLink("https://evil.example/maps/place")).toBe(false);
    expect(isMapsLink("http://127.0.0.1:8787/maps")).toBe(false);
  });

  it("turns what the crawler read into reviews, owner replies included", async () => {
    const { mapsReviews } = await import("./google.js");
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://crawler/maps/reviews");
      expect(JSON.parse(String(init?.body))).toMatchObject({ url: "https://maps.app.goo.gl/x" });
      return json({ title: "Kleza", rating: 4.8, count: 31, url: "https://www.google.com/maps/place/Kleza", reviews: [
        { id: "abc", author: "Priya", authorUrl: null, photo: null, rating: 5, text: "Great", reply: "Thank you!", publishedAt: "2026-10-01T00:00:00Z" },
      ] });
    });
    const res = await mapsReviews("http://crawler/", "https://maps.app.goo.gl/x", { fetcher: fetcher as never });
    expect(res.place).toMatchObject({ title: "Kleza", rating: 4.8, reviewCount: 31 });
    expect(res.reviews[0]).toMatchObject({ externalId: "maps:abc", rating: 5, comment: "Great", googleReply: { comment: "Thank you!" } });
  });

  it("says plainly when Google blocks the read or the crawler is down", async () => {
    const { mapsReviews } = await import("./google.js");
    const blocked = vi.fn(async () => json({ blocked: true, error: "Google is showing a traffic check." }, 429));
    await expect(mapsReviews("http://c", "https://maps.app.goo.gl/x", { fetcher: blocked as never })).rejects.toMatchObject({ kind: "rate" });
    const down = vi.fn(async () => { throw new TypeError("fetch failed"); });
    await expect(mapsReviews("http://c", "https://maps.app.goo.gl/x", { fetcher: down as never })).rejects.toThrow(/crawler is not running/);
  });
});
