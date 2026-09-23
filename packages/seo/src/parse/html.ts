import * as cheerio from "cheerio";

/**
 * HTML extraction — spec §3.1: "Parse visible text, headings, title/meta,
 * canonical, OpenGraph, JSON-LD and internal links."
 */

export interface ParsedPage {
  title: string | null;
  metaDescription: string | null;
  canonical: string | null;
  robotsMeta: string | null;
  h1: string | null;
  headings: { level: number; text: string }[];
  text: string;
  wordCount: number;
  openGraph: Record<string, string>;
  jsonLd: unknown[];
  internalLinks: string[];
  externalLinks: string[];
  images: { src: string; alt: string | null }[];
  lang: string | null;
  /** Heuristic classification used to prioritise extraction (spec §3.1). */
  pageType: PageType;
}

export type PageType =
  | "home" | "about" | "services" | "product" | "location"
  | "contact" | "faq" | "blog" | "legal" | "other";

/** Elements whose text is never part of the visible content. */
const NON_CONTENT = "script, style, noscript, template, svg, iframe, nav, footer, header, form";

export function parseHtml(html: string, pageUrl: string): ParsedPage {
  const $ = cheerio.load(html);
  const base = new URL(pageUrl);

  const title = text($("head > title").first()) ?? null;
  const metaDescription = attr($, 'meta[name="description"]', "content");
  const canonicalRaw = attr($, 'link[rel="canonical"]', "href");
  const robotsMeta = attr($, 'meta[name="robots"]', "content");
  const lang = $("html").attr("lang")?.trim() ?? null;

  const openGraph: Record<string, string> = {};
  $('meta[property^="og:"], meta[name^="twitter:"]').each((_, el) => {
    const key = ($(el).attr("property") ?? $(el).attr("name"))?.trim();
    const content = $(el).attr("content")?.trim();
    if (key && content) openGraph[key] = content;
  });

  const jsonLd: unknown[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text().trim();
    if (!raw) return;
    try {
      const parsed: unknown = JSON.parse(raw);
      // A @graph wrapper is common; flatten it so consumers see entities.
      if (parsed && typeof parsed === "object" && "@graph" in parsed) {
        const graph = (parsed as { "@graph": unknown })["@graph"];
        if (Array.isArray(graph)) jsonLd.push(...graph);
        else jsonLd.push(parsed);
      } else if (Array.isArray(parsed)) {
        jsonLd.push(...parsed);
      } else {
        jsonLd.push(parsed);
      }
    } catch {
      // Malformed JSON-LD is common in the wild and must not fail the crawl
      // (spec §18.1 critical test: "no structured data" / "malformed JSON").
    }
  });

  const headings: { level: number; text: string }[] = [];
  $("h1, h2, h3, h4, h5, h6").each((_, el) => {
    const t = $(el).text().replace(/\s+/g, " ").trim();
    if (t) headings.push({ level: Number(el.tagName.slice(1)), text: t });
  });

  const internal = new Set<string>();
  const external = new Set<string>();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href || href.startsWith("#") || /^(mailto|tel|javascript):/i.test(href)) return;
    try {
      const resolved = new URL(href, base);
      resolved.hash = "";
      if (resolved.hostname === base.hostname) internal.add(resolved.toString());
      else if (resolved.protocol === "http:" || resolved.protocol === "https:") {
        external.add(resolved.toString());
      }
    } catch {
      // Unparseable href — ignore.
    }
  });

  const images: { src: string; alt: string | null }[] = [];
  $("img[src]").each((_, el) => {
    const src = $(el).attr("src");
    if (!src) return;
    try {
      images.push({ src: new URL(src, base).toString(), alt: $(el).attr("alt")?.trim() ?? null });
    } catch {
      // Ignore unresolvable image sources.
    }
  });

  // Visible text: drop chrome, then collapse whitespace.
  const body = $("body").clone();
  body.find(NON_CONTENT).remove();
  const visibleText = body.text().replace(/\s+/g, " ").trim();

  const h1 = headings.find((h) => h.level === 1)?.text ?? null;

  return {
    title,
    metaDescription,
    canonical: canonicalRaw ? resolveOrNull(canonicalRaw, base) : null,
    robotsMeta,
    h1,
    headings,
    text: visibleText,
    wordCount: countWords(visibleText),
    openGraph,
    jsonLd,
    internalLinks: [...internal],
    externalLinks: [...external],
    images,
    lang,
    pageType: classifyPageType(pageUrl, title, h1, visibleText),
  };
}

function text(el: { text(): string }): string | null {
  const t = el.text().replace(/\s+/g, " ").trim();
  return t || null;
}

function attr($: cheerio.CheerioAPI, selector: string, name: string): string | null {
  const v = $(selector).first().attr(name)?.trim();
  return v || null;
}

function resolveOrNull(href: string, base: URL): string | null {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

export function countWords(text: string): number {
  const matches = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
  return matches ? matches.length : 0;
}

/**
 * Page-type heuristic. Spec §3.1 prioritises Home, About, Services, Products,
 * Locations, Contact, FAQ and blog pages, so the crawler needs a cheap signal
 * before any model is involved.
 */
export function classifyPageType(
  url: string,
  title: string | null,
  h1: string | null,
  body: string,
): PageType {
  let path: string;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    path = url.toLowerCase();
  }
  const haystack = `${path} ${(title ?? "").toLowerCase()} ${(h1 ?? "").toLowerCase()}`;

  if (path === "/" || path === "") return "home";

  const patterns: [PageType, RegExp][] = [
    ["about", /\b(about|who-we-are|our-story|team|mission)\b/],
    ["contact", /\b(contact|get-in-touch|book|appointment|enquiry|inquiry)\b/],
    ["faq", /\b(faq|faqs|frequently-asked|help|support)\b/],
    ["location", /\b(location|locations|branch|branches|find-us|store|stores|clinic)\b/],
    ["services", /\b(service|services|solutions|what-we-do|treatments|capabilities)\b/],
    ["product", /\b(product|products|shop|pricing|plans|packages)\b/],
    ["legal", /\b(privacy|terms|cookie|legal|disclaimer|gdpr)\b/],
    ["blog", /\b(blog|news|article|articles|insights|resources|guides|post)\b/],
  ];

  for (const [type, re] of patterns) {
    if (re.test(haystack)) return type;
  }

  // A dated path segment is a strong blog signal even without the word.
  if (/\/(19|20)\d{2}\/\d{1,2}\//.test(path)) return "blog";
  // A long page with no other signal is most likely editorial content.
  if (countWords(body) > 900) return "blog";

  return "other";
}

/** Priority order for the crawl frontier (spec §3.1). */
export const PAGE_TYPE_PRIORITY: Record<PageType, number> = {
  home: 100,
  services: 90,
  product: 85,
  about: 80,
  location: 75,
  contact: 70,
  faq: 65,
  blog: 40,
  other: 20,
  legal: 5,
};
