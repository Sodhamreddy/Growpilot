export const dynamic = "force-dynamic";

import { z } from "zod";
import { eq } from "drizzle-orm";
import { requireRole } from "@ob/core";
import { workspaces, repo } from "@ob/db";
import { JOBS, payloadFrom } from "@ob/jobs";
import { route, parseBody } from "@/lib/api";
import { db, getQueues } from "@/lib/services";

/**
 * The unattended content schedule — spec §12.
 *
 * GET returns the current setting and when it next fires. PUT changes it and
 * registers the repeat with the queue immediately, so "saved" and "running"
 * are the same moment rather than something that takes effect on the next
 * worker restart.
 */

const schema = z.object({
  enabled: z.boolean(),
  /** 0 = Sunday. */
  weekday: z.number().int().min(0).max(6).default(1),
  hour: z.number().int().min(0).max(23).default(9),
  topicCount: z.number().int().min(1).max(12).default(5),
  /*
   * Drafts are what cost money — a topic is one cheap call, a draft is a brief
   * plus a long generation plus seven gates. Capped low on purpose: an
   * unattended run that writes twelve articles a week will exhaust a free tier
   * and bury the reviewer.
   */
  draftCount: z.number().int().min(0).max(5).default(2),
});

const DEFAULTS = { enabled: false, weekday: 1, hour: 9, topicCount: 5, draftCount: 2 };

export const GET = route(async (ctx) => {
  const [ws] = await db()
    .select({ settings: workspaces.settings, timezone: workspaces.timezone })
    .from(workspaces)
    .where(eq(workspaces.id, ctx.workspaceId))
    .limit(1);

  const schedules = await getQueues().listSchedules("maintenance");
  const mine = schedules.find((s) => s.key === `content:${ctx.workspaceId}`);

  return {
    schedule: ws?.settings.contentSchedule ?? DEFAULTS,
    timezone: ws?.timezone ?? "UTC",
    // Read from the queue rather than computed, so the UI shows what will
    // actually happen instead of what we believe should happen.
    nextRun: mine?.next ? new Date(mine.next).toISOString() : null,
    registered: Boolean(mine),
  };
});

export const PUT = route(async (ctx, req) => {
  requireRole(ctx, "admin");
  const body = await parseBody(req, schema);
  const database = db();

  const [ws] = await database
    .select({
      settings: workspaces.settings,
      timezone: workspaces.timezone,
      completedAt: workspaces.onboardingCompletedAt,
    })
    .from(workspaces)
    .where(eq(workspaces.id, ctx.workspaceId))
    .limit(1);

  await database
    .update(workspaces)
    .set({
      settings: { ...(ws?.settings ?? {}), contentSchedule: body },
      updatedAt: new Date(),
    })
    .where(eq(workspaces.id, ctx.workspaceId));

  const queues = getQueues();
  const key = `content:${ctx.workspaceId}`;

  /*
   * A workspace that has not finished onboarding has no confirmed business, so
   * a run would skip every client and do nothing. Storing the preference but
   * not registering it keeps the setting the customer chose without pretending
   * it is active.
   */
  if (body.enabled && ws?.completedAt) {
    await queues.schedule(
      "maintenance",
      JOBS.scheduledContentRun,
      payloadFrom(ctx, {}),
      {
        key,
        cron: `0 ${body.hour} * * ${body.weekday}`,
        timezone: ws.timezone,
      },
    );
  } else {
    await queues.unschedule("maintenance", key);
  }

  await repo.writeAudit(database, ctx, {
    action: body.enabled ? "schedule.enabled" : "schedule.disabled",
    entityType: "workspace",
    entityId: ctx.workspaceId,
    after: { ...body, timezone: ws?.timezone ?? "UTC" },
  });

  const schedules = await queues.listSchedules("maintenance");
  const mine = schedules.find((s) => s.key === key);

  return {
    ok: true,
    schedule: body,
    nextRun: mine?.next ? new Date(mine.next).toISOString() : null,
    registered: Boolean(mine),
  };
});

/** Run now, without waiting for the schedule — for testing and for catching up. */
export const POST = route(async (ctx) => {
  requireRole(ctx, "admin");

  await getQueues().enqueue(
    "maintenance",
    JOBS.scheduledContentRun,
    payloadFrom(ctx, {}),
    { idempotencyKey: `manual-run:${ctx.workspaceId}:${Date.now()}` },
  );

  return { ok: true, message: "A content run has been queued for every confirmed client." };
});
