import * as cheerio from "cheerio";

/**
 * XML sitemap and sitemap-index parsing (spec §3.1 "Use sitemap.xml when
 * available"). Also accepts a plain-text sitemap, which some CMSs emit.
 */

export interface ParsedSitemap {
  /** Page URLs from a <urlset>. */
  urls: string[];
  /** Child sitemap URLs from a <sitemapindex>. */
  sitemaps: string[];
}

export function parseSitemap(body: string, sourceUrl: string): ParsedSitemap {
  const trimmed = body.trim();

  // Plain-text sitemap: one URL per line.
  if (!trimmed.startsWith("<")) {
    const urls = trimmed
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^https?:\/\//i.test(l));
    return { urls, sitemaps: [] };
  }

  const $ = cheerio.load(trimmed, { xml: true });
  const base = new URL(sourceUrl);

  const urls: string[] = [];
  $("urlset > url > loc").each((_, el) => {
    const v = resolve($(el).text().trim(), base);
    if (v) urls.push(v);
  });

  const sitemaps: string[] = [];
  $("sitemapindex > sitemap > loc").each((_, el) => {
    const v = resolve($(el).text().trim(), base);
    if (v) sitemaps.push(v);
  });

  // Some sitemaps omit the namespace wrapper cheerio expects; fall back to a
  // namespace-agnostic sweep when the structured selectors found nothing.
  if (urls.length === 0 && sitemaps.length === 0) {
    $("loc").each((_, el) => {
      const v = resolve($(el).text().trim(), base);
      if (v) urls.push(v);
    });
  }

  return { urls, sitemaps };
}

function resolve(href: string, base: URL): string | null {
  if (!href) return null;
  try {
    const u = new URL(href, base);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Extract `<lastmod>` per URL, for refresh scheduling. */
export function parseSitemapLastmod(body: string): Map<string, Date> {
  const out = new Map<string, Date>();
  if (!body.trim().startsWith("<")) return out;

  const $ = cheerio.load(body, { xml: true });
  $("url").each((_, el) => {
    const loc = $(el).find("loc").first().text().trim();
    const lastmod = $(el).find("lastmod").first().text().trim();
    if (!loc || !lastmod) return;
    const date = new Date(lastmod);
    if (!Number.isNaN(date.getTime())) out.set(loc, date);
  });
  return out;
}
