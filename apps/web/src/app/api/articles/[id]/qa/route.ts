export const dynamic = "force-dynamic";

import { AppError, requireRole } from "@ob/core";
import { repo } from "@ob/db";
import { JOBS, payloadFrom, QueueRegistry } from "@ob/jobs";
import { assertTransition } from "@ob/pipeline";
import { route } from "@/lib/api";
import { db, getQueues } from "@/lib/services";

/**
 * POST /api/articles/:id/qa  — re-run the quality gates.
 * GET  /api/articles/:id/qa  — read the current verdicts and score breakdown.
 */

export const POST = route(
  async (ctx, req) => {
    requireRole(ctx, "editor");
    const id = articleIdFrom(req);
    const article = await repo.getArticle(db(), ctx, id);
    if (!["draft", "qa", "needs_changes", "awaiting_approval"].includes(article.status)) {
      throw new AppError("conflict", "QA is available for editable drafts. Wait for generation or request changes first.", { retryable: false });
    }
    if (article.status !== "qa") assertTransition(article.status, "qa");

    const queues = getQueues();
    const key = `qa:${id}:v${article.version}`;
    const existing = await queues.get("qa").getJob(QueueRegistry.jobIdFor(key));
    if (existing) {
      const state = await existing.getState();
      // Explicit reruns must not be swallowed by the retained job history.
      // Waiting/active jobs keep their identity so repeated clicks do not duplicate work.
      if (state === "failed" || state === "completed") await existing.retry(state);
      return { ok: true, jobId: existing.id };
    }
    const jobId = await queues.enqueue(
      "qa",
      JOBS.runQualityGates,
      payloadFrom(ctx, { articleId: id, articleVersion: article.version }),
      { idempotencyKey: key },
    );

    return { ok: true, jobId };
  },
  { rateLimit: { limit: 120, windowSeconds: 3600 } },
);

export const GET = route(async (ctx, req) => {
  const id = articleIdFrom(req);
  const database = db();
  const article = await repo.getArticle(database, ctx, id);

  const [gates, score] = await Promise.all([
    repo.listGateResults(database, ctx, id, article.version),
    repo.getScore(database, ctx, id, article.version),
  ]);

  return {
    articleId: id,
    version: article.version,
    status: article.status,
    seoScore: article.seoScore,
    voiceScore: article.voiceScore,
    // The weighted breakdown is what makes the score explainable (spec §7.1).
    scoreBreakdown: score?.components ?? null,
    gates: gates.map((g) => ({
      gate: g.gate,
      verdict: g.verdict,
      score: g.score,
      findings: g.findings,
    })),
  };
});

function articleIdFrom(req: Request): string {
  const segments = new URL(req.url).pathname.split("/");
  return segments[segments.indexOf("articles") + 1] ?? "";
}
