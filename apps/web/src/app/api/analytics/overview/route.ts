export const dynamic = "force-dynamic";

import { sql, eq, and, gte } from "drizzle-orm";
import { metricSnapshots, articles, aiJobs } from "@ob/db";
import { route } from "@/lib/api";
import { db } from "@/lib/services";

/**
 * GET /api/analytics/overview — spec §16.
 *
 * Search Console, GA4 and rank-tracker ingestion are not wired in this phase
 * (see README, "Not built yet"), so `metric_snapshots` stays empty until a
 * connector fills it. This endpoint returns the real shape with real counts and
 * reports an empty `sources` list rather than inventing traffic figures.
 */
export const GET = route(async (ctx, req) => {
  const days = Math.min(365, Math.max(1, Number(new URL(req.url).searchParams.get("days") ?? 30)));
  const since = new Date(Date.now() - days * 24 * 3600 * 1000);
  const database = db();

  const [metrics, sources, publishedCount, aiSpend] = await Promise.all([
    database
      .select({
        metric: metricSnapshots.metric,
        total: sql<string>`sum(${metricSnapshots.value})`,
        points: sql<string>`count(*)`,
      })
      .from(metricSnapshots)
      .where(and(eq(metricSnapshots.workspaceId, ctx.workspaceId), gte(metricSnapshots.date, since)))
      .groupBy(metricSnapshots.metric),
    database
      .selectDistinct({ source: metricSnapshots.source })
      .from(metricSnapshots)
      .where(eq(metricSnapshots.workspaceId, ctx.workspaceId)),
    database
      .select({ count: sql<string>`count(*)` })
      .from(articles)
      .where(and(eq(articles.workspaceId, ctx.workspaceId), eq(articles.status, "published"))),
    database
      .select({ costMicros: sql<string>`coalesce(sum(${aiJobs.costMicros}), 0)` })
      .from(aiJobs)
      .where(and(eq(aiJobs.workspaceId, ctx.workspaceId), gte(aiJobs.startedAt, since))),
  ]);

  return {
    periodDays: days,
    sources: sources.map((s) => s.source),
    metrics: metrics.map((m) => ({
      metric: m.metric,
      total: Number(m.total),
      dataPoints: Number(m.points),
    })),
    publishing: { publishedArticles: Number(publishedCount[0]?.count ?? 0) },
    aiCostUsd: Number(aiSpend[0]?.costMicros ?? 0) / 1_000_000,
    note:
      sources.length === 0
        ? "No analytics source is connected yet. Connect Search Console or GA4 in Integrations to populate this."
        : null,
  };
});
