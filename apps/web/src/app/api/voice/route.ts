export const dynamic = "force-dynamic";

import { z } from "zod";
import { eq, and, desc } from "drizzle-orm";
import { requireRole, notFound, AppError } from "@ob/core";
import { brandVoices, businesses, repo } from "@ob/db";
import { voiceProfileSchema } from "@ob/voice";
import { route, parseBody } from "@/lib/api";
import { db } from "@/lib/services";

/**
 * GET   /api/voice — voice versions for a business.
 * PATCH /api/voice — customer edits to a draft profile (spec §18.7).
 *
 * Spec §18.7 wants a simple Voice Settings screen with direct control over
 * tone, terms, CTA style and samples. Edits always target a DRAFT; activation
 * is a separate, explicit call.
 */

export const GET = route(async (ctx, req) => {
  const businessId = new URL(req.url).searchParams.get("businessId");
  if (!businessId) return { voices: [], active: null };

  const rows = await db()
    .select()
    .from(brandVoices)
    .where(and(eq(brandVoices.workspaceId, ctx.workspaceId), eq(brandVoices.businessId, businessId)))
    .orderBy(desc(brandVoices.version));

  return {
    voices: rows.map((v) => ({
      id: v.id,
      version: v.version,
      isActive: v.isActive,
      approvedAt: v.approvedAt,
      profile: v.profile,
      bannedTerms: v.bannedTerms,
      preferredTerms: v.preferredTerms,
      sampleCount: v.samples.length,
    })),
    active: rows.find((v) => v.isActive)?.id ?? null,
  };
});

const patchSchema = z.object({
  voiceId: z.string().uuid(),
  profile: voiceProfileSchema.partial().optional(),
  bannedTerms: z.array(z.string().min(1).max(100)).max(200).optional(),
  preferredTerms: z
    .array(z.object({ use: z.string().min(1).max(100), insteadOf: z.string().max(100).optional() }))
    .max(200)
    .optional(),
});

export const PATCH = route(async (ctx, req) => {
  requireRole(ctx, "editor");
  const body = await parseBody(req, patchSchema);
  const database = db();
  const voice = await database.transaction(async (tx) => {
    const [target] = await tx
      .select({ businessId: brandVoices.businessId })
      .from(brandVoices)
      .where(and(eq(brandVoices.workspaceId, ctx.workspaceId), eq(brandVoices.id, body.voiceId)))
      .limit(1);
    if (!target) throw notFound("brand voice");
    // Activation takes the same lock. An edit cannot change an approved version.
    await tx.select({ id: businesses.id }).from(businesses)
      .where(and(eq(businesses.workspaceId, ctx.workspaceId), eq(businesses.id, target.businessId))).for("update");
    const [existing] = await tx
      .select()
      .from(brandVoices)
      .where(and(eq(brandVoices.workspaceId, ctx.workspaceId), eq(brandVoices.id, body.voiceId)))
      .limit(1);

    if (!existing) throw notFound("brand voice");

    const updates = {
      profile: { ...existing.profile, ...body.profile },
      bannedTerms: body.bannedTerms ?? existing.bannedTerms,
      preferredTerms: body.preferredTerms ?? existing.preferredTerms,
    };
    let updated: typeof existing | undefined;
    if (existing.isActive || existing.approvedAt) {
      // Preserve the approved version and its history. Only the new draft changes.
      for (let attempt = 0; attempt < 3 && !updated; attempt++) {
        const [latest] = await tx.select({ version: brandVoices.version }).from(brandVoices)
          .where(and(eq(brandVoices.workspaceId, ctx.workspaceId), eq(brandVoices.businessId, existing.businessId)))
          .orderBy(desc(brandVoices.version)).limit(1);
        [updated] = await tx.insert(brandVoices).values({
          workspaceId: ctx.workspaceId, businessId: existing.businessId,
          version: (latest?.version ?? 0) + 1, samples: existing.samples,
          ...updates, isActive: false, approvedAt: null, approvedBy: null,
        }).onConflictDoNothing().returning();
      }
      if (!updated) throw new AppError("conflict", "Another voice version was created. Refresh and try again.", { retryable: true });
    } else {
      [updated] = await tx.update(brandVoices).set(updates)
        .where(and(eq(brandVoices.workspaceId, ctx.workspaceId), eq(brandVoices.id, body.voiceId))).returning();
    }

    await repo.writeAudit(tx as unknown as ReturnType<typeof db>, ctx, {
      action: "voice.edited",
      entityType: "brand_voice",
      entityId: updated!.id,
      before: { profile: existing.profile, bannedTerms: existing.bannedTerms },
      after: { ...updates, sourceVoiceId: existing.id, version: updated!.version },
    });
    return updated!;
  });

  return {
    ok: true,
    voice: { id: voice.id, version: voice.version, profile: voice.profile, isActive: voice.isActive, approvedAt: voice.approvedAt },
  };
});
