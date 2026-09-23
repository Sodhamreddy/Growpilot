/**
 * Reading a listing's public rating and review count from Google Maps.
 *
 * What this is: a parser over already-fetched HTML. It takes markup and
 * returns numbers. It does no fetching, holds no state and knows nothing about
 * browsers — so it is fully testable against fixtures, which matters more here
 * than anywhere else in the codebase, because the input changes without
 * warning.
 *
 * ── Why Maps and not Search ──
 *
 * Google Search returns a CAPTCHA to headless Chromium on the very first
 * request, whatever user agent it carries. That was verified against the live
 * site, not assumed: a plain Chrome string got the same "unusual traffic from
 * your computer network" page as the honest bot string did. Maps serves the
 * same listing and does not block, so that is what this reads.
 *
 * ── A caution worth keeping in the file ──
 *
 * Automated access is against Google's Terms of Service, and this path
 * deliberately bypasses the robots.txt check that @ob/seo applies to every
 * other host, so the exemption is explicit rather than accidental. Two
 * consequences the design takes seriously:
 *
 *   - The markup is unversioned and changes without notice. Every field is
 *     therefore optional, and a parse that finds nothing returns nulls rather
 *     than guesses. A stale-but-true "47" beats a confident "0".
 *   - Blocks can return at any time. `looksBlocked` names that case so the
 *     caller records "blocked" instead of storing a zero, which would read as
 *     a business having lost all its reviews.
 *
 * The official Places API returns the same two numbers under a licence. It
 * would replace the fetching only; this parser and its tests would stay.
 */

export interface ListingStats {
  /** Average star rating, 0–5. Null when it could not be read. */
  rating: number | null;
  /** Total Google reviews. Null when it could not be read. */
  reviewCount: number | null;
  /** The listing title as Google shows it, for confirming the right business. */
  title: string | null;
  /** True when the response was a consent wall, CAPTCHA or block page. */
  blocked: boolean;
}

/**
 * Markers of a block, consent wall or CAPTCHA.
 *
 * Checked before parsing, because these pages are valid HTML that simply
 * contain no listing: parsing them succeeds and yields nulls, which is
 * indistinguishable from "this business has no reviews" unless it is named.
 */
const BLOCKED = [
  /unusual traffic from your computer network/i,
  /our systems have detected/i,
  /\/sorry\/index/i,
  /recaptcha/i,
  /id="captcha/i,
  /before you continue to google/i,
  /consent\.google\.com/i,
];

export function looksBlocked(html: string): boolean {
  return BLOCKED.some((re) => re.test(html));
}

/** Strip tags and decode the entities Google actually emits. */
function toText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/** "1,234" and "1 234" are both 1234. Rejects anything that is not a count. */
function toInt(raw: string): number | null {
  const n = Number(raw.replace(/[,\s ]/g, ""));
  return Number.isInteger(n) && n >= 0 && n < 10_000_000 ? n : null;
}

/**
 * The rating and its review count, read as one pair.
 *
 * The Maps place panel puts them adjacent:
 *
 *     <div class="fontDisplayLarge">4.5</div>
 *     <button ...><div ...><span>47 reviews</span></div></button>
 *
 * The pairing matters more than either half. A Maps result carries the
 * surrounding map too, so the page for one pharmacy also contains "11 reviews"
 * and "3.2" belonging to neighbouring businesses. Taking the first rating and
 * the first count independently reports somebody else's numbers — confidently,
 * and with nothing on screen to say so. Anchoring on the rating and reading
 * the count that follows keeps both from the listing the URL asked for.
 */
const PANEL =
  /fontDisplayLarge[^>]*>\s*([0-5](?:[.,]\d)?)\s*<\/div>[\s\S]{0,400}?>\s*([\d,\s ]+)\s*reviews?\s*</i;

/** Fallbacks, for a layout the pair above does not match. */
const COUNT_PATTERNS: RegExp[] = [
  /([\d,\s ]+)\s*Google\s*reviews?/i,
  /\(\s*([\d,\s ]+)\s*\)\s*(?:reviews?)?/i,
];

const RATING_PATTERNS: RegExp[] = [
  /Rated\s*([\d.]+)\s*out of 5/i,
  /\b([0-5](?:[.,]\d)?)\s*(?=[\d,\s ]*\s*Google\s*reviews?)/i,
];

function firstMatch(text: string, patterns: RegExp[]): string | null {
  for (const re of patterns) {
    const m = re.exec(text);
    if (m?.[1]) return m[1];
  }
  return null;
}

/**
 * Parse a fetched Maps page.
 *
 * Every field is independent: a page that yields a count but no rating returns
 * the count. Partial truth is more useful than an all-or-nothing failure, and
 * the caller stores only what it got.
 */
export function parseListing(html: string): ListingStats {
  if (looksBlocked(html)) {
    return { rating: null, reviewCount: null, title: null, blocked: true };
  }

  /*
   * The paired read runs against raw HTML rather than stripped text, because
   * the class name that anchors it is an attribute and does not survive tag
   * removal. Only the fallbacks work on text.
   */
  const paired = PANEL.exec(html);
  const text = toText(html);

  const rawRating = paired?.[1] ?? firstMatch(text, RATING_PATTERNS);
  const rating = rawRating != null ? Number(rawRating.replace(",", ".")) : null;

  const rawCount = paired?.[2] ?? firstMatch(text, COUNT_PATTERNS);
  const reviewCount = rawCount != null ? toInt(rawCount) : null;

  // The <title> confirms which business was matched. Google appends its own
  // suffix, which is noise for a name a person is meant to recognise.
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch?.[1]
    ? toText(titleMatch[1]).replace(/\s*[-–—]\s*Google\s*(Search|Maps)\s*$/i, "").trim() || null
    : null;

  return {
    rating: rating !== null && rating >= 0 && rating <= 5 ? rating : null,
    reviewCount,
    title,
    blocked: false,
  };
}

/**
 * The Maps URL for a listing.
 *
 * Built from the name and address on file rather than a stored place id,
 * because none is recorded. The street address is included when known: a
 * name-and-city query can land on a different branch of the same chain, and
 * the address is what makes the match specific.
 *
 * `hl` and `gl` are pinned so the wording the patterns above match does not
 * change with the server's location. An unpinned request can come back in
 * another language, where "reviews" is a different word and every pattern
 * misses — silently, returning nulls that look like a business with no
 * reviews.
 */
export function listingSearchUrl(parts: {
  name: string;
  streetAddress?: string | null;
  locality?: string | null;
  region?: string | null;
}): string {
  const query = [parts.name, parts.streetAddress, parts.locality, parts.region]
    .map((p) => p?.trim())
    .filter(Boolean)
    .join(" ");
  const url = new URL(`https://www.google.com/maps/search/${encodeURIComponent(query)}`);
  url.searchParams.set("hl", "en");
  url.searchParams.set("gl", "us");
  return url.toString();
}
