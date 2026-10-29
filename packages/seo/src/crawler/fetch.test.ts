import { describe, it, expect } from "vitest";
import { isBlockedIp, canonicalizeUrl } from "./fetch.js";

/**
 * SSRF guard tests. These matter more than most: the crawler follows a URL the
 * customer typed, so a gap here turns a worker into an open proxy for internal
 * services and cloud metadata endpoints.
 */
describe("isBlockedIp", () => {
  it("blocks loopback", () => {
    expect(isBlockedIp("127.0.0.1")).toBe(true);
    expect(isBlockedIp("127.1.2.3")).toBe(true);
    expect(isBlockedIp("::1")).toBe(true);
  });

  it("blocks cloud instance metadata", () => {
    // The single most important address to block.
    expect(isBlockedIp("169.254.169.254")).toBe(true);
  });

  it("blocks RFC1918 private ranges", () => {
    expect(isBlockedIp("10.0.0.1")).toBe(true);
    expect(isBlockedIp("172.16.0.1")).toBe(true);
    expect(isBlockedIp("172.31.255.254")).toBe(true);
    expect(isBlockedIp("192.168.1.1")).toBe(true);
  });

  it("allows the public addresses adjacent to private ranges", () => {
    expect(isBlockedIp("172.15.0.1")).toBe(false);
    expect(isBlockedIp("172.32.0.1")).toBe(false);
    expect(isBlockedIp("192.167.1.1")).toBe(false);
    expect(isBlockedIp("11.0.0.1")).toBe(false);
  });

  it("blocks CGNAT, 0.0.0.0/8 and multicast", () => {
    expect(isBlockedIp("100.64.0.1")).toBe(true);
    expect(isBlockedIp("0.0.0.0")).toBe(true);
    expect(isBlockedIp("224.0.0.1")).toBe(true);
    expect(isBlockedIp("255.255.255.255")).toBe(true);
  });

  it("blocks IPv6 link-local and unique-local", () => {
    expect(isBlockedIp("fe80::1")).toBe(true);
    expect(isBlockedIp("fc00::1")).toBe(true);
    expect(isBlockedIp("fd12:3456::1")).toBe(true);
  });

  it("blocks IPv4-mapped IPv6 that wraps a private address", () => {
    // A classic bypass: ::ffff:127.0.0.1 is loopback wearing an IPv6 costume.
    expect(isBlockedIp("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedIp("::ffff:169.254.169.254")).toBe(true);
    expect(isBlockedIp("::ffff:10.0.0.1")).toBe(true);
  });

  it("allows ordinary public addresses", () => {
    expect(isBlockedIp("8.8.8.8")).toBe(false);
    expect(isBlockedIp("1.1.1.1")).toBe(false);
    expect(isBlockedIp("2606:4700::1111")).toBe(false);
  });

  it("refuses anything that is not a valid IP", () => {
    expect(isBlockedIp("not-an-ip")).toBe(true);
    expect(isBlockedIp("")).toBe(true);
    expect(isBlockedIp("999.999.999.999")).toBe(true);
  });
});

describe("canonicalizeUrl", () => {
  it("strips the fragment", () => {
    expect(canonicalizeUrl("https://example.com/page#section")).toBe("https://example.com/page");
  });

  it("lowercases the hostname but preserves path case", () => {
    expect(canonicalizeUrl("https://Example.COM/MyPage")).toBe("https://example.com/MyPage");
  });

  it("removes default ports", () => {
    expect(canonicalizeUrl("https://example.com:443/x")).toBe("https://example.com/x");
    expect(canonicalizeUrl("http://example.com:80/x")).toBe("http://example.com/x");
  });

  it("keeps a non-default port", () => {
    expect(canonicalizeUrl("https://example.com:8443/x")).toBe("https://example.com:8443/x");
  });

  it("strips tracking parameters but keeps real ones", () => {
    const out = canonicalizeUrl("https://example.com/p?utm_source=x&id=7&fbclid=abc&gclid=z");
    expect(out).toBe("https://example.com/p?id=7");
  });

  it("sorts query parameters so orderings dedupe to one entry", () => {
    expect(canonicalizeUrl("https://example.com/p?b=2&a=1")).toBe(
      canonicalizeUrl("https://example.com/p?a=1&b=2"),
    );
  });

  it("removes a trailing slash except at the root", () => {
    expect(canonicalizeUrl("https://example.com/path/")).toBe("https://example.com/path");
    expect(canonicalizeUrl("https://example.com/")).toBe("https://example.com/");
  });

  it("trims surrounding whitespace", () => {
    expect(canonicalizeUrl("  https://example.com/x  ")).toBe("https://example.com/x");
  });
});


describe("encoded private addresses", () => {
  it("blocks hexadecimal mapped IPv4 and the full link-local IPv6 range", () => {
    for (const ip of ["::ffff:7f00:1", "::ffff:a9fe:a9fe", "fe90::1", "febf::1", "ff02::1"]) expect(isBlockedIp(ip)).toBe(true);
  });
});
