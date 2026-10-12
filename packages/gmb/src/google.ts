/**
 * The two Google APIs that carry reviews.
 *
 * Places API (New): any listing's public rating, review count and at most five
 * reviews, with an API key. Read-only, and it cannot say whether a review was
 * already answered. It is what works before Google approves the other one.
 *
 * Business Profile API: every review of a listing the signed-in person
 * manages, with the replies, and the only way to post a reply. Google keeps
 * it at zero quota for a Cloud project until an access request is approved,
 * which is an application, not a setting; `GoogleApiError.kind` names that
 * case so the page can say it plainly.
 *
 * Both return reviews in one shape, `FetchedReview`, so nothing after this
 * file cares which one a review came from.
 */

type Fetcher = typeof fetch;

/** For tests: send every Google call to a stand-in, as `${root}/${host}${path}`. */
const ROOT = process.env.GOOGLE_API_ROOT_OVERRIDE?.trim().replace(/\/+$/, "");
const url = (host: string, path: string) => (ROOT ? `${ROOT}/${host}${path}` : `https://${host}${path}`);

export const GBP_SCOPE = "https://www.googleapis.com/auth/business.manage";

export type GoogleErrorKind =
  | "access_pending" | "api_disabled" | "billing" | "key" | "auth" | "forbidden" | "not_found" | "rate" | "other";

export class GoogleApiError extends Error {
  readonly kind: GoogleErrorKind;
  /** Waiting will not fix it; a person has to. */
  readonly permanent: boolean;
  constructor(kind: GoogleErrorKind, message: string) {
    super(message);
    this.name = "GoogleApiError";
    this.kind = kind;
    this.permanent = kind !== "rate" && kind !== "other";
  }
}

export interface PlaceSummary {
  placeId: string;
  title: string;
  address: string | null;
  mapsUri: string | null;
  rating: number | null;
  reviewCount: number | null;
}

/** One review, whichever API it came from. */
export interface FetchedReview {
  externalId: string;
  authorName: string;
  authorPhotoUrl: string | null;
  authorUrl: string | null;
  rating: 1 | 2 | 3 | 4 | 5;
  comment: string | null;
  languageCode: string | null;
  reviewUrl: string | null;
  publishedAt: Date;
  editedAt: Date | null;
  /** The reply on Google. Null from Places, which cannot see replies. */
  googleReply: { comment: string; updatedAt: string } | null;
}

export interface GbpLocation {
  /** "accounts/1/locations/2", the name the reviews API uses. */
  name: string;
  title: string;
  address: string | null;
  placeId: string | null;
  mapsUri: string | null;
}

// ─── Errors ──────────────────────────────────────────────────────────────────

interface GoogleErrorBody {
  error?: {
    code?: number;
    status?: string;
    message?: string;
    details?: { reason?: string; metadata?: Record<string, string>; violations?: unknown[] }[];
  } | string;
  error_description?: string;
}

/**
 * Google's failure, as what to do about it.
 *
 * `api` says which API was called, because the same status means different
 * things: PERMISSION_DENIED from Places is usually a key or billing problem,
 * from Business Profile it is usually an account that does not manage the
 * listing.
 */
export function describeGoogleError(status: number, body: unknown, api: "places" | "gbp" | "oauth"): GoogleApiError {
  const b = (body ?? {}) as GoogleErrorBody;
  if (typeof b.error === "string") {
    // OAuth endpoints answer in their own shape.
    return b.error === "invalid_grant"
      ? new GoogleApiError("auth", "The Google connection has expired or was revoked. Connect Google again.")
      : new GoogleApiError("auth", `Google refused the sign-in: ${b.error_description ?? b.error}.`);
  }
  const e = b.error ?? {};
  const reasons = (e.details ?? []).map((d) => d.reason ?? "").filter(Boolean);
  const message = e.message ?? "";
  const quotaZero = /limit:\s*0\b/i.test(message)
    || (e.details ?? []).some((d) => d.metadata?.["quota_limit_value"] === "0");

  if (api === "places" && (reasons.includes("CREDENTIALS_MISSING") || /API keys are not supported/i.test(message))) {
    return new GoogleApiError("key", "This key cannot be used for Google Maps. Create a standard API key (it starts with AIza) in Google Cloud Console, turn on Places API (New) for it, and put it in GOOGLE_MAPS_API_KEY.");
  }
  if (status === 401 || e.status === "UNAUTHENTICATED") {
    return api === "places"
      ? new GoogleApiError("key", "Google rejected the API key. Check GOOGLE_MAPS_API_KEY in .env.")
      : new GoogleApiError("auth", "The Google connection has expired. Connect Google again.");
  }
  if (reasons.includes("SERVICE_DISABLED") || /has not been used in project|it is disabled/i.test(message)) {
    return new GoogleApiError(
      "api_disabled",
      api === "places"
        ? "Places API (New) is not turned on for this key's Google Cloud project. Turn it on in Google Cloud Console → APIs & Services."
        : "The Business Profile APIs are not turned on for this Google Cloud project. Turn on My Business Account Management API, My Business Business Information API and Google My Business API.",
    );
  }
  if (reasons.includes("BILLING_DISABLED") || /billing/i.test(message)) {
    return new GoogleApiError("billing", "Google needs billing turned on for this Cloud project before it answers. Add a billing account in Google Cloud Console.");
  }
  if (reasons.includes("API_KEY_INVALID") || /API key not valid/i.test(message)) {
    return new GoogleApiError("key", "Google says the API key is not valid. Check GOOGLE_MAPS_API_KEY in .env.");
  }
  if (reasons.includes("API_KEY_SERVICE_BLOCKED") || /are blocked/i.test(message)) {
    return new GoogleApiError("key", "This API key is restricted to other APIs. Allow Places API (New) for it in Google Cloud Console → Credentials, or use a separate key.");
  }
  if (status === 429 || e.status === "RESOURCE_EXHAUSTED") {
    return api === "gbp" && quotaZero
      ? new GoogleApiError(
          "access_pending",
          "Google has not approved Business Profile API access for this Cloud project yet, so its quota is zero. Apply with Google's access request form; until then reviews come from the Places API.",
        )
      : new GoogleApiError("rate", "Google is limiting requests. It will be tried again shortly.");
  }
  if (status === 404 || e.status === "NOT_FOUND") {
    return new GoogleApiError("not_found", api === "places"
      ? "Google could not find that listing. Search for it again."
      : "Google could not find that listing or review. Choose the listing again.");
  }
  if (status === 403 || e.status === "PERMISSION_DENIED") {
    return new GoogleApiError("forbidden", api === "gbp"
      ? "Google says this Google account cannot manage that listing. Connect with an account that owns or manages it."
      : `Google refused the request${message ? `: ${message}` : "."}`);
  }
  if (status >= 500) return new GoogleApiError("other", "Google had a temporary problem. It will be tried again shortly.");
  return new GoogleApiError("other", message ? `Google refused the request: ${message}` : "Google refused the request.");
}

async function call<T>(
  api: "places" | "gbp" | "oauth",
  target: string,
  init: RequestInit,
  fetcher: Fetcher,
): Promise<T> {
  let res: Response;
  try {
    res = await fetcher(target, { ...init, signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new GoogleApiError("other", "Google could not be reached. It will be tried again shortly.");
  }
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) throw describeGoogleError(res.status, body, api);
  return body as T;
}

const clampRating = (n: number): FetchedReview["rating"] => Math.min(5, Math.max(1, Math.round(n))) as FetchedReview["rating"];
const dateOr = (s: string | undefined, fallback: Date) => (s && !Number.isNaN(Date.parse(s)) ? new Date(s) : fallback);

// ─── Places API (New) ────────────────────────────────────────────────────────

interface RawPlace {
  id: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  googleMapsUri?: string;
  rating?: number;
  userRatingCount?: number;
  reviews?: {
    name: string;
    rating?: number;
    text?: { text?: string; languageCode?: string };
    originalText?: { text?: string; languageCode?: string };
    authorAttribution?: { displayName?: string; uri?: string; photoUri?: string };
    publishTime?: string;
    googleMapsUri?: string;
  }[];
}

const SUMMARY_FIELDS = "id,displayName,formattedAddress,googleMapsUri,rating,userRatingCount";

function summary(p: RawPlace): PlaceSummary {
  return {
    placeId: p.id,
    title: p.displayName?.text ?? "",
    address: p.formattedAddress ?? null,
    mapsUri: p.googleMapsUri ?? null,
    rating: typeof p.rating === "number" ? p.rating : null,
    reviewCount: typeof p.userRatingCount === "number" ? p.userRatingCount : null,
  };
}

/** Listings matching a name and address, for a person to pick theirs from. */
export async function searchPlaces(apiKey: string, query: string, fetcher: Fetcher = fetch): Promise<PlaceSummary[]> {
  const body = await call<{ places?: RawPlace[] }>("places", url("places.googleapis.com", "/v1/places:searchText"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": SUMMARY_FIELDS.split(",").map((f) => `places.${f}`).join(","),
    },
    body: JSON.stringify({ textQuery: query, pageSize: 5 }),
  }, fetcher);
  return (body.places ?? []).map(summary);
}

/**
 * A listing's totals and its latest reviews, at most five: all Places gives.
 *
 * The original wording is kept over Google's translation, so a reply is
 * written to what the person actually said, in their language.
 */
export async function placeReviews(
  apiKey: string,
  placeId: string,
  fetcher: Fetcher = fetch,
): Promise<{ place: PlaceSummary; reviews: FetchedReview[] }> {
  const p = await call<RawPlace>("places", url("places.googleapis.com", `/v1/places/${encodeURIComponent(placeId)}`), {
    headers: { "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": `${SUMMARY_FIELDS},reviews` },
  }, fetcher);
  const now = new Date();
  return {
    place: summary(p),
    reviews: (p.reviews ?? []).map((r) => {
      const text = r.originalText?.text ?? r.text?.text ?? "";
      return {
        externalId: r.name,
        authorName: r.authorAttribution?.displayName ?? "A Google user",
        authorPhotoUrl: r.authorAttribution?.photoUri ?? null,
        authorUrl: r.authorAttribution?.uri ?? null,
        rating: clampRating(r.rating ?? 5),
        comment: text.trim() ? text.trim() : null,
        languageCode: r.originalText?.languageCode ?? r.text?.languageCode ?? null,
        reviewUrl: r.googleMapsUri ?? null,
        publishedAt: dateOr(r.publishTime, now),
        editedAt: null,
        googleReply: null,
      };
    }),
  };
}

// ─── Google sign-in for Business Profile ─────────────────────────────────────

export interface GoogleTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  scopes: string[];
  email: string | null;
}

function tokens(body: { access_token: string; refresh_token?: string; expires_in?: number; scope?: string; id_token?: string }): GoogleTokens {
  let email: string | null = null;
  // The ID token came straight from Google's token endpoint over TLS, so its claims are read, not verified again.
  try {
    const payload = body.id_token?.split(".")[1];
    if (payload) email = (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { email?: string }).email ?? null;
  } catch { /* no email, not a failure */ }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    scopes: (body.scope ?? "").split(/\s+/).filter(Boolean),
    email,
  };
}

export async function exchangeGoogleCode(
  code: string, clientId: string, clientSecret: string, redirectUri: string, fetcher: Fetcher = fetch,
): Promise<GoogleTokens> {
  const body = await call<Parameters<typeof tokens>[0]>("oauth", url("oauth2.googleapis.com", "/token"), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" }),
  }, fetcher);
  return tokens(body);
}

export async function refreshGoogleToken(
  refreshToken: string, clientId: string, clientSecret: string, fetcher: Fetcher = fetch,
): Promise<GoogleTokens> {
  const body = await call<Parameters<typeof tokens>[0]>("oauth", url("oauth2.googleapis.com", "/token"), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token" }),
  }, fetcher);
  return { ...tokens(body), refreshToken };
}

// ─── Business Profile API ────────────────────────────────────────────────────

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Every listing the signed-in person manages, across their accounts. */
export async function listGbpLocations(accessToken: string, fetcher: Fetcher = fetch): Promise<GbpLocation[]> {
  const accounts = await call<{ accounts?: { name: string }[] }>(
    "gbp", url("mybusinessaccountmanagement.googleapis.com", "/v1/accounts?pageSize=20"), { headers: bearer(accessToken) }, fetcher,
  );
  const out: GbpLocation[] = [];
  for (const account of (accounts.accounts ?? []).slice(0, 20)) {
    let pageToken = "";
    for (let page = 0; page < 5; page++) {
      const q = new URLSearchParams({ readMask: "name,title,storefrontAddress,metadata", pageSize: "100", ...(pageToken ? { pageToken } : {}) });
      const res = await call<{
        locations?: {
          name: string; title?: string;
          storefrontAddress?: { addressLines?: string[]; locality?: string; administrativeArea?: string };
          metadata?: { placeId?: string; mapsUri?: string };
        }[];
        nextPageToken?: string;
      }>("gbp", url("mybusinessbusinessinformation.googleapis.com", `/v1/${account.name}/locations?${q}`), { headers: bearer(accessToken) }, fetcher);
      for (const l of res.locations ?? []) {
        const a = l.storefrontAddress;
        out.push({
          // v1 names a location "locations/2"; the reviews API wants it under its account.
          name: `${account.name}/${l.name}`,
          title: l.title ?? "",
          address: a ? [...(a.addressLines ?? []), a.locality, a.administrativeArea].filter(Boolean).join(", ") || null : null,
          placeId: l.metadata?.placeId ?? null,
          mapsUri: l.metadata?.mapsUri ?? null,
        });
      }
      if (!res.nextPageToken) break;
      pageToken = res.nextPageToken;
    }
  }
  return out;
}

const STARS: Record<string, FetchedReview["rating"]> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

/** A listing's reviews, newest first, up to `maxReviews`. */
export async function listGbpReviews(
  accessToken: string,
  location: string,
  { maxReviews = 200, fetcher = fetch }: { maxReviews?: number; fetcher?: Fetcher } = {},
): Promise<{ reviews: FetchedReview[]; averageRating: number | null; totalReviewCount: number | null }> {
  const reviews: FetchedReview[] = [];
  let averageRating: number | null = null;
  let totalReviewCount: number | null = null;
  let pageToken = "";
  const now = new Date();
  while (reviews.length < maxReviews) {
    const q = new URLSearchParams({ pageSize: "50", orderBy: "updateTime desc", ...(pageToken ? { pageToken } : {}) });
    const res = await call<{
      reviews?: {
        name: string; starRating?: string; comment?: string; createTime?: string; updateTime?: string;
        reviewer?: { displayName?: string; profilePhotoUrl?: string; isAnonymous?: boolean };
        reviewReply?: { comment?: string; updateTime?: string };
      }[];
      averageRating?: number; totalReviewCount?: number; nextPageToken?: string;
    }>("gbp", url("mybusiness.googleapis.com", `/v4/${location}/reviews?${q}`), { headers: bearer(accessToken) }, fetcher);
    averageRating ??= typeof res.averageRating === "number" ? res.averageRating : null;
    totalReviewCount ??= typeof res.totalReviewCount === "number" ? res.totalReviewCount : null;
    for (const r of res.reviews ?? []) {
      const published = dateOr(r.createTime, now);
      const updated = dateOr(r.updateTime, published);
      reviews.push({
        externalId: r.name,
        authorName: r.reviewer?.isAnonymous ? "A Google user" : r.reviewer?.displayName ?? "A Google user",
        authorPhotoUrl: r.reviewer?.profilePhotoUrl ?? null,
        authorUrl: null,
        rating: STARS[r.starRating ?? ""] ?? 5,
        comment: r.comment?.trim() ? r.comment.trim() : null,
        languageCode: null,
        reviewUrl: null,
        publishedAt: published,
        editedAt: updated.getTime() - published.getTime() > 60_000 ? updated : null,
        googleReply: r.reviewReply?.comment
          ? { comment: r.reviewReply.comment, updatedAt: r.reviewReply.updateTime ?? now.toISOString() }
          : null,
      });
    }
    if (!res.nextPageToken) break;
    pageToken = res.nextPageToken;
  }
  return { reviews: reviews.slice(0, maxReviews), averageRating, totalReviewCount };
}

/** Post, or replace, the owner's reply to a review. */
export async function replyToGbpReview(
  accessToken: string, reviewName: string, comment: string, fetcher: Fetcher = fetch,
): Promise<{ comment: string; updatedAt: string }> {
  const res = await call<{ comment?: string; updateTime?: string }>("gbp", url("mybusiness.googleapis.com", `/v4/${reviewName}/reply`), {
    method: "PUT",
    headers: { ...bearer(accessToken), "Content-Type": "application/json" },
    body: JSON.stringify({ comment }),
  }, fetcher);
  return { comment: res.comment ?? comment, updatedAt: res.updateTime ?? new Date().toISOString() };
}

// ─── Public Google Maps page, through the browser crawler ────────────────────

/** Whether a link is a Google Maps address the crawler will open. */
export function isMapsLink(link: string): boolean {
  try {
    const u = new URL(link.trim());
    const host = u.hostname.toLowerCase();
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    if (host === "maps.app.goo.gl") return true;
    if (host === "goo.gl") return u.pathname.startsWith("/maps");
    if (/^maps\.google\.[a-z.]{2,6}$/.test(host)) return true;
    return /^(www\.)?google\.[a-z.]{2,6}$/.test(host) && u.pathname.startsWith("/maps");
  } catch {
    return false;
  }
}

/**
 * A listing's newest reviews, read from its public Maps page by the crawler
 * service (services/crawler). Used only when no Google API is available.
 * Maps shows relative dates ("3 weeks ago"), so dates are approximate.
 */
export async function mapsReviews(
  crawlerUrl: string,
  link: string,
  { limit = 50, fetcher = fetch }: { limit?: number; fetcher?: Fetcher } = {},
): Promise<{ place: { title: string | null; rating: number | null; reviewCount: number | null; url: string | null }; reviews: FetchedReview[] }> {
  let res: Response;
  try {
    res = await fetcher(`${crawlerUrl.replace(/\/+$/, "")}/maps/reviews`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: link, limit }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new GoogleApiError("other", "The browser crawler is not running, so the Maps page could not be read. Start it (it runs with npm run dev once set up).");
  }
  const body = (await res.json().catch(() => ({}))) as {
    error?: string; blocked?: boolean; title?: string | null; rating?: number | null; count?: number | null; url?: string | null;
    reviews?: { id: string; author: string; authorUrl: string | null; photo: string | null; rating: number; text: string | null; reply: string | null; publishedAt: string | null }[];
  };
  if (!res.ok) {
    if (res.status === 429 || body.blocked) throw new GoogleApiError("rate", body.error ?? "Google is showing a traffic check. It will be tried again later.");
    throw new GoogleApiError(res.status === 422 ? "not_found" : "other", body.error ?? "Google Maps could not be read.");
  }
  const now = new Date();
  return {
    place: { title: body.title ?? null, rating: body.rating ?? null, reviewCount: body.count ?? null, url: body.url ?? null },
    reviews: (body.reviews ?? []).map((r) => ({
      externalId: `maps:${r.id}`,
      authorName: r.author || "A Google user",
      authorPhotoUrl: r.photo,
      authorUrl: r.authorUrl,
      rating: clampRating(r.rating),
      comment: r.text,
      languageCode: null,
      reviewUrl: null,
      publishedAt: r.publishedAt ? new Date(r.publishedAt) : now,
      editedAt: null,
      googleReply: r.reply ? { comment: r.reply, updatedAt: now.toISOString() } : null,
    })),
  };
}
