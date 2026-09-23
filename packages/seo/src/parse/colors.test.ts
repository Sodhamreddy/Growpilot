import { describe, it, expect } from "vitest";
import {
  extractBrandAssetLinks, extractBrandColors, mergeBrandColors, readableTextOn,
} from "./colors.js";
import { parseHtml } from "./html.js";

/**
 * These guard the failure that made the brand-colour step useless in practice:
 * detection was run against extracted page text rather than markup, so it could
 * never find anything. The first test states the dependency directly — colour
 * survives in HTML and does not survive text extraction — so a future
 * refactor that moves detection back downstream of the parser fails here.
 */

const PAGE = `
  <html><head><style>
    .btn { background-color: #2c6446; color: #ffffff; }
    .hero { background: #2C6446; }
    a { color: rgb(198, 40, 40); }
  </style></head>
  <body><h1>Kleza</h1>
    <div style="border-left-color:#c62828">Digital growth partner</div>
    <p>We build things.</p>
  </body></html>`;

describe("brand colour extraction", () => {
  it("reads colours out of markup", () => {
    const colors = extractBrandColors(PAGE, 4);
    expect(colors.map((c) => c.hex)).toContain("#2C6446");
    expect(colors[0]?.role).toBe("primary");
  });

  it("cannot read colours out of extracted text — detection must see HTML", () => {
    // The regression: source_pages stores this, not the markup above.
    const { text } = parseHtml(PAGE, "https://example.com/");
    expect(extractBrandColors(text, 4)).toEqual([]);
  });

  it("drops near-white, near-black and grey as brand signal", () => {
    const colors = extractBrandColors(
      `<style>body{background:#ffffff;color:#000000;border-color:#808080}</style>`,
    );
    expect(colors).toEqual([]);
  });

  it("weights background colours above body text colour", () => {
    const colors = extractBrandColors(
      `<style>.a{color:#c62828}.b{background-color:#2c6446}</style>`,
    );
    expect(colors[0]?.hex).toBe("#2C6446");
  });

  it("prioritises named brand tokens from a linked stylesheet", () => {
    const colors = extractBrandColors(
      `:root{--primary:#146C43;--accent:#F97316}.utility{color:#7C3AED}`,
    );
    expect(colors[0]?.hex).toBe("#146C43");
    expect(colors[1]?.hex).toBe("#F97316");
  });
});

describe("brand asset links", () => {
  it("finds linked stylesheets and a header logo", () => {
    const assets = extractBrandAssetLinks(`
      <html><head><link rel="stylesheet" href="/assets/site.css"></head>
      <body><header><a class="site-logo"><img src="/images/logo.svg" alt="Acme logo"></a></header></body></html>
    `, "https://example.com/about");

    expect(assets.stylesheetUrls).toEqual(["https://example.com/assets/site.css"]);
    expect(assets.logoUrl).toBe("https://example.com/images/logo.svg");
  });

  it("prefers a structured-data logo over a favicon", () => {
    const assets = extractBrandAssetLinks(`
      <link rel="icon" href="/favicon.png">
      <script type="application/ld+json">{"@type":"Organization","logo":{"url":"/brand/acme-logo.png"}}</script>
    `, "https://example.com/");

    expect(assets.logoUrl).toBe("https://example.com/brand/acme-logo.png");
  });
});

describe("mergeBrandColors", () => {
  it("ranks a colour recurring site-wide above a one-off accent", () => {
    const merged = mergeBrandColors([
      [{ hex: "#2C6446", role: "primary", weight: 3 }],
      [{ hex: "#2C6446", role: "primary", weight: 3 }],
      [{ hex: "#C62828", role: "primary", weight: 5 }],
    ]);
    expect(merged[0]?.hex).toBe("#2C6446");
    expect(merged[0]?.weight).toBe(6);
  });

  it("collapses near-identical shades contributed by different pages", () => {
    const merged = mergeBrandColors([
      [{ hex: "#2C6446", role: "primary", weight: 4 }],
      [{ hex: "#2D6547", role: "primary", weight: 2 }],
    ]);
    expect(merged).toHaveLength(1);
  });

  it("reassigns roles by site-wide rank, not per-page rank", () => {
    const merged = mergeBrandColors([
      [{ hex: "#C62828", role: "primary", weight: 1 }],
      [{ hex: "#2C6446", role: "secondary", weight: 9 }],
    ]);
    expect(merged[0]).toMatchObject({ hex: "#2C6446", role: "primary" });
    expect(merged[1]).toMatchObject({ hex: "#C62828", role: "secondary" });
  });

  it("returns nothing when no page yielded a colour", () => {
    expect(mergeBrandColors([[], []])).toEqual([]);
  });
});

describe("readableTextOn", () => {
  it("picks white on a dark brand colour and black on a light one", () => {
    expect(readableTextOn("#2C6446")).toBe("#ffffff");
    expect(readableTextOn("#F5F7FA")).toBe("#111111");
  });
});
