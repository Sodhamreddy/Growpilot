export const dynamic = "force-dynamic";

import { requireRole } from "@ob/core";
import { repo } from "@ob/db";
import { JOBS, payloadFrom } from "@ob/jobs";
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

    const jobId = await getQueues().enqueue(
      "qa",
      JOBS.runQualityGates,
      payloadFrom(ctx, { articleId: id }),
      { idempotencyKey: `qa:${id}:v${article.version}` },
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
