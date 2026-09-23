import { describe, it, expect } from "vitest";

/**
 * Telling a JavaScript interstitial apart from an ordinary refusal.
 *
 * The two look identical at the HTTP layer — both are a 403 — but they need
 * opposite advice. A bot filter can be allowlisted, so "ask whoever runs the
 * site to let us through" is useful. A "checking your browser" page cannot: it
 * demands a JavaScript engine that a static fetcher does not have, and sending
 * the customer to chase an allowlist wastes their time on something that
 * cannot work.
 *
 * The pattern is duplicated here deliberately rather than exported: it is an
 * implementation detail of the crawler, and a test that reaches into internals
 * to assert on them tends to pin the wrong thing.
 */
const JS_CHALLENGE =
  /checking your browser|enable javascript|javascript is required|just a moment|__cf_chl|cf-browser-verification|window\.location\s*(?:=|\.(?:replace|assign|href)\s*[=(])/i;

/** The real shape of the page myassuredhomenursing.com returns. */
const HOSTINGER_CHALLENGE = `<!DOCTYPE html><html><head>
  <style>html{font-size: 14pt;} .spinner, #timer { display:block; }</style>
  <script>setTimeout(function(){ window.location = "/?verified=1"; }, 1500);</script>
  </head><body><div class="container">
  <h1 class="main">Checking your browser before accessing the website.</h1>
  <p class="js_notice">This process is automatic.</p>
  </div></body></html>`;

const CLOUDFLARE_CHALLENGE = `<!DOCTYPE html><html><head><title>Just a moment...</title></head>
  <body><div id="cf-browser-verification"></div>
  <script>window._cf_chl_opt={cvId:"3"};</script></body></html>`;

describe("JavaScript challenge detection", () => {
  it("recognises the Hostinger interstitial", () => {
    expect(JS_CHALLENGE.test(HOSTINGER_CHALLENGE)).toBe(true);
  });

  it("recognises the Cloudflare interstitial", () => {
    expect(JS_CHALLENGE.test(CLOUDFLARE_CHALLENGE)).toBe(true);
  });

  it("recognises a bare enable-JavaScript notice", () => {
    expect(JS_CHALLENGE.test("<noscript>Please enable JavaScript to continue.</noscript>"))
      .toBe(true);
  });

  it("recognises a script-driven redirect on its own", () => {
    expect(JS_CHALLENGE.test('<script>window.location.replace("/check")</script>')).toBe(true);
  });
});

describe("what must NOT be mistaken for a challenge", () => {
  it("an ordinary WAF denial page", () => {
    const wafDenial = `<html><body><h1>403 Forbidden</h1>
      <p>Your request was blocked by our security rules. Reference #4021.</p></body></html>`;
    expect(JS_CHALLENGE.test(wafDenial)).toBe(false);
  });

  it("a plain login wall", () => {
    const login = `<html><body><form action="/login"><input type="password"></form></body></html>`;
    expect(JS_CHALLENGE.test(login)).toBe(false);
  });

  it("an empty body", () => {
    expect(JS_CHALLENGE.test("")).toBe(false);
  });

  it("a normal page that happens to mention JavaScript in its copy", () => {
    // This only ever gets tested on a refusal status, but the pattern should
    // still not fire on prose about the language.
    const article = `<html><body><h1>Why we rewrote our JavaScript build</h1>
      <p>JavaScript tooling has changed a lot this year.</p></body></html>`;
    expect(JS_CHALLENGE.test(article)).toBe(false);
  });
});
