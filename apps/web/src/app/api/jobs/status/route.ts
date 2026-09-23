export const dynamic = "force-dynamic";

import { sql, eq, desc, and, gte } from "drizzle-orm";
import { aiJobs, publishJobs, articles } from "@ob/db";
import { route } from "@/lib/api";
import { db, getQueues } from "@/lib/services";
import { getRedis } from "@/lib/redis";

/**
 * GET /api/jobs/status — spec §10.1 Home "Attention" and "Usage" panels.
 *
 * Queue depth, dead-letter backlog, AI spend this period and the approval
 * queue: what an operator needs to see that the automation is healthy.
 */
export const GET = route(async (ctx) => {
  const database = db();
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const [counts, spend, recentFailures, awaitingApproval, pendingPublishes, heartbeat] = await Promise.all([
    getQueues().counts(),
    database
      .select({
        costMicros: sql<string>`coalesce(sum(${aiJobs.costMicros}), 0)`,
        calls: sql<string>`count(*)`,
        inputTokens: sql<string>`coalesce(sum(${aiJobs.inputTokens}), 0)`,
        outputTokens: sql<string>`coalesce(sum(${aiJobs.outputTokens}), 0)`,
      })
      .from(aiJobs)
      .where(and(eq(aiJobs.workspaceId, ctx.workspaceId), gte(aiJobs.startedAt, monthStart))),
    database
      .select({
        taskAlias: aiJobs.taskAlias,
        model: aiJobs.model,
        error: aiJobs.error,
        startedAt: aiJobs.startedAt,
      })
      .from(aiJobs)
      .where(and(eq(aiJobs.workspaceId, ctx.workspaceId), eq(aiJobs.status, "failed")))
      .orderBy(desc(aiJobs.startedAt))
      .limit(10),
    database
      .select({ count: sql<string>`count(*)` })
      .from(articles)
      .where(and(eq(articles.workspaceId, ctx.workspaceId), eq(articles.status, "awaiting_approval"))),
    database
      .select({ count: sql<string>`count(*)` })
      .from(publishJobs)
      .where(and(eq(publishJobs.workspaceId, ctx.workspaceId), eq(publishJobs.status, "queued"))),
    getRedis().get("worker:heartbeat").catch(() => null),
  ]);

  // Queued work with no worker to run it is the single most confusing failure
  // mode in development, so it is reported explicitly rather than inferred.
  const queuedTotal = Object.entries(counts)
    .filter(([name]) => name !== "dead-letter")
    .reduce((n, [, c]) => n + (c["waiting"] ?? 0) + (c["active"] ?? 0) + (c["delayed"] ?? 0), 0);

  const usage = spend[0];
  return {
    worker: {
      online: heartbeat !== null,
      lastSeen: heartbeat,
      queuedJobs: queuedTotal,
      /** True when jobs are waiting and nothing is running them. */
      stalled: heartbeat === null && queuedTotal > 0,
    },
    queues: counts,
    usage: {
      costUsd: Number(usage?.costMicros ?? 0) / 1_000_000,
      calls: Number(usage?.calls ?? 0),
      inputTokens: Number(usage?.inputTokens ?? 0),
      outputTokens: Number(usage?.outputTokens ?? 0),
      periodStart: monthStart.toISOString(),
    },
    attention: {
      awaitingApproval: Number(awaitingApproval[0]?.count ?? 0),
      pendingPublishes: Number(pendingPublishes[0]?.count ?? 0),
      deadLetterJobs: counts["dead-letter"]?.["waiting"] ?? 0,
      recentAiFailures: recentFailures,
    },
  };
});
