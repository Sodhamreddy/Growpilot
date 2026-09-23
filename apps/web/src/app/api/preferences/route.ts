export const dynamic = "force-dynamic";

import { z } from "zod";
import { eq } from "drizzle-orm";
import { requireRole } from "@ob/core";
import { workspaces, repo } from "@ob/db";
import { route, parseBody } from "@/lib/api";
import { db } from "@/lib/services";

/**
 * GET /api/preferences · PATCH /api/preferences — spec §15.1, §5.2.
 *
 * These are not cosmetic settings: `requireApprovalBeforePublish` and the score
 * floors are read by the publishing gate on every approval and publish attempt,
 * and `aiBudgetMicros` is enforced by the AI gateway before any spend. Changing
 * them here changes what the pipeline does.
 */

export const GET = route(async (ctx) => {
  const [ws] = await db()
    .select({
      name: workspaces.name,
      timezone: workspaces.timezone,
      locale: workspaces.locale,
      plan: workspaces.plan,
      settings: workspaces.settings,
      aiBudgetMicros: workspaces.aiBudgetMicros,
    })
    .from(workspaces)
    .where(eq(workspaces.id, ctx.workspaceId))
    .limit(1);

  return {
    workspace: {
      name: ws?.name ?? "",
      timezone: ws?.timezone ?? "UTC",
      locale: ws?.locale ?? "en-US",
      plan: ws?.plan ?? "trial",
    },
    settings: {
      requireApprovalBeforePublish: ws?.settings.requireApprovalBeforePublish !== false,
      requireHumanReviewForSensitive: ws?.settings.requireHumanReviewForSensitive !== false,
      autoPublishEnabled: ws?.settings.autoPublishEnabled === true,
      minSeoScoreToPublish: ws?.settings.minSeoScoreToPublish ?? 70,
      minVoiceScoreToPublish: ws?.settings.minVoiceScoreToPublish ?? 70,
    },
    aiBudgetUsd: (ws?.aiBudgetMicros ?? 0) / 1_000_000,
    role: ctx.role,
  };
});

const schema = z.object({
  name: z.string().min(1, "Give the workspace a name.").max(120).optional(),
  timezone: z.string().min(1).max(64).optional(),
  requireApprovalBeforePublish: z.boolean().optional(),
  requireHumanReviewForSensitive: z.boolean().optional(),
  autoPublishEnabled: z.boolean().optional(),
  minSeoScoreToPublish: z.number().int().min(0).max(100).optional(),
  minVoiceScoreToPublish: z.number().int().min(0).max(100).optional(),
  aiBudgetUsd: z.number().min(0).max(100_000).optional(),
});

export const PATCH = route(async (ctx, req) => {
  // Policy governs publication, so changing it is an admin action.
  requireRole(ctx, "admin");
  const body = await parseBody(req, schema);
  const database = db();

  const [before] = await database
    .select({ settings: workspaces.settings, budget: workspaces.aiBudgetMicros, name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.id, ctx.workspaceId))
    .limit(1);

  const settings = { ...(before?.settings ?? {}) };
  for (const key of [
    "requireApprovalBeforePublish",
    "requireHumanReviewForSensitive",
    "autoPublishEnabled",
    "minSeoScoreToPublish",
    "minVoiceScoreToPublish",
  ] as const) {
    if (body[key] !== undefined) settings[key] = body[key] as never;
  }

  const updates: Record<string, unknown> = { settings, updatedAt: new Date() };
  if (body.name !== undefined) updates["name"] = body.name;
  if (body.timezone !== undefined) updates["timezone"] = body.timezone;
  if (body.aiBudgetUsd !== undefined) {
    updates["aiBudgetMicros"] = Math.round(body.aiBudgetUsd * 1_000_000);
  }

  await database.update(workspaces).set(updates).where(eq(workspaces.id, ctx.workspaceId));

  // Policy changes are audited — they alter what may be published (spec §15).
  await repo.writeAudit(database, ctx, {
    action: "workspace.settings_updated",
    entityType: "workspace",
    entityId: ctx.workspaceId,
    before: { settings: before?.settings, budgetMicros: before?.budget, name: before?.name },
    after: updates,
  });

  return { ok: true };
});
