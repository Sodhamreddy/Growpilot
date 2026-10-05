export const dynamic = "force-dynamic";

import { AppError, config, requireRole } from "@ob/core";
import { repo } from "@ob/db";
import { GoogleApiError, googleCredentials, syncReviews } from "@ob/gmb";
import { route } from "@/lib/api";
import { db } from "@/lib/services";
import { queueReplyDrafts } from "@/lib/reviews";

/**
 * POST /api/reviews/sync — read the current client's reviews now.
 *
 * The worker does this every six hours on its own; this is the button for
 * when someone has just had a review and wants to answer it.
 */
export const POST = route(
  async (ctx) => {
    requireRole(ctx, "editor");
    const database = db();
    const business = await repo.getPrimaryBusiness(database, ctx);
    if (!business) throw new AppError("validation_failed", "Select a client first.", { retryable: false });
    if (!business.googleListing) throw new AppError("validation_failed", "Choose this client's Google listing first.", { retryable: false });

    let result;
    try {
      result = await syncReviews(database, ctx, { id: business.id, googleListing: business.googleListing }, googleCredentials(config()));
    } catch (err) {
      if (err instanceof GoogleApiError) throw new AppError("provider_error", err.message, { retryable: !err.permanent });
      throw err;
    }
    const drafting = result.source ? await queueReplyDrafts(ctx, business.id) : false;
    return { ok: true, source: result.source, added: result.added.length, listing: result.listing, drafting };
  },
  // Each sync is a paid Google call.
  { rateLimit: { limit: 30, windowSeconds: 3600 } },
);
