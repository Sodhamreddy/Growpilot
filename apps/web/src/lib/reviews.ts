import type { TenantContext } from "@ob/core";
import { JOBS, payloadFrom } from "@ob/jobs";
import { getQueues } from "./services";

/**
 * Have the worker draft replies to a client's new reviews.
 *
 * Drafting is a model call per review, too slow to hold a request open for;
 * the page shows the reviews at once and the drafts as they land. False when
 * the queue cannot be reached, which leaves each review's own Draft button.
 */
export async function queueReplyDrafts(ctx: TenantContext, businessId: string): Promise<boolean> {
  try {
    await getQueues().enqueue("analytics", JOBS.syncReviews, payloadFrom(ctx, { businessId, draftOnly: true }), {
      /*
       * Unique per request. A shared key (one per minute, say) makes the queue
       * treat a second sync as a duplicate of a finished job and drop it, so
       * reviews read by that sync would never be drafted. Two jobs overlapping
       * cost at most a repeated draft; the worker skips reviews already drafted.
       */
      idempotencyKey: `reviews-draft:${businessId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    });
    return true;
  } catch {
    return false;
  }
}
