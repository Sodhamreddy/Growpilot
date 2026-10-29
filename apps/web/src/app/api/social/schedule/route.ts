export const dynamic = "force-dynamic";

import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { AppError, requireRole, type TenantContext } from "@ob/core";
import {
  businesses, repo, socialCategories, socialTopics,
  type Database, type PackSchedule, type SocialContentPack, type SocialNetworkId,
} from "@ob/db";
import { JOBS, payloadFrom, QueueRegistry } from "@ob/jobs";
import { publishBlocker } from "@ob/social";
import { route, parseBody } from "@/lib/api";
import { db, getQueues } from "@/lib/services";
import { loadConnection } from "@/lib/social-connection";

/**
 * Scheduling — step 5 of the social flow.
 *
 * POST    schedule a post for a time, or now; rescheduling replaces the time
 * DELETE  take a post off the schedule before it publishes
 * GET     the month's schedules, for the page to follow publishing as it happens
 *
 * The worker publishes at the time. Scheduling here only checks, records and
 * queues, so everything that decides whether a post may go out is checked
 * twice: now, so a person hears about a problem while they can fix it, and
 * again by the worker at the moment, because approvals can be taken back.
 */

const NETWORKS = ["facebook", "instagram"] as const;
/** The furthest ahead a post can be queued. Page tokens and plans both change within months. */
const MAX_AHEAD_DAYS = 90;

const scheduleSchema = z.object({
  topicId: z.string().uuid(),
  /** ISO time. Omitted, or in the past by under a minute, means now. */
  at: z.string().datetime({ offset: true }).optional(),
  networks: z.array(z.enum(NETWORKS)).min(1).max(2),
});

const jobKey = (topicId: string, at: string) => `social-post:${topicId}:${Date.parse(at)}`;

// Interrupted publishes require explicit reconciliation before they can be retried.
const publishingNow = (s: PackSchedule | undefined) =>
  s?.status === "publishing";

async function loadTopic(database: Database, ctx: TenantContext, topicId: string) {
  const [topic] = await database
    .select({
      id: socialTopics.id,
      title: socialTopics.title,
      status: socialTopics.status,
      format: socialTopics.format,
      pack: socialTopics.pack,
      businessId: socialCategories.businessId,
    })
    .from(socialTopics)
    .innerJoin(socialCategories, eq(socialCategories.id, socialTopics.categoryId))
    .where(and(eq(socialTopics.workspaceId, ctx.workspaceId), eq(socialTopics.id, topicId)))
    .limit(1);
  if (!topic) throw new AppError("not_found", "That post is not in this workspace.", { retryable: false });
  return topic;
}

export const POST = route(async (ctx, req) => {
  requireRole(ctx, "editor");
  const body = await parseBody(req, scheduleSchema);
  const database = db();
  const topic = await loadTopic(database, ctx, body.topicId);

  const blocker = publishBlocker(topic);
  if (blocker) throw new AppError("conflict", blocker, { retryable: false });
  const pack = topic.pack!;
  const previous = pack.schedule;
  if (publishingNow(previous)) {
    throw new AppError("conflict", "This post is publishing right now. Wait for it to finish.", { retryable: true });
  }

  const [business] = await database
    .select({ name: businesses.name, metaPageId: businesses.metaPageId })
    .from(businesses)
    .where(and(eq(businesses.workspaceId, ctx.workspaceId), eq(businesses.id, topic.businessId)))
    .limit(1);
  const connection = await loadConnection(database, ctx, business ?? null);
  for (const network of body.networks) {
    const ready = connection[network];
    if (!ready.ok) {
      throw new AppError("conflict", `${network === "facebook" ? "Facebook" : "Instagram"}: ${ready.reason}`, { retryable: false });
    }
  }

  const now = Date.now();
  const requested = body.at ? Date.parse(body.at) : now;
  if (requested < now - 60_000) {
    throw new AppError("validation_failed", "That time has already passed. Pick a later one, or publish now.", { retryable: false });
  }
  if (requested > now + MAX_AHEAD_DAYS * 86_400_000) {
    throw new AppError("validation_failed", `Posts can be scheduled up to ${MAX_AHEAD_DAYS} days ahead.`, { retryable: false });
  }
  const at = new Date(Math.max(requested, now)).toISOString();

  /*
   * Networks already published stay published.
   *
   * Rescheduling after a partial success retries only what failed, and can
   * never send the same photo to a Page twice.
   */
  const keep: PackSchedule["results"] = {};
  for (const n of NETWORKS) {
    const r = previous?.results[n];
    if (r?.status === "published") keep[n] = r;
  }
  const networks = [...new Set<SocialNetworkId>([...body.networks, ...(Object.keys(keep) as SocialNetworkId[])])];
  const schedule: PackSchedule = { at, networks, status: "scheduled", results: keep, ...(connection.pageId ? { pageId: connection.pageId } : {}), ...(connection.instagramId ? { instagramId: connection.instagramId } : {}) };
  const next: SocialContentPack = { ...pack, schedule };

  /*
   * Save, then swap the jobs.
   *
   * The post is saved with its new time first, so a job for the old time
   * that fires meanwhile finds a time the post no longer has and does
   * nothing. The old job is then removed (the same key included: a finished
   * job would otherwise stand in for the new one), and the new one queued.
   * If the queue cannot be reached the post is put back as it was, so the
   * page never shows a time that nothing will act on.
   */
  const setPack = (value: SocialContentPack, expected: SocialContentPack) =>
    database.update(socialTopics).set({ pack: value, updatedAt: new Date() })
      .where(and(eq(socialTopics.id, topic.id), sql`${socialTopics.pack} = ${JSON.stringify(expected)}::jsonb`)).returning({ id: socialTopics.id });
  if (!(await setPack(next, pack)).length) throw new AppError("conflict", "This post changed. Refresh before scheduling.");
  const queues = getQueues();
  let oldJobGone = false;
  try {
    if (previous) oldJobGone = await queues.removeJob("publish", jobKey(topic.id, previous.at));
    await queues.enqueue("publish", JOBS.publishSocialPost, payloadFrom(ctx, { topicId: topic.id, at }), {
      idempotencyKey: jobKey(topic.id, at),
      delayMs: Math.max(0, Date.parse(at) - Date.now()),
    });
  } catch (err) {
    const { schedule: _next, ...unscheduled } = next;
    void _next;
    // An old time whose job was already removed cannot be kept: nothing would publish it.
    await setPack(previous && !(oldJobGone && previous.status === "scheduled") ? pack : unscheduled, next);
    throw new AppError(
      "dependency_unavailable",
      "The scheduler could not be reached, so nothing was scheduled. Check that Redis and the worker are running, then try again.",
      { cause: err, retryable: true },
    );
  }

  await repo.writeAudit(database, ctx, {
    action: previous ? "social.post_rescheduled" : "social.post_scheduled",
    entityType: "social_topic",
    entityId: topic.id,
    after: { at, networks },
  });
  return { ok: true, pack: next };
});

export const DELETE = route(async (ctx, req) => {
  requireRole(ctx, "editor");
  const body = await parseBody(req, z.object({ topicId: z.string().uuid() }));
  const database = db();
  const topic = await loadTopic(database, ctx, body.topicId);
  const schedule = topic.pack?.schedule;
  if (!topic.pack || !schedule) return { ok: true, pack: topic.pack };

  const published = NETWORKS.filter((n) => schedule.results[n]?.status === "published");
  if (published.length) {
    throw new AppError(
      "conflict",
      `Already published to ${published.map((n) => (n === "facebook" ? "Facebook" : "Instagram")).join(" and ")}. Delete it there if it should come down.`,
      { retryable: false },
    );
  }
  if (publishingNow(schedule)) {
    throw new AppError("conflict", "This post is publishing right now and can no longer be stopped.", { retryable: false });
  }

  await getQueues().removeJob("publish", jobKey(topic.id, schedule.at));
  const { schedule: _removed, ...rest } = topic.pack;
  void _removed;
  const changed = await database.update(socialTopics).set({ pack: rest, updatedAt: new Date() })
    .where(and(eq(socialTopics.id, topic.id), sql`${socialTopics.pack} = ${JSON.stringify(topic.pack)}::jsonb`)).returning({ id: socialTopics.id });
  if (!changed.length) throw new AppError("conflict", "The post changed or began publishing. Refresh to see its status.");
  await repo.writeAudit(database, ctx, {
    action: "social.post_unscheduled", entityType: "social_topic", entityId: topic.id, before: { at: schedule.at },
  });
  return { ok: true, pack: rest };
});

/** GET ?ids=a,b — the current schedule of each post, for following publishing live. */
export const GET = route(async (ctx, req) => {
  const ids = (new URL(req.url).searchParams.get("ids") ?? "").split(",").filter((id) => /^[0-9a-f-]{36}$/.test(id)).slice(0, 62);
  if (!ids.length) return { posts: [] };
  const database = db();
  const rows = await Promise.all(ids.map((id) => loadTopic(database, ctx, id).catch(() => null)));
  return {
    posts: rows.filter(Boolean).map((r) => ({ id: r!.id, status: r!.status, schedule: r!.pack?.schedule ?? null })),
  };
});

/** Record an operator's check of an interrupted publish; this never posts content. */
export const PATCH = route(async (ctx, req) => {
  requireRole(ctx, "admin");
  const body = await parseBody(req, z.object({ topicId: z.string().uuid(), confirmed: z.literal(true),
    outcomes: z.array(z.object({ network: z.enum(NETWORKS), state: z.enum(["published", "absent"]),
      id: z.string().min(1).max(200).optional(), url: z.string().url().optional() })).max(2) }));
  const database = db();
  const topic = await loadTopic(database, ctx, body.topicId);
  const schedule = topic.pack?.schedule;
  if (!topic.pack || schedule?.status !== "publishing") throw new AppError("conflict", "Only interrupted publishing needs reconciliation.");
  const job = await getQueues().get("publish").getJob(QueueRegistry.jobIdFor(jobKey(topic.id, schedule.at)));
  if (job && await job.getState() === "active") throw new AppError("conflict", "Publishing is still running. Wait for it to finish.");
  const results = { ...schedule.results };
  for (const network of schedule.networks) {
    if (results[network]?.status === "published") continue;
    const outcome = body.outcomes.find(row => row.network === network);
    if (!outcome) throw new AppError("validation_failed", `Check ${network} before continuing.`);
    if (outcome.state === "published") {
      if (!outcome.id || !outcome.url || new URL(outcome.url).protocol !== "https:") throw new AppError("validation_failed", "Supply the published post ID and HTTPS URL.");
      results[network] = { status: "published", id: outcome.id, url: outcome.url, at: new Date().toISOString() };
    } else results[network] = { status: "failed", error: "An administrator confirmed that no post exists. It can be scheduled again.", at: new Date().toISOString() };
  }
  const allPublished = schedule.networks.every(n => results[n]?.status === "published");
  const next: SocialContentPack = { ...topic.pack, schedule: { ...schedule, results,
    status: allPublished ? "published" : schedule.networks.some(n => results[n]?.status === "published") ? "partial" : "failed" } };
  if (job) await job.remove();
  const changed = await database.update(socialTopics).set({ pack: next, ...(allPublished ? { status: "published" as const } : {}), updatedAt: new Date() })
    .where(and(eq(socialTopics.id, topic.id), sql`${socialTopics.pack} = ${JSON.stringify(topic.pack)}::jsonb`)).returning({ id: socialTopics.id });
  if (!changed.length) throw new AppError("conflict", "The post changed. Refresh before reconciling.");
  await repo.writeAudit(database, ctx, { action: "social.publish_reconciled", entityType: "social_topic", entityId: topic.id, after: { outcomes: body.outcomes } });
  return { ok: true, pack: next };
});
