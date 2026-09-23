import { describe, it, expect, vi } from "vitest";
import {
  describeGraphError, rowsFromInsights, listPages,
  exchangeForLongLivedToken, fetchPageInsights, GraphError,
  fetchRecentPosts, fetchRecentInstagramPosts,
} from "./meta.js";

/**
 * The Meta Graph client.
 *
 * Two things are pinned here, and the second is the one that would cost real
 * money to learn the hard way.
 *
 * The first is normalisation: Graph returns three different shapes for a
 * metric value and this must produce comparable rows from all of them.
 *
 * The second is error classification. Before App Review, a permission refusal
 * is the *normal* response for any account that is not a listed tester. If
 * that is read as "the connection broke", the UI tells a customer to reconnect
 * — sending them round a loop that cannot succeed, repeatedly, for a reason
 * that has nothing to do with them.
 */

const ok = (body: unknown) =>
  vi.fn().mockResolvedValue({ ok: true, json: async () => body } as unknown as Response);

describe("classifying a Graph error", () => {
  it("treats an expired token as recoverable by reconnecting", () => {
    const failure = describeGraphError({ error: { code: 190, message: "Session expired" } });
    expect(failure.permanent).toBe(false);
    expect(failure.message).toMatch(/expired/i);
  });

  it("names a password change, which reads differently to a customer", () => {
    const failure = describeGraphError({ error: { code: 190, error_subcode: 460 } });
    expect(failure.message).toMatch(/password/i);
  });

  it("does not tell someone to reconnect when the app is unreviewed", () => {
    /*
     * The important one. Code 10 and the 200s are permission refusals, which
     * is what Meta returns for every non-tester account until App Review
     * passes. Reconnecting cannot fix it, so the message must not suggest it.
     */
    for (const code of [10, 200, 230, 299]) {
      const failure = describeGraphError({ error: { code } });
      expect(failure.permanent, `code ${code}`).toBe(true);
      expect(failure.message, `code ${code}`).toMatch(/App Review/i);
      expect(failure.message, `code ${code}`).not.toMatch(/reconnect/i);
    }
  });

  it("treats rate limits as temporary", () => {
    // Marking the connection broken over a throttle would make a busy day
    // look like a disconnection.
    for (const code of [4, 17, 32, 613]) {
      const failure = describeGraphError({ error: { code } });
      expect(failure.permanent, `code ${code}`).toBe(false);
      expect(failure.message, `code ${code}`).toMatch(/rate limit/i);
    }
  });

  it("keeps Meta's own words for a malformed request", () => {
    /*
     * Code 100 covers several unrelated causes — a retired metric, a bad
     * token, a missing scope — and only Meta's message distinguishes them.
     * This returned a fixed sentence about retired metrics and dropped that
     * text, so a token exchange failure reported a metrics problem on a call
     * that requests no metrics.
     */
    const failure = describeGraphError({
      error: { code: 100, message: "Invalid OAuth access token - Cannot parse access token" },
    });
    expect(failure.message).toContain("Cannot parse access token");
    // Recoverable: the fix is usually a fresh token, not an app change.
    expect(failure.permanent).toBe(false);
  });

  it("recognises an App token used where a User token is needed", () => {
    /*
     * Graph API Explorer offers App, User and Page tokens and defaults to the
     * app one, which has no "me" — so /me/accounts fails with "nonexisting
     * field (accounts)". Meta's wording gives no hint that the token type is
     * the problem, and this is the most likely mistake when connecting by
     * hand.
     */
    const failure = describeGraphError({
      error: { code: 100, message: "(#100) Tried accessing nonexisting field (accounts) on node type (Application)" },
    });
    expect(failure.message).toMatch(/User Token/i);
    expect(failure.permanent).toBe(true);
  });

  it("names the object-not-found case, which is not really malformed", () => {
    const failure = describeGraphError({ error: { code: 100, error_subcode: 33 } });
    expect(failure.message).toMatch(/could not find that Page/i);
    expect(failure.permanent).toBe(true);
  });

  it("falls back to Meta's own message when the code is unknown", () => {
    expect(describeGraphError({ error: { code: 9999, message: "Something specific" } }).message)
      .toBe("Something specific");
  });

  it("survives a body that is not an error envelope at all", () => {
    expect(() => describeGraphError(null)).not.toThrow();
    expect(() => describeGraphError("gateway timeout")).not.toThrow();
    expect(describeGraphError({}).message).toBe("Meta returned an error.");
  });
});

describe("normalising insight values", () => {
  const dims = { businessId: "b1" };

  it("reads a plain number", () => {
    const rows = rowsFromInsights(
      [{ name: "page_post_engagements", values: [{ value: 1240, end_time: "2026-04-18T07:00:00+0000" }] }],
      "facebook", { page_post_engagements: "reach" }, dims,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metric).toBe("reach");
    expect(rows[0]!.value).toBe(1240);
  });

  it("sums a breakdown object to the period total", () => {
    /*
     * Graph returns some metrics broken down by dimension rather than as a
     * scalar. `Number({...})` is NaN, which then either poisons a chart or is
     * silently dropped depending on where it lands.
     */
    const rows = rowsFromInsights(
      [{ name: "page_impressions", values: [{ value: { organic: 900, paid: 340 }, end_time: "2026-04-18T07:00:00+0000" }] }],
      "facebook", { page_impressions: "impressions" }, dims,
    );
    expect(rows[0]!.value).toBe(1240);
  });

  it("ignores a metric with no data", () => {
    const rows = rowsFromInsights(
      [{ name: "page_fans", values: [] }], "facebook", { page_fans: "followers" }, dims,
    );
    expect(rows).toEqual([]);
  });

  it("drops a point with no end_time rather than dating it now", () => {
    /*
     * Meta stamps a period by its end. A point with no date cannot be placed
     * on a trend line, and defaulting to "now" would stack a month of history
     * onto today — a chart that looks plausible and is wrong.
     */
    const rows = rowsFromInsights(
      [{ name: "reach", values: [{ value: 500 }] }], "instagram", { reach: "reach" }, dims,
    );
    expect(rows).toEqual([]);
  });

  it("drops an unparseable date", () => {
    const rows = rowsFromInsights(
      [{ name: "reach", values: [{ value: 500, end_time: "not a date" }] }],
      "instagram", { reach: "reach" }, dims,
    );
    expect(rows).toEqual([]);
  });

  it("ignores metrics that are not in the mapping", () => {
    // Graph returns extras; storing them would fill the table with rows
    // nothing reads.
    const rows = rowsFromInsights(
      [{ name: "page_views_total", values: [{ value: 90, end_time: "2026-04-18T07:00:00+0000" }] }],
      "facebook", { page_post_engagements: "reach" }, dims,
    );
    expect(rows).toEqual([]);
  });

  it("carries the dimensions onto every row", () => {
    // These scope a row to a client; without them one workspace's chart would
    // include another client's numbers.
    const rows = rowsFromInsights(
      [{ name: "reach", values: [{ value: 5, end_time: "2026-04-18T07:00:00+0000" }] }],
      "instagram", { reach: "reach" }, { businessId: "b1", postId: "p9" },
    );
    expect(rows[0]!.dimensions).toEqual({ businessId: "b1", postId: "p9" });
  });

  it("keeps each day as its own row", () => {
    const rows = rowsFromInsights(
      [{ name: "reach", values: [
        { value: 10, end_time: "2026-04-17T07:00:00+0000" },
        { value: 20, end_time: "2026-04-18T07:00:00+0000" },
      ] }],
      "facebook", { reach: "reach" }, dims,
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.value)).toEqual([10, 20]);
  });

  it("handles an empty response", () => {
    expect(rowsFromInsights([], "facebook", { a: "b" }, {})).toEqual([]);
  });
});

describe("listing pages", () => {
  it("returns the linked Instagram account when there is one", () => {
    const fetcher = ok({
      data: [{
        id: "111", name: "Assured Home Nursing", access_token: "page-token",
        instagram_business_account: { id: "222" },
      }],
    });
    return listPages("user-token", fetcher).then((pages) => {
      expect(pages[0]!.instagramId).toBe("222");
      expect(pages[0]!.accessToken).toBe("page-token");
    });
  });

  it("omits instagramId for a page with no linked account", async () => {
    const fetcher = ok({ data: [{ id: "111", name: "A Page", access_token: "t" }] });
    const pages = await listPages("user-token", fetcher);
    expect(pages[0]!.instagramId).toBeUndefined();
  });

  it("returns an empty list rather than throwing when the user administers none", async () => {
    expect(await listPages("user-token", ok({ data: [] }))).toEqual([]);
  });

  it("raises a classified error when Graph refuses", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: false, json: async () => ({ error: { code: 190 } }),
    } as unknown as Response);
    await expect(listPages("bad-token", fetcher)).rejects.toThrow(GraphError);
  });

  it("treats a 200 carrying an error envelope as a failure", async () => {
    /*
     * Graph does this: HTTP 200 with an error body. Checking the status alone
     * would return an empty page list and look like "this user has no pages"
     * rather than "the token was rejected".
     */
    const fetcher = ok({ error: { code: 10, message: "No permission" } });
    await expect(listPages("t", fetcher)).rejects.toThrow(/App Review/i);
  });
});

describe("the long-lived token exchange", () => {
  it("returns the exchanged token and its lifetime", async () => {
    const fetcher = ok({ access_token: "long-lived", expires_in: 5_184_000 });
    const tokens = await exchangeForLongLivedToken("short", "app", "secret", fetcher);
    expect(tokens.accessToken).toBe("long-lived");
    expect(tokens.expiresIn).toBe(5_184_000);
  });

  it("omits expiry when Meta does not supply one", async () => {
    // Page tokens derived from a long-lived user token have no expiry, and an
    // invented one would disconnect a working integration on schedule.
    const tokens = await exchangeForLongLivedToken("short", "app", "secret", ok({ access_token: "t" }));
    expect(tokens.expiresIn).toBeUndefined();
  });

  it("sends the app secret to the token endpoint, not to insights", async () => {
    const fetcher = ok({ access_token: "t" });
    await exchangeForLongLivedToken("short", "app-id", "app-secret", fetcher);
    const url = String((fetcher.mock.calls[0] as unknown[])[0]);
    expect(url).toContain("/oauth/access_token");
    expect(url).toContain("client_secret=app-secret");
  });
});

describe("fetching page insights", () => {
  it("asks for a window and returns normalised rows", async () => {
    const fetcher = ok({
      // page_post_engagements, verified live on v24. The previous fixture used
      // page_impressions_unique, which Meta has retired.
      data: [{ name: "page_post_engagements", values: [{ value: 2900, end_time: "2026-04-18T07:00:00+0000" }] }],
    });
    const rows = await fetchPageInsights(
      { id: "111", name: "P", accessToken: "pt" }, 30, { businessId: "b1" }, fetcher,
    );
    const url = String((fetcher.mock.calls[0] as unknown[])[0]);
    expect(url).toContain("/111/insights");
    expect(url).toContain("period=day");
    expect(url).toContain("since=");
    expect(rows[0]!.metric).toBe("engagement");
    expect(rows[0]!.source).toBe("facebook");
  });

  it("uses the page token, not the user token", async () => {
    // Insights calls authenticated with a user token return an empty set
    // rather than an error, which is the hardest kind of wrong to notice.
    const fetcher = ok({ data: [] });
    await fetchPageInsights({ id: "1", name: "P", accessToken: "page-token" }, 30, {}, fetcher);
    expect(String((fetcher.mock.calls[0] as unknown[])[0])).toContain("access_token=page-token");
  });
});

describe("fetching social post media", () => {
  it("stores Facebook pictures and permalinks with every metric", async () => {
    const rows = await fetchRecentPosts({ id: "111", name: "Page", accessToken: "pt" }, 5, {}, ok({ data: [{
      id: "post-1", message: "A useful post", created_time: "2026-04-18T07:00:00+0000",
      full_picture: "https://cdn.example/facebook.jpg", permalink_url: "https://facebook.com/post-1",
      likes: { summary: { total_count: 4 } }, comments: { summary: { total_count: 2 } }, shares: { count: 1 },
    }] }));
    expect(rows[0]!.dimensions.imageUrl).toBe("https://cdn.example/facebook.jpg");
    expect(rows[0]!.dimensions.url).toBe("https://facebook.com/post-1");
  });

  it("uses Instagram video thumbnails and stores the permalink", async () => {
    const rows = await fetchRecentInstagramPosts({ id: "111", name: "Page", accessToken: "pt", instagramId: "ig-1" }, 5, {}, ok({ data: [{
      id: "ig-post", caption: "Instagram caption", timestamp: "2026-04-18T07:00:00+0000",
      media_url: "https://cdn.example/video.mp4", thumbnail_url: "https://cdn.example/thumb.jpg",
      permalink: "https://instagram.com/p/ig-post", like_count: 7, comments_count: 3,
    }] }));
    expect(rows[0]!.source).toBe("instagram");
    expect(rows[0]!.dimensions.imageUrl).toBe("https://cdn.example/thumb.jpg");
    expect(rows[0]!.dimensions.url).toBe("https://instagram.com/p/ig-post");
    expect(rows.find((row) => row.metric === "engagement")?.value).toBe(10);
  });
});
