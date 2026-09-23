import { describe, it, expect } from "vitest";
import { parseRobots, isAllowed, crawlDelayFor } from "./robots.js";

const UA = "GrowPilotBot/0.1";

describe("parseRobots", () => {
  it("parses groups, rules and sitemaps", () => {
    const r = parseRobots(`
User-agent: *
Disallow: /admin
Allow: /admin/public
Crawl-delay: 2

Sitemap: https://example.com/sitemap.xml
`);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]!.rules).toHaveLength(2);
    expect(r.sitemaps).toEqual(["https://example.com/sitemap.xml"]);
  });

  it("ignores comments and blank lines", () => {
    const r = parseRobots("# a comment\nUser-agent: *  # inline\nDisallow: /x\n\n");
    expect(r.groups[0]!.rules).toEqual([{ type: "disallow", pattern: "/x" }]);
  });

  it("groups consecutive user-agent lines together", () => {
    const r = parseRobots("User-agent: a\nUser-agent: b\nDisallow: /x");
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]!.userAgents).toEqual(["a", "b"]);
  });

  it("treats an empty Disallow as allowing everything", () => {
    const r = parseRobots("User-agent: *\nDisallow:");
    expect(r.groups[0]!.rules).toHaveLength(0);
    expect(isAllowed(r, UA, "/anything")).toBe(true);
  });
});

describe("isAllowed", () => {
  it("allows everything when robots.txt is empty", () => {
    expect(isAllowed(parseRobots(""), UA, "/anything")).toBe(true);
  });

  it("honours a simple disallow", () => {
    const r = parseRobots("User-agent: *\nDisallow: /private");
    expect(isAllowed(r, UA, "/private/page")).toBe(false);
    expect(isAllowed(r, UA, "/public/page")).toBe(true);
  });

  it("gives the longest matching pattern precedence", () => {
    // Allow is more specific than Disallow here, so it wins.
    const r = parseRobots("User-agent: *\nDisallow: /admin\nAllow: /admin/public");
    expect(isAllowed(r, UA, "/admin/secret")).toBe(false);
    expect(isAllowed(r, UA, "/admin/public/page")).toBe(true);
  });

  it("prefers Allow on an equal-length tie", () => {
    const r = parseRobots("User-agent: *\nDisallow: /x\nAllow: /x");
    expect(isAllowed(r, UA, "/x")).toBe(true);
  });

  it("supports the * wildcard", () => {
    const r = parseRobots("User-agent: *\nDisallow: /*.pdf");
    expect(isAllowed(r, UA, "/files/report.pdf")).toBe(false);
    expect(isAllowed(r, UA, "/files/report.html")).toBe(true);
  });

  it("supports the $ end anchor", () => {
    const r = parseRobots("User-agent: *\nDisallow: /page$");
    expect(isAllowed(r, UA, "/page")).toBe(false);
    expect(isAllowed(r, UA, "/page/sub")).toBe(true);
  });

  it("prefers a specific user-agent group over the wildcard group", () => {
    const r = parseRobots(`
User-agent: *
Disallow: /

User-agent: growpilotbot
Allow: /
Disallow: /admin
`);
    expect(isAllowed(r, UA, "/public")).toBe(true);
    expect(isAllowed(r, UA, "/admin")).toBe(false);
    // A different crawler still gets the wildcard group's blanket disallow.
    expect(isAllowed(r, "SomeOtherBot", "/public")).toBe(false);
  });

  it("escapes regex metacharacters in patterns", () => {
    const r = parseRobots("User-agent: *\nDisallow: /a.b");
    expect(isAllowed(r, UA, "/a.b")).toBe(false);
    // The dot must be literal — "/axb" should not match.
    expect(isAllowed(r, UA, "/axb")).toBe(true);
  });
});

describe("crawlDelayFor", () => {
  it("reads the delay from the matching group", () => {
    expect(crawlDelayFor(parseRobots("User-agent: *\nCrawl-delay: 5"), UA)).toBe(5);
  });

  it("defaults to zero when unspecified", () => {
    expect(crawlDelayFor(parseRobots("User-agent: *\nDisallow: /x"), UA)).toBe(0);
  });
});
