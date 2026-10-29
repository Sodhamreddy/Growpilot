import { AppError } from "@ob/core";
import { z } from "zod";
export const dynamic = "force-dynamic";

import { sql, eq, and, gte } from "drizzle-orm";
import { metricSnapshots, articles, aiJobs, repo } from "@ob/db";
import { route } from "@/lib/api";
import { db } from "@/lib/services";

/** Client-scoped measurement totals and workspace AI costs. */
export const GET = route(async (ctx, req) => {
  const parsed = z.coerce.number().int().min(1).max(365).safeParse(new URL(req.url).searchParams.get("days") ?? 30);
  if (!parsed.success) throw new AppError("validation_failed", "days must be between 1 and 365.");
  const days = parsed.data;
  const since = new Date(Date.now() - days * 24 * 3600 * 1000);
  const database = db();
  const business = await repo.getPrimaryBusiness(database, ctx);
  const clientFilter = business ? sql`${metricSnapshots.dimensions}->>'businessId' = ${business.id}` : sql`false`;

  const [metrics, sources, publishedCount, aiSpend] = await Promise.all([
    database
      .select({
        metric: metricSnapshots.metric,
        total: sql<string>`sum(${metricSnapshots.value})`,
        points: sql<string>`count(*)`,
      })
      .from(metricSnapshots)
      .where(and(eq(metricSnapshots.workspaceId, ctx.workspaceId), clientFilter, sql`${metricSnapshots.metric} not like 'search_query_%'`, gte(metricSnapshots.date, since)))
      .groupBy(metricSnapshots.metric),
    database
      .selectDistinct({ source: metricSnapshots.source })
      .from(metricSnapshots)
      .where(and(eq(metricSnapshots.workspaceId, ctx.workspaceId), clientFilter)),
    database
      .select({ count: sql<string>`count(*)` })
      .from(articles)
      .where(and(eq(articles.workspaceId, ctx.workspaceId), business ? eq(articles.businessId, business.id) : sql`false`, eq(articles.status, "published"))),
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
