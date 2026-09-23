export const dynamic = "force-dynamic";

import { requireRole } from "@ob/core";
import { repo } from "@ob/db";
import { assertTransition } from "@ob/pipeline";
import { JOBS, payloadFrom } from "@ob/jobs";
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
    assertTransition(article.status, "generating");

    const jobId = await getQueues().enqueue(
      "ai",
      JOBS.generateArticle,
      payloadFrom(ctx, { articleId: id }),
      // One generation per article version in flight at a time.
      { idempotencyKey: `generate:${id}:v${article.version}` },
    );

    return { ok: true, jobId, status: "generating" };
  },
  { rateLimit: { limit: 60, windowSeconds: 3600 } },
);

function articleIdFrom(req: Request): string {
  const segments = new URL(req.url).pathname.split("/");
  return segments[segments.indexOf("articles") + 1] ?? "";
}
