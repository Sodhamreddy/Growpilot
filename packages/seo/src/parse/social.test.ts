import { describe, it, expect } from "vitest";
import { findSocialProfiles } from "./social.js";

/**
 * Reading a business's social accounts off its own footer.
 *
 * The failure that matters most here is a false positive. A share button
 * stored as an account looks correct in the UI, survives review because nobody
 * checks a handle they did not type, and is only discovered when a month of
 * posts has been planned for an account that does not exist.
 */

describe("finding accounts", () => {
  it("reads the usual footer set", () => {
    const found = findSocialProfiles([
      "https://www.facebook.com/assuredhomenursing",
      "https://www.instagram.com/assuredhome/",
      "https://www.linkedin.com/company/assured-home-nursing",
      "https://twitter.com/assuredhome",
      "https://www.youtube.com/@assuredhome",
    ]);
    expect(found.map((f) => f.network).sort())
      .toEqual(["facebook", "instagram", "linkedin", "x", "youtube"]);
  });

  it("pulls the handle out", () => {
    const [fb] = findSocialProfiles(["https://www.facebook.com/assuredhomenursing"]);
    expect(fb!.handle).toBe("assuredhomenursing");
  });

  it("strips the @ from a handle that carries one", () => {
    const [yt] = findSocialProfiles(["https://www.youtube.com/@stadiumrx"]);
    expect(yt!.handle).toBe("stadiumrx");
    const [tt] = findSocialProfiles(["https://www.tiktok.com/@stadiumrx"]);
    expect(tt!.handle).toBe("stadiumrx");
  });

  it("reads LinkedIn company and personal URLs", () => {
    expect(findSocialProfiles(["https://linkedin.com/company/kleza"])[0]!.handle).toBe("kleza");
    expect(findSocialProfiles(["https://linkedin.com/in/sodham"])[0]!.handle).toBe("sodham");
  });

  it("treats x.com and twitter.com as one network", () => {
    const found = findSocialProfiles(["https://x.com/kleza", "https://twitter.com/klezahq"]);
    expect(found).toHaveLength(1);
    expect(found[0]!.network).toBe("x");
  });

  it("stores a canonical URL, not the link as written", () => {
    // Sites link their own accounts with tracking parameters attached.
    const [ig] = findSocialProfiles([
      "https://www.instagram.com/klezahq/?utm_source=footer&hl=en",
    ]);
    expect(ig!.url).toBe("https://www.instagram.com/klezahq");
  });

  it("finds accounts wherever they sit in the list", () => {
    const [ig] = findSocialProfiles([
      "https://partner.example.com/a", "https://cdn.example.com/b",
      "https://www.instagram.com/klezahq",
    ]);
    expect(ig!.handle).toBe("klezahq");
  });
});

describe("what must never be stored as an account", () => {
  it("ignores share buttons", () => {
    /*
     * The specific bug: a footer "Share on Facebook" button resolves to
     * facebook.com/sharer/sharer.php, matches the handle pattern, and gets
     * stored as an account called "sharer".
     */
    expect(findSocialProfiles([
      "https://www.facebook.com/sharer/sharer.php?u=https://example.com",
      "https://twitter.com/intent/tweet?url=https://example.com",
      "https://www.linkedin.com/shareArticle?mini=true&url=https://example.com",
      "https://pinterest.com/pin/create/button/?url=https://example.com",
    ])).toEqual([]);
  });

  it("ignores a share endpoint written as a bare script", () => {
    /*
     * The blocklist anchored every entry with `$`, so it caught
     * facebook.com/sharer/sharer.php (first segment "sharer") and missed
     * facebook.com/sharer.php, whose first segment is "sharer.php" — the more
     * common of the two footer forms. It stored a Facebook account called
     * "sharer.php" from an ordinary share button.
     */
    expect(findSocialProfiles([
      "https://www.facebook.com/sharer.php?u=https://example.com",
      "https://www.facebook.com/dialog/share?href=https://example.com",
    ])).toEqual([]);
  });

  it("ignores a link to a single post, reel or video", () => {
    // A site linking its own content would otherwise store the route name as
    // the handle: an Instagram account called "reel", a channel called
    // "shorts", and a youtu.be video id as though it were a channel.
    expect(findSocialProfiles([
      "https://www.instagram.com/reel/Cxyz123/",
      "https://www.instagram.com/stories/acmecare/1234567/",
      "https://www.youtube.com/shorts/abc123",
      "https://www.youtube.com/playlist?list=PLxyz",
      "https://youtu.be/dQw4w9WgXcQ",
    ])).toEqual([]);
  });

  it("ignores login, privacy and policy pages", () => {
    expect(findSocialProfiles([
      "https://www.facebook.com/privacy/policy",
      "https://www.instagram.com/about/legal/terms/",
      "https://www.linkedin.com/legal/privacy-policy",
      "https://www.facebook.com/login",
    ])).toEqual([]);
  });

  it("ignores content pages that are not accounts", () => {
    expect(findSocialProfiles([
      "https://www.youtube.com/watch?v=abc123",
      "https://www.youtube.com/results?search_query=care",
      "https://www.instagram.com/explore/tags/homecare/",
      "https://www.facebook.com/hashtag/homecare",
    ])).toEqual([]);
  });

  it("ignores a bare network homepage", () => {
    expect(findSocialProfiles([
      "https://www.facebook.com/", "https://instagram.com", "https://x.com/",
    ])).toEqual([]);
  });

  it("ignores a tracking pixel domain", () => {
    expect(findSocialProfiles(["https://www.facebook.com/tr?id=123&ev=PageView"])).toEqual([]);
  });
});

describe("keeping one account per network", () => {
  it("takes the first when a site links several", () => {
    // The footer link is the business's more often than an inline mention is.
    const found = findSocialProfiles([
      "https://www.instagram.com/thebusiness",
      "https://www.instagram.com/anemployee",
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]!.handle).toBe("thebusiness");
  });
});

describe("surviving what a real crawl returns", () => {
  it("skips links that do not parse", () => {
    expect(() => findSocialProfiles(["not a url", "", "://broken"])).not.toThrow();
  });

  it("ignores non-http schemes", () => {
    expect(findSocialProfiles([
      "javascript:void(0)", "mailto:hi@example.com", "tel:+15551234567",
    ])).toEqual([]);
  });

  it("returns nothing for a site with no social links", () => {
    expect(findSocialProfiles([
      "https://partner.example.com", "https://supplier.example.org/page",
    ])).toEqual([]);
  });

  it("handles an empty list", () => {
    expect(findSocialProfiles([])).toEqual([]);
  });

  it("is not fooled by a lookalike domain", () => {
    // notfacebook.com and facebook.com.evil.example are not Facebook.
    expect(findSocialProfiles([
      "https://notfacebook.com/business",
      "https://facebook.com.evil.example/business",
    ])).toEqual([]);
  });

  it("accepts a regional domain where the network uses one", () => {
    expect(findSocialProfiles(["https://www.pinterest.co.uk/klezahq"])[0]!.network)
      .toBe("pinterest");
  });
});
