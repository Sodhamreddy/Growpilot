export const dynamic = "force-dynamic";

import { AppError, requireRole } from "@ob/core";
import { repo } from "@ob/db";
import { JOBS } from "@ob/jobs";
import { route } from "@/lib/api";
import { db, getQueues } from "@/lib/services";
import { queueReviewSync } from "@/lib/reviews";

export const POST = route(async (ctx) => {
  requireRole(ctx, "editor");
  const business = await repo.getPrimaryBusiness(db(), ctx);
  if (!business?.googleListing) throw new AppError("validation_failed", "Select a client and choose its Google listing first.", { retryable: false });
  return { ok: true, queued: true, jobId: await queueReviewSync(ctx, business.id) };
}, { rateLimit: { limit: 30, windowSeconds: 3600 } });

export const GET = route(async (ctx, req) => {
  const id = new URL(req.url).searchParams.get("jobId");
  if (!id || id.length > 200) throw new AppError("validation_failed", "Choose a review sync job.", { retryable: false });
  const job = await getQueues().get("analytics").getJob(id);
  if (!job || job.name !== JOBS.syncReviews || job.data.workspaceId !== ctx.workspaceId) {
    throw new AppError("not_found", "That review sync is not in this workspace.", { retryable: false });
  }
  const business = await repo.getPrimaryBusiness(db(), ctx);
  if (job.data.businessId !== business?.id) throw new AppError("not_found", "That review sync belongs to another client.", { retryable: false });
  const state = await job.getState();
  return { state, result: state === "completed" ? job.returnvalue : null,
    error: state === "failed" ? "Review sync failed. Check the listing connection and try Sync now again." : null };
});
