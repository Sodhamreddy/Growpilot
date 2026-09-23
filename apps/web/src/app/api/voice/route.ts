export const dynamic = "force-dynamic";

import { z } from "zod";
import { eq, and, desc } from "drizzle-orm";
import { requireRole, notFound } from "@ob/core";
import { brandVoices, repo } from "@ob/db";
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

  const [existing] = await database
    .select()
    .from(brandVoices)
    .where(and(eq(brandVoices.workspaceId, ctx.workspaceId), eq(brandVoices.id, body.voiceId)))
    .limit(1);

  if (!existing) throw notFound("brand voice");

  const updates: Record<string, unknown> = {};
  if (body.profile) updates["profile"] = { ...existing.profile, ...body.profile };
  if (body.bannedTerms) updates["bannedTerms"] = body.bannedTerms;
  if (body.preferredTerms) updates["preferredTerms"] = body.preferredTerms;

  const [updated] = await database
    .update(brandVoices)
    .set(updates)
    .where(and(eq(brandVoices.workspaceId, ctx.workspaceId), eq(brandVoices.id, body.voiceId)))
    .returning();

  await repo.writeAudit(database, ctx, {
    action: "voice.edited",
    entityType: "brand_voice",
    entityId: body.voiceId,
    before: { profile: existing.profile, bannedTerms: existing.bannedTerms },
    after: updates,
  });

  return {
    ok: true,
    voice: { id: updated!.id, version: updated!.version, profile: updated!.profile },
  };
});
