import { and, desc, eq, gte, isNotNull, isNull } from "drizzle-orm";
import { AppError } from "@ob/core";
import { businesses, gmbReviews, type ReviewSource } from "@ob/db";
import { JOBS } from "@ob/jobs";
import { GoogleApiError, draftReplyFor, googleCredentials, syncReviews } from "@ob/gmb";
import type { WorkerContext } from "../../context.js";
import { contextFromPayload } from "../../context.js";

/**
 * Google reviews: a sync per client, and a sweep that keeps every client fresh.
 *
 * New reviews get a reply drafted straight away, so the page opens on work
 * ready to approve rather than on a button to press per review. Only recent,
 * unanswered ones, and a handful per run: a first sync of a listing with four
 * hundred old reviews should not spend four hundred model calls on replies
 * nobody will post.
 */

export interface ReviewsSyncPayload {
  workspaceId: string;
  userId: string;
  correlationId: string;
  businessId: string;
  /** The web app has just synced; only draft replies. */
  draftOnly?: boolean;
  force?: boolean;
}

/** Drafts made per sync; the rest can be drafted from the page, one click each. */
const DRAFTS_PER_SYNC = 10;
/** Older reviews are left to a person to choose to answer. */
const DRAFT_WITHIN_DAYS = 90;
/** How often every client's reviews are read. */
export const SWEEP_CRON = "15 */6 * * *";
export const SWEEP_KEY = "reviews:sweep";

export async function processReviewsSync(wc: WorkerContext, payload: ReviewsSyncPayload) {
  const ctx = contextFromPayload(payload);
  const log = wc.logger.child({ correlationId: ctx.correlationId, workspaceId: ctx.workspaceId, businessId: payload.businessId });

  const [business] = await wc.db
    .select({ id: businesses.id, googleListing: businesses.googleListing })
    .from(businesses)
    .where(and(eq(businesses.workspaceId, ctx.workspaceId), eq(businesses.id, payload.businessId)))
    .limit(1);
  if (!business?.googleListing) return { status: "no_listing" };

  let result: { source: ReviewSource | null; added: string[] };
  try {
    result = payload.draftOnly
      ? { source: business.googleListing.source ?? null, added: [] }
      : await syncReviews(wc.db, ctx, business, googleCredentials(wc.cfg), { force: payload.force ?? false });
  } catch (err) {
    if (err instanceof GoogleApiError) {
      throw new AppError("provider_error", err.message, { retryable: !err.permanent });
    }
    throw err;
  }

  // Draft the newest unanswered ones: those added now, and any left undrafted before.
  const since = new Date(Date.now() - DRAFT_WITHIN_DAYS * 86_400_000);
  const pending = await wc.db
    .select({ id: gmbReviews.id })
    .from(gmbReviews)
    .where(and(
      eq(gmbReviews.workspaceId, ctx.workspaceId),
      eq(gmbReviews.businessId, business.id),
      ...(result.source ? [eq(gmbReviews.source, result.source)] : []),
      isNull(gmbReviews.draft),
      isNull(gmbReviews.googleReply),
      gte(gmbReviews.publishedAt, since),
    ))
    .orderBy(desc(gmbReviews.publishedAt))
    .limit(DRAFTS_PER_SYNC);

  let drafted = 0;
  for (const { id } of pending) {
    try {
      await draftReplyFor(wc.db, wc.gateway, ctx, id);
      drafted++;
    } catch (err) {
      log.warn("Could not draft a review reply", { reviewId: id, error: err instanceof Error ? err.message : String(err) });
      // A spent budget or a rate limit will refuse every draft after this one; anything else is this review's alone.
      if (err instanceof AppError && (err.code === "budget_exceeded" || err.code === "rate_limited")) break;
    }
  }

  log.info("Reviews synced", { source: result.source, added: result.added.length, drafted });
  return { source: result.source, added: result.added.length, drafted };
}

/** Queue a sync for every client that has a Google listing chosen. */
export async function processReviewsSweep(wc: WorkerContext) {
  const rows = await wc.db
    .select({ id: businesses.id, workspaceId: businesses.workspaceId })
    .from(businesses)
    .where(isNotNull(businesses.googleListing));
  const window = Math.floor(Date.now() / (6 * 3600_000));
  for (const b of rows) {
    await wc.queues.enqueue("analytics", JOBS.syncReviews, {
      workspaceId: b.workspaceId, userId: "system", correlationId: `reviews-${b.id.slice(0, 8)}-${window}`, businessId: b.id,
    }, { idempotencyKey: `reviews-sync:${b.id}:${window}` });
  }
  return { queued: rows.length };
}

/** Register the sweep. Safe on every boot: the same key replaces itself. */
export async function scheduleReviewsSweep(wc: WorkerContext): Promise<void> {
  await wc.queues.schedule("maintenance", JOBS.reviewsSweep, {
    workspaceId: "00000000-0000-0000-0000-000000000000",
    userId: "system",
    correlationId: "reviews-sweep",
  }, { key: SWEEP_KEY, cron: SWEEP_CRON });
}
