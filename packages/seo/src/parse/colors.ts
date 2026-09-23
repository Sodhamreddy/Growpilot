import * as cheerio from "cheerio";

/**
 * Brand colour extraction from a page's own markup and inline styles.
 *
 * Real extraction, not a guess: colours are counted by how often they appear
 * and weighted by where — a colour on a button or a header counts for more
 * than one buried in a footnote. Near-white and near-black are dropped, since
 * every site has them and they carry no brand signal.
 *
 * This function reads whichever markup or stylesheet text it is given. The
 * crawler discovers a bounded set of external stylesheets below and feeds
 * their contents through the same ranking. An empty result means "could not
 * detect", not "no brand colours".
 */

export interface BrandColor {
  hex: string;
  /** How many weighted occurrences were seen. */
  weight: number;
  role: "primary" | "secondary" | "accent" | "surface";
}

const HEX = /#([0-9a-f]{3}|[0-9a-f]{6})\b/gi;
const RGB = /rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/gi;

/** Properties whose colour is more likely to be brand-bearing. */
const WEIGHTED_PROPS: [RegExp, number][] = [
  [/background(?:-color)?\s*:/i, 3],
  [/border(?:-[a-z]+)?-color\s*:/i, 2],
  [/\bfill\s*:/i, 2],
  [/\bcolor\s*:/i, 1],
];

export function extractBrandColors(html: string, limit = 4): BrandColor[] {
  const counts = new Map<string, number>();

  const bump = (hex: string, weight: number) => {
    const norm = normalizeHex(hex);
    if (!norm || isNeutral(norm)) return;
    counts.set(norm, (counts.get(norm) ?? 0) + weight);
  };

  // Walk declarations so each colour picks up the weight of its property.
  for (const decl of html.split(/[;{}\n]/)) {
    const namedBrandToken = /--(?:brand|primary|secondary|accent|theme)(?:-[\w-]+)?\s*:/i.test(decl);
    const weight = namedBrandToken ? 8 : (WEIGHTED_PROPS.find(([re]) => re.test(decl))?.[1] ?? 1);

    for (const m of decl.matchAll(HEX)) bump(m[0], weight);
    for (const m of decl.matchAll(RGB)) {
      bump(rgbToHex(Number(m[1]), Number(m[2]), Number(m[3])), weight);
    }
  }

  const ranked = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .filter(([hex], i, arr) => arr.findIndex(([h]) => areSimilar(h, hex)) === i)
    .slice(0, limit);

  const roles: BrandColor["role"][] = ["primary", "secondary", "accent", "surface"];
  return ranked.map(([hex, weight], i) => ({
    hex: hex.toUpperCase(),
    weight,
    role: roles[i] ?? "surface",
  }));
}

export interface BrandAssetLinks {
  logoUrl: string | null;
  stylesheetUrls: string[];
}

/**
 * Reads the asset links that disappear once HTML is reduced to page text.
 *
 * Logo candidates are ranked from explicit structured-data and logo-labelled
 * images down to a favicon fallback. Stylesheets are returned separately so
 * the crawler can safely fetch a small bounded set and inspect the real theme
 * variables instead of assuming all sites inline their colours.
 */
export function extractBrandAssetLinks(html: string, pageUrl: string): BrandAssetLinks {
  const $ = cheerio.load(html);
  const base = new URL(pageUrl);
  const stylesheetUrls = new Set<string>();

  $('link[rel~="stylesheet"][href]').each((_, el) => {
    const resolved = resolvePublicAsset($(el).attr("href"), base);
    if (resolved) stylesheetUrls.add(resolved);
  });

  const candidates = new Map<string, number>();
  const add = (raw: unknown, score: number) => {
    const value = typeof raw === "string"
      ? raw
      : raw && typeof raw === "object" && "url" in raw
        ? (raw as { url?: unknown }).url
        : null;
    const resolved = resolvePublicAsset(typeof value === "string" ? value : undefined, base);
    if (!resolved || !/\.(?:avif|gif|jpe?g|png|svg|webp)(?:[?#]|$)/i.test(resolved)) return;
    candidates.set(resolved, Math.max(candidates.get(resolved) ?? 0, score));
  };

  // Schema.org Organization/LocalBusiness entities often declare the cleanest
  // logo, even when the visible header image is lazy-loaded.
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const parsed: unknown = JSON.parse($(el).contents().text());
      visitJson(parsed, (key, value) => {
        if (key.toLowerCase() === "logo") add(value, 20);
      });
    } catch {
      // Malformed structured data is common and never blocks the crawl.
    }
  });

  $("img").each((_, el) => {
    const node = $(el);
    const raw = node.attr("src") ?? node.attr("data-src") ?? node.attr("data-lazy-src");
    if (!raw) return;

    const context = [
      raw,
      node.attr("alt"),
      node.attr("class"),
      node.attr("id"),
      node.parent().attr("class"),
      node.parent().attr("id"),
    ].filter(Boolean).join(" ").toLowerCase();

    let score = 0;
    if (/\b(?:site[-_ ]?)?logo\b|brand[-_ ]?mark/.test(context)) score += 12;
    if (node.closest("header, nav").length > 0) score += 4;
    if (/\.(?:svg|png)(?:[?#]|$)/i.test(raw)) score += 2;
    if (/favicon|avatar|testimonial|author|payment|badge|icon/i.test(context)) score -= 8;
    if (score >= 4) add(raw, score);
  });

  // A favicon is useful only when the site exposes no real logo.
  $('link[rel~="icon"][href], link[rel="apple-touch-icon"][href]').each((_, el) => {
    add($(el).attr("href"), 1);
  });

  const logoUrl = [...candidates.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return { logoUrl, stylesheetUrls: [...stylesheetUrls] };
}

function resolvePublicAsset(raw: string | undefined, base: URL): string | null {
  if (!raw || raw.startsWith("data:") || raw.startsWith("blob:")) return null;
  try {
    const resolved = new URL(raw, base);
    return resolved.protocol === "http:" || resolved.protocol === "https:" ? resolved.toString() : null;
  } catch {
    return null;
  }
}

function visitJson(value: unknown, visit: (key: string, value: unknown) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) visitJson(item, visit);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    visit(key, child);
    visitJson(child, visit);
  }
}

function normalizeHex(raw: string): string | null {
  const v = raw.replace("#", "").toLowerCase();
  if (v.length === 3) return `#${v[0]!}${v[0]!}${v[1]!}${v[1]!}${v[2]!}${v[2]!}`;
  if (v.length === 6) return `#${v}`;
  return null;
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, n));
  return `#${[r, g, b].map((n) => clamp(n).toString(16).padStart(2, "0")).join("")}`;
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const v = hex.replace("#", "");
  return {
    r: parseInt(v.slice(0, 2), 16),
    g: parseInt(v.slice(2, 4), 16),
    b: parseInt(v.slice(4, 6), 16),
  };
}

/**
 * Near-white, near-black and near-grey carry no brand signal — every site has
 * them for text and backgrounds.
 */
function isNeutral(hex: string): boolean {
  const { r, g, b } = hexToRgb(hex);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const saturation = max === min ? 0 : (max - min) / (255 - Math.abs(max + min - 255));

  if (lightness > 240 || lightness < 18) return true;   // near-white / near-black
  if (saturation < 0.12) return true;                    // grey
  return false;
}

/** Collapses shades that differ only slightly, so one brand colour wins once. */
function areSimilar(a: string, b: string, tolerance = 28): boolean {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return (
    Math.abs(x.r - y.r) < tolerance &&
    Math.abs(x.g - y.g) < tolerance &&
    Math.abs(x.b - y.b) < tolerance
  );
}

/** Whether white or black text reads better on a colour — for previews. */
export function readableTextOn(hex: string): "#ffffff" | "#111111" {
  const { r, g, b } = hexToRgb(hex);
  // Relative luminance, sRGB coefficients.
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.55 ? "#111111" : "#ffffff";
}

/**
 * Combine palettes detected on several pages into one site palette.
 *
 * A single page is a weak sample: a blog post styles almost nothing, while the
 * home page carries the whole design system. Summing weights across pages lets
 * the colours that recur site-wide outrank one-off accents, which is what
 * "brand colour" actually means.
 */
export function mergeBrandColors(palettes: BrandColor[][], limit = 4): BrandColor[] {
  const totals = new Map<string, number>();
  for (const palette of palettes) {
    for (const c of palette) {
      totals.set(c.hex, (totals.get(c.hex) ?? 0) + c.weight);
    }
  }

  const ranked = [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    // Re-collapse near-identical shades: two pages can each contribute a
    // slightly different rendering of the same brand colour.
    .filter(([hex], i, arr) => arr.findIndex(([h]) => areSimilar(h, hex)) === i)
    .slice(0, limit);

  const roles: BrandColor["role"][] = ["primary", "secondary", "accent", "surface"];
  return ranked.map(([hex, weight], i) => ({
    hex: hex.toUpperCase(),
    weight,
    role: roles[i] ?? "surface",
  }));
}
