export const dynamic = "force-dynamic";

import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { notFound, requireRole, slugify } from "@ob/core";
import { businesses, businessLocations, businessFacts, workspaces, repo } from "@ob/db";
import { route, parseBody } from "@/lib/api";
import { db } from "@/lib/services";

/**
 * GET  /api/business/profile — the extracted profile with its evidence.
 * PATCH /api/business/profile — customer corrections (spec §3.1 confirmation).
 *
 * Every fact is returned with its source URL, quote and confidence so the UI
 * can show provenance — spec §10.3 "Show source evidence for extracted facts"
 * and §18's acceptance criterion that the user can correct what was extracted.
 */

export const GET = route(async (ctx) => {
  const database = db();
  const business = await repo.getPrimaryBusiness(database, ctx);
  if (!business) return { business: null, facts: [], locations: [], confirmed: false };

  const [facts, locations] = await Promise.all([
    repo.listFacts(database, ctx, business.id),
    database
      .select()
      .from(businessLocations)
      .where(
        and(
          eq(businessLocations.workspaceId, ctx.workspaceId),
          eq(businessLocations.businessId, business.id),
        ),
      ),
  ]);

  return {
    business: {
      id: business.id,
      name: business.name,
      industry: business.industry,
      audience: business.audience,
      description: business.description,
      usp: business.usp,
      primaryCta: business.primaryCta,
      websiteUrl: business.websiteUrl,
    },
    confirmed: business.confirmedAt !== null,
    confirmedAt: business.confirmedAt,
    facts: facts.map((f) => ({
      id: f.id,
      key: f.key,
      value: f.value,
      sourceUrl: f.sourceUrl,
      sourceQuote: f.sourceQuote,
      confidence: f.confidence,
      verified: f.verified,
    })),
    locations,
  };
});

const patchSchema = z.object({
  businessId: z.string().uuid(),
  name: z.string().min(1).max(200).optional(),
  industry: z.string().max(200).nullable().optional(),
  audience: z.string().max(1000).nullable().optional(),
  description: z.string().max(5000).nullable().optional(),
  usp: z.string().max(1000).nullable().optional(),
  primaryCta: z.string().max(200).nullable().optional(),
  /** Marks the profile reviewed — required before generation (spec §3.1). */
  confirm: z.boolean().optional(),
});

export const PATCH = route(async (ctx, req) => {
  requireRole(ctx, "editor");
  const body = await parseBody(req, patchSchema);
  const database = db();

  const before = await repo.getBusiness(database, ctx, body.businessId);

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  for (const key of ["name", "industry", "audience", "description", "usp", "primaryCta"] as const) {
    if (body[key] !== undefined) updates[key] = body[key];
  }

  if (body.confirm) {
    updates["confirmedAt"] = new Date();
    updates["confirmedBy"] = ctx.userId;
  }

  const [updated] = await database
    .update(businesses)
    .set(updates)
    .where(and(eq(businesses.workspaceId, ctx.workspaceId), eq(businesses.id, body.businessId)))
    .returning();

  if (!updated) throw notFound("business");

  /*
   * Adopt the business name as the workspace name.
   *
   * At signup the customer has not told us anything about their business yet,
   * so the workspace carries whatever placeholder they typed to get past the
   * form — "dd", "test", "My workspace". Confirming the profile is the first
   * moment we know what the business is actually called, and leaving the
   * placeholder in the sidebar makes a real workspace look like a throwaway.
   *
   * Only while onboarding is unfinished: after that the name is the
   * customer's to set, and a later re-confirmation must not overwrite a
   * deliberate rename.
   */
  if (body.confirm) {
    const [ws] = await database
      .select({ name: workspaces.name, completedAt: workspaces.onboardingCompletedAt })
      .from(workspaces)
      .where(eq(workspaces.id, ctx.workspaceId))
      .limit(1);

    if (ws && ws.completedAt === null && updated.name && updated.name !== ws.name) {
      await database
        .update(workspaces)
        .set({
          name: updated.name,
          slug: `${slugify(updated.name) || "workspace"}-${ctx.workspaceId.slice(0, 6)}`,
          updatedAt: new Date(),
        })
        .where(eq(workspaces.id, ctx.workspaceId));
    }
  }

  // Confirming the profile marks every extracted fact as human-reviewed, which
  // is what lets generation state them without hedging (spec §15.1).
  if (body.confirm) {
    await database
      .update(businessFacts)
      .set({ verified: true })
      .where(
        and(
          eq(businessFacts.workspaceId, ctx.workspaceId),
          eq(businessFacts.businessId, body.businessId),
        ),
      );
  }

  // Initial planning starts after the final onboarding preferences are saved.
  await repo.writeAudit(database, ctx, {
    action: body.confirm ? "business.profile_confirmed" : "business.profile_updated",
    entityType: "business",
    entityId: body.businessId,
    before: { name: before.name, industry: before.industry, usp: before.usp },
    after: updates,
  });

  return { ok: true, confirmed: updated.confirmedAt !== null };
});
