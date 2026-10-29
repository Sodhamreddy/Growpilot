export const dynamic = "force-dynamic";

import { AppError, requireRole } from "@ob/core";
import { repo } from "@ob/db";
import { assertTransition } from "@ob/pipeline";
import { JOBS, payloadFrom, QueueRegistry } from "@ob/jobs";
import { route } from "@/lib/api";
import { db, getQueues } from "@/lib/services";

/**
 * POST /api/articles/:id/generate — spec §14.
 *
 * Validates the transition synchronously so the caller gets an immediate,
 * readable error, then hands the work to the ai queue.
 */
export const POST = route(
  async (ctx, req) => {
    requireRole(ctx, "editor");
    const id = articleIdFrom(req);
    const article = await repo.getArticle(db(), ctx, id);

    // Fail fast and legibly rather than letting the worker reject it later.
    if (article.status !== "generating") assertTransition(article.status, "generating");

    const queues = getQueues();
    const key = `generate:${id}:v${article.version}`;
    const existing = await queues.get("ai").getJob(QueueRegistry.jobIdFor(key));
    if (existing) {
      const state = await existing.getState();
      if (state === "failed" || state === "completed") {
        if (article.status === "generating") {
          throw new AppError("conflict", "This article is still marked as being written. Refresh its status before retrying.", { retryable: false });
        }
        try {
          await existing.retry(state);
        } catch (error) {
          // Another explicit click may already have moved the same retained
          // job to waiting. Share it instead of starting another generation.
          const current = await existing.getState();
          if (!["waiting", "active", "delayed", "prioritized"].includes(current)) throw error;
        }
      }
      return { ok: true, jobId: existing.id, status: "generating" };
    }
    // A running article without a retained queue job is not safely restartable
    // here; its worker may still be writing. Normal stale-work recovery applies.
    assertTransition(article.status, "generating");

    const jobId = await queues.enqueue(
      "ai",
      JOBS.generateArticle,
      payloadFrom(ctx, { articleId: id }),
      // One generation per article version in flight at a time.
      { idempotencyKey: key },
    );

    return { ok: true, jobId, status: "generating" };
  },
  { rateLimit: { limit: 60, windowSeconds: 3600 } },
);

/** Track explicit retry outcomes even when a fast failure leaves the same article status. */
export const GET = route(async (ctx, req) => {
  const id = articleIdFrom(req);
  await repo.getArticle(db(), ctx, id);
  const jobId = new URL(req.url).searchParams.get("jobId");
  if (!jobId || jobId.length > 200) throw new AppError("validation_failed", "Choose an article writing task.");
  const job = await getQueues().get("ai").getJob(jobId);
  if (!job || job.name !== JOBS.generateArticle || job.data.workspaceId !== ctx.workspaceId || job.data.articleId !== id) {
    throw new AppError("not_found", "This writing task does not belong to this article.");
  }
  const state = await job.getState();
  return { state, error: state === "failed" ? "Writing failed. Check background processing and try again." : null };
});

function articleIdFrom(req: Request): string {
  const segments = new URL(req.url).pathname.split("/");
  return segments[segments.indexOf("articles") + 1] ?? "";
}
