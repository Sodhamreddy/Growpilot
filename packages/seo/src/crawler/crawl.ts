import type { Logger } from "@ob/core";
import { AppError } from "@ob/core";
import { guardedFetch, canonicalizeUrl } from "./fetch.js";
import { parseRobots, isAllowed, crawlDelayFor, type Robots } from "./robots.js";
import { parseSitemap } from "./sitemap.js";
import { parseHtml, PAGE_TYPE_PRIORITY, type ParsedPage } from "../parse/html.js";
import { findSocialProfiles, type FoundProfile } from "../parse/social.js";
import {
  extractBrandAssetLinks, extractBrandColors, mergeBrandColors, type BrandColor,
} from "../parse/colors.js";
import { renderPage, renderingAvailable, renderingHealthy } from "./render.js";

/**
 * Site crawler — spec §3.1.
 *
 * Honours robots.txt, uses sitemap.xml when present, prioritises the page
 * types the spec names, and stops at the configured page/depth budget.
 *
 * Handles the §18.1 critical tests: no sitemap, crawler blocked, and
 * JavaScript-heavy sites (reported via `jsHeavy`, since this is a static
 * fetcher — a headless renderer is the documented upgrade path).
 */

export interface CrawlOptions {
  maxPages: number;
  maxDepth: number;
  timeoutMs: number;
  userAgent: string;
  /**
   * Politeness floor between every request, robots.txt and sitemaps included.
   * robots.txt Crawl-delay overrides this upward.
   *
   * Default 1200ms rather than something snappier: many sites sit behind a WAF
   * that starts returning 403 after a few rapid requests, and a crawl that
   * trips the filter gets nothing at all. Slower and complete beats fast and
   * blocked.
   */
  minDelayMs?: number;
  /**
   * Base URL of the rendering service (services/crawler), when one is running.
   *
   * Optional and checked once per crawl. Present and healthy, a page that the
   * static fetcher cannot read — a JavaScript challenge, or markup with no
   * text — is retried through a real browser. Absent or down, the crawl behaves
   * exactly as it does today, including its error messages: a rendering service
   * that is not there must never turn a working crawl into a broken one.
   */
  renderServiceUrl?: string;
}

export interface CrawledPage extends ParsedPage {
  url: string;
  httpStatus: number;
  depth: number;
}

export interface CrawlResult {
  origin: string;
  pages: CrawledPage[];
  discovered: number;
  robotsAllowed: boolean;
  sitemapUrls: string[];
  /** True when pages render almost no server-side text — needs a JS renderer. */
  jsHeavy: boolean;
  /**
   * Brand colours read from the markup, merged across every page fetched.
   *
   * Detected here rather than later because this is the only point where the
   * raw HTML exists: what gets stored is the extracted text, and colour lives
   * in style attributes and style blocks that text extraction throws away.
   * Empty means "could not detect" — never a fabricated palette.
   */
  brandColors: BrandColor[];
  /** Best logo declared by structured data or the site's visible header. */
  logoUrl: string | null;
  /**
   * Social accounts the site links to, usually from its footer.
   *
   * Collected here for the same reason as brand colours: this is where the
   * links exist. Only the page text is stored afterwards, and the outbound
   * links go with the markup that held them.
   *
   * Empty means the site links to no recognisable account, never a guess.
   */
  socialProfiles: FoundProfile[];
  warnings: string[];
}

/**
 * Markers of a "checking your browser" interstitial.
 *
 * These pages answer 403 (or 503) with HTML that runs a script and then
 * redirects. Matching on the visible phrasing plus the redirect mechanism keeps
 * this narrow: a page that merely mentions JavaScript in its copy will not
 * match, because it also has to be a refusal status to be tested at all.
 */
const JS_CHALLENGE =
  /checking your browser|enable javascript|javascript is required|just a moment|__cf_chl|cf-browser-verification|window\.location\s*(?:=|\.(?:replace|assign|href)\s*[=(])/i;

interface Frontier {
  url: string;
  depth: number;
  priority: number;
}

export async function crawlSite(
  startUrl: string,
  opts: CrawlOptions,
  log: Logger,
): Promise<CrawlResult> {
  const origin = new URL(canonicalizeUrl(startUrl)).origin;
  const warnings: string[] = [];

  // Politeness gate, shared by every request in this crawl — pages, robots.txt
  // and sitemaps alike. Bot filters count total request rate, not page rate.
  const baseDelay = opts.minDelayMs ?? 1200;
  let lastRequestAt = 0;
  const pace = async (extraMs = 0) => {
    const wait = Math.max(0, lastRequestAt + baseDelay + extraMs - Date.now());
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
  };

  const robots = await loadRobots(origin, opts, log, warnings, pace);
  if (!isAllowed(robots, opts.userAgent, "/")) {
    throw new AppError(
      "crawl_blocked",
      "This site's robots.txt blocks our crawler. Add the business details manually, or allow our user agent.",
      { details: { origin, userAgent: opts.userAgent }, retryable: false },
    );
  }

  // robots.txt may ask for more room than our floor; it never gets less.
  const declaredDelayMs = crawlDelayFor(robots, opts.userAgent) * 1000;
  const extraDelayMs = Math.max(0, declaredDelayMs - baseDelay);

  // Seed the frontier from sitemaps when available (spec §3.1).
  const seen = new Set<string>();
  const frontier: Frontier[] = [];
  const sitemapUrls = await loadSitemapUrls(origin, robots, opts, log, warnings, pace);

  const push = (url: string, depth: number) => {
    let canonical: string;
    try {
      canonical = canonicalizeUrl(url);
    } catch {
      return;
    }
    if (seen.has(canonical)) return;
    if (new URL(canonical).origin !== origin) return;
    if (!isAllowed(robots, opts.userAgent, new URL(canonical).pathname)) return;
    seen.add(canonical);
    frontier.push({ url: canonical, depth, priority: guessPriority(canonical) });
  };

  push(origin + "/", 0);
  for (const u of sitemapUrls) push(u, 1);
  if (sitemapUrls.length === 0) {
    warnings.push("No sitemap.xml found — discovery relies on link following.");
  }

  const pages: CrawledPage[] = [];
  const palettes: BrandColor[][] = [];
  const stylesheetUrls = new Set<string>();
  let logoUrl: string | null = null;
  const collectBrandAssets = (html: string, url: string) => {
    palettes.push(extractBrandColors(html, 8));
    const assets = extractBrandAssetLinks(html, url);
    for (const stylesheetUrl of assets.stylesheetUrls) stylesheetUrls.add(stylesheetUrl);
    if (assets.logoUrl && (!logoUrl || /favicon|(?:^|[\W_])icon(?:[\W_]|$)/i.test(logoUrl))) {
      logoUrl = assets.logoUrl;
    }
  };
  let attempts = 0;
  let lowTextPages = 0;
  // Many sites sit behind a WAF that refuses unknown crawlers outright. That is
  // a different failure from "the URL is wrong", and the customer needs to be
  // told which one it is.
  const refusedStatuses: number[] = [];
  /** Set when a refusal turns out to be a "checking your browser" page. */
  let jsChallenged = false;

  /*
   * Decide once whether rendering is available.
   *
   * Checked here rather than at the moment of need so a service that is down
   * costs one 2s health check for the whole crawl, instead of stalling every
   * blocked page on a connection that will not open.
   */
  const canRender = renderingAvailable(opts.renderServiceUrl)
    ? await renderingHealthy(opts.renderServiceUrl)
    : false;

  if (renderingAvailable(opts.renderServiceUrl) && !canRender) {
    warnings.push(
      "A rendering service is configured but not responding, so JavaScript-rendered pages " +
        "will be skipped.",
    );
  }

  let renderedCount = 0;

  /**
   * Retry one URL through the browser.
   *
   * Returns null on any failure: rendering is a bonus path, and a broken
   * service must degrade to the behaviour we would have had without it rather
   * than failing the crawl.
   */
  const tryRender = async (url: string): Promise<{ html: string; url: string } | null> => {
    if (!canRender || !renderingAvailable(opts.renderServiceUrl)) return null;
    try {
      const rendered = await renderPage(url, {
        serviceUrl: opts.renderServiceUrl,
        timeoutMs: opts.timeoutMs * 2,
      });
      if (!rendered.html || rendered.html.length < 200) return null;
      renderedCount++;
      return { html: rendered.html, url: rendered.url };
    } catch (err) {
      log.debug("Render failed", { url, error: String(err) });
      return null;
    }
  };

  // The budget limits requests attempted, not only successful pages. Counting
  // only successes made a blocked site exhaust its entire sitemap (sometimes
  // hundreds of 403s), which worsened rate limits and kept onboarding waiting.
  while (frontier.length > 0 && attempts < opts.maxPages) {
    // Highest-priority page type first, shallowest depth as tie-break.
    frontier.sort((a, b) => b.priority - a.priority || a.depth - b.depth);
    const next = frontier.shift()!;
    attempts++;

    try {
      await pace(extraDelayMs);
      const res = await guardedFetch(next.url, {
        userAgent: opts.userAgent,
        timeoutMs: opts.timeoutMs,
      });

      if (res.status >= 400) {
        if (res.status === 401 || res.status === 403 || res.status === 429) {
          refusedStatuses.push(res.status);
          /*
           * Distinguish a JavaScript interstitial from an outright refusal.
           *
           * Hostinger, Cloudflare and similar answer a 403 whose body is a
           * "checking your browser" page that redirects once a script runs.
           * That is not a filter we can be allowlisted past — it is a demand
           * for a JavaScript engine, which a static fetcher does not have.
           * Telling the customer to ask for an allowlist would send them after
           * something that cannot help.
           */
          if (JS_CHALLENGE.test(res.body)) {
            jsChallenged = true;

            // Exactly what the browser is for. A challenge page is a demand for
            // a JS engine, and we may now have one.
            const rendered = await tryRender(next.url);
            if (rendered) {
              const parsed = parseHtml(rendered.html, rendered.url);
              pages.push({ ...parsed, url: rendered.url, httpStatus: 200, depth: next.depth });
              collectBrandAssets(rendered.html, rendered.url);
              if (next.depth < opts.maxDepth) {
                for (const link of parsed.internalLinks) push(link, next.depth + 1);
              }
              continue;
            }
          }
        }
        log.debug("Skipping error page", { url: next.url, status: res.status });
        continue;
      }
      if (res.contentType && !/text\/html|application\/xhtml/i.test(res.contentType)) {
        continue;
      }

      let body = res.body;
      let finalUrl = res.url;
      let parsed = parseHtml(body, finalUrl);

      /*
       * A 200 with markup but no text is a client-rendered shell.
       *
       * The status says success, so nothing above catches it — but the page is
       * useless for extraction. Re-reading it through the browser is the only
       * way to see what a visitor sees.
       */
      if (parsed.wordCount < 50 && body.length > 2000) {
        const rendered = await tryRender(finalUrl);
        if (rendered) {
          body = rendered.html;
          finalUrl = rendered.url;
          parsed = parseHtml(body, finalUrl);
        }
      }

      pages.push({ ...parsed, url: finalUrl, httpStatus: res.status, depth: next.depth });
      collectBrandAssets(body, finalUrl);

      /*
       * A page with markup but almost no text is a client-rendered shell.
       *
       * Measured against the body we actually kept, so a page the browser
       * rescued is not still counted as thin — `jsHeavy` is meant to tell the
       * customer "this site needs a renderer", and it would be wrong to say
       * that about pages a renderer already handled.
       */
      if (parsed.wordCount < 50 && body.length > 2000) lowTextPages++;

      if (next.depth < opts.maxDepth) {
        for (const link of parsed.internalLinks) push(link, next.depth + 1);
      }
    } catch (err) {
      if (err instanceof AppError && err.code === "crawl_blocked") {
        log.debug("Blocked URL skipped", { url: next.url, reason: err.code });
        continue;
      }
      log.warn("Page fetch failed", { url: next.url, error: String(err) });
    }

  }

  if (pages.length === 0) {
    if (refusedStatuses.length > 0) {
      const status = refusedStatuses[0]!;
      const rateLimited = status === 429;
      throw new AppError(
        "crawl_blocked",
        jsChallenged
          ? canRender
            ? // The browser ran and still could not get in. That is a harder
              // challenge than a JS interstitial — a CAPTCHA, or a filter that
              // fingerprints headless browsers — and nothing we add fixes it.
              "That website blocks automated visitors, and it still refused us with a real " +
              "browser. Describe the business instead; it takes about a minute."
            : "That website checks every visitor with JavaScript before showing the page. We read " +
              "pages as they are sent, without running scripts, so we cannot get past it. Start " +
              "the rendering service (services/crawler) to read sites like this, or describe the " +
              "business instead — it takes about a minute."
          : rateLimited
            ? "That website is rate limiting our crawler. Try again in a few minutes."
            : `That website refused our crawler (HTTP ${status}). Its robots.txt allows us, so this is ` +
              "a firewall or bot filter rejecting the request, not a problem with the address.",
        {
          details: {
            origin,
            status,
            userAgent: opts.userAgent,
            ...(jsChallenged ? { challenge: "javascript" } : {}),
            remedy: jsChallenged
              ? "enter-manually-or-use-a-renderer"
              : rateLimited
                ? "wait-and-retry"
                : "allowlist-user-agent-or-enter-manually",
          },
          // Rate limiting passes; a bot filter will refuse again on retry.
          retryable: rateLimited,
        },
      );
    }

    throw new AppError(
      "crawl_blocked",
      "We could not read any pages from that website. Check the address, or enter the business details manually.",
      { details: { origin, warnings }, retryable: false },
    );
  }

  const jsHeavy = lowTextPages > 0 && lowTextPages >= pages.length / 2;
  if (jsHeavy) {
    warnings.push(
      "Most pages returned little server-rendered text. This site likely renders with JavaScript; " +
        "extraction quality will be limited until a headless renderer is enabled.",
    );
  }

  if (renderedCount > 0) {
    warnings.push(
      `${renderedCount} page${renderedCount === 1 ? "" : "s"} needed a browser to read.`,
    );
  }

  // Most production sites keep their palette in linked CSS rather than in the
  // document. Read a small bounded set after the page crawl so the colour step
  // receives the actual theme instead of an empty result.
  let stylesheetsRead = 0;
  for (const stylesheetUrl of [...stylesheetUrls].slice(0, 8)) {
    try {
      await pace(extraDelayMs);
      const css = await guardedFetch(stylesheetUrl, {
        userAgent: opts.userAgent,
        timeoutMs: opts.timeoutMs,
        accept: "text/css,*/*;q=0.1",
      });
      if (css.status < 400 && css.body.length <= 1_500_000) {
        palettes.push(extractBrandColors(css.body, 12));
        stylesheetsRead++;
      }
    } catch (err) {
      log.debug("Stylesheet fetch failed", { url: stylesheetUrl, error: String(err) });
    }
  }

  if (stylesheetUrls.size > 0 && stylesheetsRead === 0) {
    warnings.push("The site's stylesheets could not be read, so its palette may be incomplete.");
  }

  const brandColors = mergeBrandColors(palettes, 4);
  if (brandColors.length === 0) {
    warnings.push(
      "No brand colours could be read from the markup — this site most likely keeps its colour " +
        "in an external stylesheet, which we do not fetch.",
    );
  }
  if (!logoUrl) warnings.push("No logo could be identified in the site's header or structured data.");

  /*
   * Read across every page rather than just the home page.
   *
   * The footer is usually identical site-wide, but not always: a site may
   * link Instagram only from an About page, and a home page that failed to
   * fetch would otherwise lose every account. findSocialProfiles keeps the
   * first account per network, and pages are in crawl order, so the home
   * page still wins when it has one.
   */
  const socialProfiles = findSocialProfiles(pages.flatMap((p) => p.externalLinks));

  return {
    origin,
    pages,
    discovered: seen.size,
    robotsAllowed: true,
    sitemapUrls,
    jsHeavy,
    brandColors,
    logoUrl,
    socialProfiles,
    warnings,
  };
}

async function loadRobots(
  origin: string,
  opts: CrawlOptions,
  log: Logger,
  warnings: string[],
  pace: () => Promise<void>,
): Promise<Robots> {
  try {
    await pace();
    const res = await guardedFetch(`${origin}/robots.txt`, {
      userAgent: opts.userAgent,
      timeoutMs: opts.timeoutMs,
      accept: "text/plain",
    });
    // A missing robots.txt means "crawl freely" under the REP.
    if (res.status === 404) return { groups: [], sitemaps: [] };
    if (res.status >= 400) {
      warnings.push(`robots.txt returned HTTP ${res.status}; proceeding with default rules.`);
      return { groups: [], sitemaps: [] };
    }
    return parseRobots(res.body);
  } catch (err) {
    log.debug("robots.txt unavailable", { origin, error: String(err) });
    warnings.push("robots.txt could not be fetched; proceeding with default rules.");
    return { groups: [], sitemaps: [] };
  }
}

async function loadSitemapUrls(
  origin: string,
  robots: Robots,
  opts: CrawlOptions,
  log: Logger,
  warnings: string[],
  pace: () => Promise<void>,
): Promise<string[]> {
  const candidates = robots.sitemaps.length > 0 ? robots.sitemaps : [`${origin}/sitemap.xml`];
  const collected = new Set<string>();

  for (const candidate of candidates.slice(0, 3)) {
    try {
      await pace();
      const res = await guardedFetch(candidate, {
        userAgent: opts.userAgent,
        timeoutMs: opts.timeoutMs,
        accept: "application/xml,text/xml",
      });
      if (res.status >= 400) continue;

      const parsed = parseSitemap(res.body, candidate);
      for (const u of parsed.urls) collected.add(u);

      // One level of sitemap-index expansion is enough for most sites.
      for (const child of parsed.sitemaps.slice(0, 10)) {
        if (collected.size >= opts.maxPages * 3) break;
        try {
          await pace();
          const childRes = await guardedFetch(child, {
            userAgent: opts.userAgent,
            timeoutMs: opts.timeoutMs,
            accept: "application/xml,text/xml",
          });
          if (childRes.status < 400) {
            for (const u of parseSitemap(childRes.body, child).urls) collected.add(u);
          }
        } catch {
          // A broken child sitemap must not abort discovery.
        }
      }
    } catch (err) {
      log.debug("Sitemap unavailable", { candidate, error: String(err) });
      warnings.push(`Sitemap ${candidate} could not be read.`);
    }
  }

  return [...collected];
}

function guessPriority(url: string): number {
  const path = new URL(url).pathname.toLowerCase();
  if (path === "/" || path === "") return PAGE_TYPE_PRIORITY.home;
  if (/\b(service|solutions|what-we-do|treatments)\b/.test(path)) return PAGE_TYPE_PRIORITY.services;
  if (/\b(product|shop|pricing|plans)\b/.test(path)) return PAGE_TYPE_PRIORITY.product;
  if (/\b(about|team|our-story)\b/.test(path)) return PAGE_TYPE_PRIORITY.about;
  if (/\b(location|branch|find-us|store|clinic)\b/.test(path)) return PAGE_TYPE_PRIORITY.location;
  if (/\b(contact|book|appointment)\b/.test(path)) return PAGE_TYPE_PRIORITY.contact;
  if (/\b(faq|help|support)\b/.test(path)) return PAGE_TYPE_PRIORITY.faq;
  if (/\b(privacy|terms|cookie|legal)\b/.test(path)) return PAGE_TYPE_PRIORITY.legal;
  if (/\b(blog|news|article|insights|resources)\b/.test(path)) return PAGE_TYPE_PRIORITY.blog;
  return PAGE_TYPE_PRIORITY.other;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
