import { eq, and, inArray, gte } from "drizzle-orm";
import { workspaces, businesses, articles, repo } from "@ob/db";
import { JOBS, payloadFrom } from "@ob/jobs";
import type { WorkerContext } from "../../context.js";
import { contextFromPayload } from "../../context.js";

/**
 * Unattended content runs — the equivalent of a weekly cron in an automation
 * tool, but aware of what the workspace already has.
 *
 * Fires on a schedule, then fans out one planning job per client that is
 * actually due. The fan-out is the point: an agency with six clients wants six
 * independent runs, not one run against whichever business happens to be
 * selected in the UI.
 *
 * Three refusals are deliberate, because an unattended job spends money without
 * anyone watching:
 *
 *   - a client whose profile is unconfirmed is skipped, since generation is
 *     gated on confirmation everywhere else and this must not be the exception
 *   - a client with drafts already waiting for review is skipped, so an
 *     unattended run cannot pile up work nobody has looked at
 *   - the workspace budget is checked before any client is queued
 */

export interface ScheduledRunPayload {
  workspaceId: string;
  userId: string;
  correlationId: string;
}

/** How many unreviewed drafts before a client is considered backed up. */
const BACKLOG_LIMIT = 5;

export async function processScheduledRun(
  wc: WorkerContext,
  payload: ScheduledRunPayload,
): Promise<{ queued: number; skipped: number }> {
  const ctx = contextFromPayload(payload);
  const log = wc.logger.child({
    correlationId: ctx.correlationId,
    workspaceId: ctx.workspaceId,
  });

  const [workspace] = await wc.db
    .select({
      settings: workspaces.settings,
      aiBudgetMicros: workspaces.aiBudgetMicros,
      completedAt: workspaces.onboardingCompletedAt,
    })
    .from(workspaces)
    .where(eq(workspaces.id, ctx.workspaceId))
    .limit(1);

  const schedule = workspace?.settings.contentSchedule;

  // The schedule may have been turned off since this job was registered. Redis
  // holds the repeat definition, so the database is the authority on intent.
  if (!schedule?.enabled) {
    log.info("Scheduled run skipped — the schedule is off");
    await wc.queues.unschedule("maintenance", `content:${ctx.workspaceId}`);
    return { queued: 0, skipped: 0 };
  }

  if (!workspace?.completedAt) {
    log.info("Scheduled run skipped — onboarding is not finished");
    return { queued: 0, skipped: 0 };
  }

  /*
   * Budget first, before anything is queued.
   *
   * Checking per job would mean the first few clients run and the rest fail
   * mid-flight, leaving the workspace with a partial week of content and no
   * clear reason why.
   */
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const spent = await repo.aiSpendSince(wc.db, ctx.workspaceId, monthStart);

  if (workspace.aiBudgetMicros > 0 && spent >= workspace.aiBudgetMicros) {
    log.warn("Scheduled run skipped — the monthly AI budget is spent", {
      spentMicros: spent,
      budgetMicros: workspace.aiBudgetMicros,
    });
    return { queued: 0, skipped: 0 };
  }

  const clients = await wc.db
    .select({ id: businesses.id, name: businesses.name, confirmedAt: businesses.confirmedAt })
    .from(businesses)
    .where(eq(businesses.workspaceId, ctx.workspaceId));

  let queued = 0;
  let skipped = 0;

  for (const client of clients) {
    if (!client.confirmedAt) {
      log.info("Client skipped — profile not confirmed", { business: client.name });
      skipped++;
      continue;
    }

    // Anything already drafted and not yet dealt with by a person.
    const waiting = await wc.db
      .select({ id: articles.id })
      .from(articles)
      .where(and(
        eq(articles.workspaceId, ctx.workspaceId),
        eq(articles.businessId, client.id),
        inArray(articles.status, ["draft", "generating", "qa", "awaiting_approval", "needs_changes"]),
      ))
      .limit(BACKLOG_LIMIT);

    if (waiting.length >= BACKLOG_LIMIT) {
      log.info("Client skipped — unreviewed drafts are waiting", {
        business: client.name,
        waiting: waiting.length,
      });
      skipped++;
      continue;
    }

    /*
     * Keyed to this run, not to the client.
     *
     * A key tied only to the business would make the second week a duplicate of
     * the first and silently do nothing — the same class of bug that stopped
     * content plans being rebuilt earlier.
     */
    await wc.queues.enqueue(
      "research",
      JOBS.buildContentPlan,
      payloadFrom(ctx, { businessId: client.id, draftCount: schedule.draftCount }),
      { idempotencyKey: `scheduled:${client.id}:${ctx.correlationId}` },
    );
    queued++;
  }

  await repo.writeAudit(wc.db, ctx, {
    action: "content.scheduled_run",
    entityType: "workspace",
    entityId: ctx.workspaceId,
    after: { clients: clients.length, queued, skipped },
  });

  log.info("Scheduled run complete", { clients: clients.length, queued, skipped });
  return { queued, skipped };
}

/**
 * Re-register every workspace's schedule at worker boot.
 *
 * Repeat definitions live in Redis, so a flushed Redis or a fresh environment
 * would leave schedules configured in the database but firing nowhere. Running
 * this on boot makes the database the source of truth and Redis merely the
 * mechanism.
 */
export async function restoreSchedules(wc: WorkerContext): Promise<number> {
  try {
    const rows = await wc.db
      .select({
        id: workspaces.id,
        settings: workspaces.settings,
        timezone: workspaces.timezone,
        completedAt: workspaces.onboardingCompletedAt,
      })
      .from(workspaces)
      .where(gte(workspaces.createdAt, new Date(0)));

    let restored = 0;

    for (const ws of rows) {
      const schedule = ws.settings.contentSchedule;
      const key = `content:${ws.id}`;

      if (!schedule?.enabled || !ws.completedAt) {
        await wc.queues.unschedule("maintenance", key);
        continue;
      }

      await wc.queues.schedule(
        "maintenance",
        JOBS.scheduledContentRun,
        {
          workspaceId: ws.id,
          userId: "00000000-0000-0000-0000-000000000000",
          correlationId: `sched-${ws.id.slice(0, 8)}`,
        },
        {
          key,
          // minute hour day-of-month month day-of-week
          cron: `0 ${schedule.hour} * * ${schedule.weekday}`,
          timezone: ws.timezone,
        },
      );
      restored++;
    }

    if (restored > 0) wc.logger.info("Content schedules restored", { count: restored });
    return restored;
  } catch (err) {
    // A schedule that fails to restore must not stop the worker from starting.
    wc.logger.error("Could not restore content schedules", { error: String(err) });
    return 0;
  }
}
