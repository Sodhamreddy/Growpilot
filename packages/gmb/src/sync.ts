import { and, eq, inArray, lt } from "drizzle-orm";
import { AppError, open, type TenantContext } from "@ob/core";
import type { Gateway } from "@ob/ai";
import {
  businesses, businessLocations, gmbReviews, integrations, repo,
  type Database, type GoogleListing, type ReviewReplyDraft, type ReviewSource,
} from "@ob/db";
import {
  GoogleApiError, listGbpReviews, placeReviews, refreshGoogleToken, replyToGbpReview, type FetchedReview,
} from "./google.js";
import { draftReviewReply, normaliseReply } from "./reply.js";
import type { ReviewRating } from "./rules.js";

/**
 * Reading reviews into the database, drafting replies, posting them.
 *
 * Shared by the web app ("Sync now", "Draft", "Post") and the worker (the
 * sweep every few hours), so both behave identically.
 */

export const GBP_PROVIDER = "google_business_profile";

/** Places content may be kept no longer than this under Google Maps Platform terms. */
const PLACES_CACHE_DAYS = 30;

export interface GoogleCredentials {
  clientId: string | undefined;
  clientSecret: string | undefined;
  encryptionKey: string;
  /** For the Places API. */
  mapsKey: string | undefined;
}

/** The Google settings this module needs, from the app's config. */
export function googleCredentials(cfg: {
  GOOGLE_GBP_CLIENT_ID?: string; GOOGLE_GBP_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_ADS_CLIENT_ID?: string; GOOGLE_ADS_CLIENT_SECRET?: string;
  GOOGLE_MAPS_API_KEY?: string; GOOGLE_API_KEY?: string;
  CREDENTIAL_ENCRYPTION_KEY: string;
}): GoogleCredentials {
  // A client and its secret go together; never the id of one with the secret of another.
  const pair = cfg.GOOGLE_GBP_CLIENT_ID && cfg.GOOGLE_GBP_CLIENT_SECRET
    ? [cfg.GOOGLE_GBP_CLIENT_ID, cfg.GOOGLE_GBP_CLIENT_SECRET]
    : cfg.GOOGLE_CLIENT_ID && cfg.GOOGLE_CLIENT_SECRET
      ? [cfg.GOOGLE_CLIENT_ID, cfg.GOOGLE_CLIENT_SECRET]
      : [cfg.GOOGLE_ADS_CLIENT_ID, cfg.GOOGLE_ADS_CLIENT_SECRET];
  return {
    clientId: pair[0] || undefined,
    clientSecret: pair[1] || undefined,
    encryptionKey: cfg.CREDENTIAL_ENCRYPTION_KEY,
    // An AI Studio key ("AQ.…") works only for Gemini; only a Cloud key ("AIza…") reaches Places.
    mapsKey: cfg.GOOGLE_MAPS_API_KEY || (cfg.GOOGLE_API_KEY?.startsWith("AIza") ? cfg.GOOGLE_API_KEY : undefined),
  };
}

export interface SealedGoogle { refreshToken: string; email: string | null }

/**
 * A fresh Business Profile access token for this workspace, or null when
 * Google is not connected. Tokens last an hour, so one is made per sync.
 */
export async function gbpAccessToken(db: Database, ctx: TenantContext, creds: GoogleCredentials): Promise<string | null> {
  const [row] = await db
    .select({ status: integrations.status, credentialSealed: integrations.credentialSealed })
    .from(integrations)
    .where(and(eq(integrations.workspaceId, ctx.workspaceId), eq(integrations.provider, GBP_PROVIDER)))
    .limit(1);
  if (!row?.credentialSealed || row.status !== "connected") return null;
  if (!creds.clientId || !creds.clientSecret) {
    throw new GoogleApiError("auth", "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set to use the Google connection.");
  }
  let sealed: SealedGoogle;
  try {
    sealed = JSON.parse(open(row.credentialSealed, creds.encryptionKey)) as SealedGoogle;
  } catch {
    throw new GoogleApiError("auth", "The stored Google connection could not be read. Connect Google again.");
  }
  try {
    return (await refreshGoogleToken(sealed.refreshToken, creds.clientId, creds.clientSecret)).accessToken;
  } catch (err) {
    if (err instanceof GoogleApiError && err.kind === "auth") {
      await db.update(integrations).set({ status: "error", lastError: err.message })
        .where(and(eq(integrations.workspaceId, ctx.workspaceId), eq(integrations.provider, GBP_PROVIDER)));
    }
    throw err;
  }
}

export interface SyncResult {
  source: ReviewSource | null;
  /** Reviews seen for the first time, newest first: the ones worth drafting. */
  added: string[];
  listing: GoogleListing;
}

function withoutReply<T extends { googleReply: unknown }>(values: T): Omit<T, "googleReply"> {
  const { googleReply: _reply, ...rest } = values;
  void _reply;
  return rest;
}

async function saveReviews(
  db: Database, ctx: TenantContext, businessId: string, source: ReviewSource, fetched: FetchedReview[],
): Promise<string[]> {
  if (!fetched.length) return [];
  const existing = new Set((await db
    .select({ externalId: gmbReviews.externalId })
    .from(gmbReviews)
    .where(and(
      eq(gmbReviews.businessId, businessId), eq(gmbReviews.source, source),
      inArray(gmbReviews.externalId, fetched.map((r) => r.externalId)),
    ))).map((r) => r.externalId));

  const now = new Date();
  const added: string[] = [];
  for (const r of fetched) {
    const values = {
      authorName: r.authorName, authorPhotoUrl: r.authorPhotoUrl, authorUrl: r.authorUrl,
      rating: r.rating, comment: r.comment, languageCode: r.languageCode, reviewUrl: r.reviewUrl,
      publishedAt: r.publishedAt, editedAt: r.editedAt, googleReply: r.googleReply,
      syncedAt: now, updatedAt: now,
    };
    const [row] = await db
      .insert(gmbReviews)
      .values({ workspaceId: ctx.workspaceId, businessId, source, externalId: r.externalId, ...values })
      .onConflictDoUpdate({
        target: [gmbReviews.businessId, gmbReviews.source, gmbReviews.externalId],
        // Places cannot see replies, so it never clears one Business Profile or a person recorded.
        set: source === "places" ? withoutReply(values) : values,
      })
      .returning({ id: gmbReviews.id });
    if (row && !existing.has(r.externalId)) added.push(row.id);
  }
  return added;
}

/**
 * Read a client's reviews from the best source available.
 *
 * Business Profile when Google is connected and the listing chosen; if that
 * is refused because access is still pending, Places carries on, and the
 * listing records both outcomes so the page can explain each.
 */
export async function syncReviews(
  db: Database,
  ctx: TenantContext,
  business: { id: string; googleListing: GoogleListing | null },
  creds: GoogleCredentials,
): Promise<SyncResult> {
  let listing: GoogleListing = { ...(business.googleListing ?? {}) };
  let source: ReviewSource | null = null;
  let added: string[] = [];
  let failure: GoogleApiError | null = null;

  if (listing.gbpLocation) {
    try {
      const token = await gbpAccessToken(db, ctx, creds);
      if (!token) {
        listing = { ...listing, gbpStatus: "error", gbpError: "Google is not connected. Connect Google to read every review and post replies." };
      } else {
        const res = await listGbpReviews(token, listing.gbpLocation);
        added = await saveReviews(db, ctx, business.id, "gbp", res.reviews);
        source = "gbp";
        listing = {
          ...listing, gbpStatus: "ok", gbpError: null, source,
          rating: res.averageRating ?? listing.rating ?? null,
          reviewCount: res.totalReviewCount ?? listing.reviewCount ?? null,
        };
      }
    } catch (err) {
      if (!(err instanceof GoogleApiError)) throw err;
      listing = { ...listing, gbpStatus: err.kind === "access_pending" ? "pending" : "error", gbpError: err.message };
      failure = err;
    }
  }

  if (!source && listing.placeId) {
    if (!creds.mapsKey) {
      failure = new GoogleApiError("key", "Add GOOGLE_MAPS_API_KEY to .env (a key with Places API (New) turned on) to read this listing's reviews.");
    } else {
      try {
        const res = await placeReviews(creds.mapsKey, listing.placeId);
        added = await saveReviews(db, ctx, business.id, "places", res.reviews);
        source = "places";
        failure = null;
        listing = {
          ...listing, source,
          title: listing.title || res.place.title,
          mapsUri: res.place.mapsUri ?? listing.mapsUri,
          rating: res.place.rating, reviewCount: res.place.reviewCount,
        };
        // Google's terms: Places content is cached for at most 30 days.
        await db.delete(gmbReviews).where(and(
          eq(gmbReviews.businessId, business.id), eq(gmbReviews.source, "places"),
          lt(gmbReviews.syncedAt, new Date(Date.now() - PLACES_CACHE_DAYS * 86_400_000)),
        ));
      } catch (err) {
        if (!(err instanceof GoogleApiError)) throw err;
        failure = err;
      }
    }
  }

  if (!listing.placeId && !listing.gbpLocation) {
    failure = new GoogleApiError("not_found", "Choose this client's Google listing first.");
  }

  listing = { ...listing, syncedAt: new Date().toISOString(), lastError: source ? null : failure?.message ?? null };
  await db.update(businesses).set({ googleListing: listing, updatedAt: new Date() })
    .where(and(eq(businesses.workspaceId, ctx.workspaceId), eq(businesses.id, business.id)));

  if (!source && failure && !failure.permanent) throw failure;
  return { source, added, listing };
}

/** Draft (or redraft) the reply to one review, and save it. */
export async function draftReplyFor(db: Database, gateway: Gateway, ctx: TenantContext, reviewId: string): Promise<ReviewReplyDraft> {
  const [review] = await db.select().from(gmbReviews)
    .where(and(eq(gmbReviews.workspaceId, ctx.workspaceId), eq(gmbReviews.id, reviewId))).limit(1);
  if (!review) throw new AppError("not_found", "That review is not in this workspace.", { retryable: false });
  if (review.draft?.status === "posted" || review.draft?.status === "posted_by_hand") {
    throw new AppError("conflict", "This reply is already posted.", { retryable: false });
  }
  const business = await repo.getBusiness(db, ctx, review.businessId);
  if (!business) throw new AppError("not_found", "That client no longer exists.", { retryable: false });

  const [facts, voice, [location]] = await Promise.all([
    repo.listFacts(db, ctx, business.id),
    repo.getActiveVoice(db, ctx, business.id),
    db.select({ phone: businessLocations.phone }).from(businessLocations)
      .where(and(eq(businessLocations.workspaceId, ctx.workspaceId), eq(businessLocations.businessId, business.id))).limit(1),
  ]);
  const prompts = (business as { prompts?: { social?: { wordsToAvoid?: string[] } } | null }).prompts;

  const draft = await draftReviewReply(gateway, ctx, {
    business: { name: business.name, industry: business.industry, audience: business.audience, usp: business.usp },
    listingName: business.googleListing?.gbpTitle || business.googleListing?.title || business.gmbName || business.name,
    facts,
    contact: location?.phone ? `phone ${location.phone}` : null,
    voice: voice ? { profile: voice.profile, bannedTerms: voice.bannedTerms, preferredTerms: voice.preferredTerms, samples: voice.samples } : null,
    wordsToAvoid: prompts?.social?.wordsToAvoid ?? [],
    review: { authorName: review.authorName, rating: review.rating as ReviewRating, comment: review.comment, languageCode: review.languageCode },
  });
  await db.update(gmbReviews).set({ draft, updatedAt: new Date() }).where(eq(gmbReviews.id, review.id));
  return draft;
}

/**
 * Post the approved reply to Google, or record that a person posted it.
 *
 * Only Business Profile reviews can be answered through the API. For the rest
 * the page has the person paste it on Google and then mark it posted here.
 */
export async function postReply(
  db: Database, ctx: TenantContext, reviewId: string, body: string, creds: GoogleCredentials,
  { byHand = false }: { byHand?: boolean } = {},
): Promise<{ draft: ReviewReplyDraft; googleReply: { comment: string; updatedAt: string } | null }> {
  const [review] = await db.select().from(gmbReviews)
    .where(and(eq(gmbReviews.workspaceId, ctx.workspaceId), eq(gmbReviews.id, reviewId))).limit(1);
  if (!review) throw new AppError("not_found", "That review is not in this workspace.", { retryable: false });
  const text = normaliseReply(body);
  if (!text) throw new AppError("validation_failed", "Write the reply first.", { retryable: false });

  const now = new Date().toISOString();
  const base: ReviewReplyDraft = review.draft ?? {
    body: text, status: "draft", requiresHumanEdit: false, withheldReason: null, edited: true, createdAt: now, updatedAt: now,
  };
  let googleReply = review.googleReply ?? null;

  if (byHand) {
    googleReply = { comment: text, updatedAt: now };
  } else {
    if (review.source !== "gbp") {
      throw new AppError(
        "conflict",
        "This review was read through the Places API, which cannot post replies. Copy the reply, post it on Google, then mark it posted.",
        { retryable: false },
      );
    }
    const token = await gbpAccessToken(db, ctx, creds);
    if (!token) throw new AppError("conflict", "Connect Google to post replies.", { retryable: false });
    try {
      googleReply = await replyToGbpReview(token, review.externalId, text);
    } catch (err) {
      if (err instanceof GoogleApiError) throw new AppError("provider_error", err.message, { retryable: !err.permanent });
      throw err;
    }
  }

  const draft: ReviewReplyDraft = {
    ...base, body: text, status: byHand ? "posted_by_hand" : "posted", postedAt: now, updatedAt: now, error: null,
  };
  await db.update(gmbReviews).set({ draft, googleReply, updatedAt: new Date() }).where(eq(gmbReviews.id, review.id));
  return { draft, googleReply };
}
