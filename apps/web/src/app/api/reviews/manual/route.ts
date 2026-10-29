export const dynamic = "force-dynamic";

import { z } from "zod";
import { AppError, requireRole } from "@ob/core";
import { gmbReviews, repo } from "@ob/db";
import { manualReviewId, manualReviewSchema, parseManualReviewsCsv } from "@/lib/manual-reviews";
import { route, parseBody } from "@/lib/api";
import { db } from "@/lib/services";

const schema = z.object({ businessId: z.string().uuid() }).and(z.union([
  z.object({ review: manualReviewSchema }), z.object({ csv: z.string().min(1).max(1_000_000) }),
]));

export const POST = route(async (ctx, req) => {
  requireRole(ctx, "editor");
  const body = await parseBody(req, schema);
  const database = db();
  await repo.getBusiness(database, ctx, body.businessId);
  let reviews;
  try { reviews = "csv" in body ? parseManualReviewsCsv(body.csv) : [body.review]; }
  catch (err) { throw new AppError("validation_failed", err instanceof Error ? err.message : "Invalid CSV.", { retryable: false }); }
  const now = new Date().toISOString();
  const added = await database.insert(gmbReviews).values(reviews.map((review) => ({
    workspaceId: ctx.workspaceId, businessId: body.businessId, source: "manual" as const,
    externalId: manualReviewId(review), authorName: review.authorName, rating: review.rating,
    comment: review.comment || null, publishedAt: new Date(`${review.publishedAt}T00:00:00Z`), reviewUrl: review.reviewUrl || null,
    draft: { body: "", status: "draft" as const, requiresHumanEdit: false, withheldReason: null,
      edited: false, createdAt: now, updatedAt: now },
  }))).onConflictDoNothing({ target: [gmbReviews.businessId, gmbReviews.source, gmbReviews.externalId] })
    .returning({ id: gmbReviews.id });
  await repo.writeAudit(database, ctx, { action: "reviews.manually_added", entityType: "business", entityId: body.businessId,
    after: { added: added.length, skipped: reviews.length - added.length } });
  return { ok: true, added: added.length, skipped: reviews.length - added.length };
}, { rateLimit: { limit: 20, windowSeconds: 3600 } });
