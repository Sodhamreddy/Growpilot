export const dynamic = "force-dynamic";

import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { notFound, requireRole } from "@ob/core";
import { businesses, repo } from "@ob/db";
import { route, parseBody } from "@/lib/api";
import { db } from "@/lib/services";

/**
 * PATCH /api/business/info — details a customer supplies by hand.
 *
 * Separate from /api/business/profile, which edits what the crawler extracted
 * and carries the confirmation gate with it. These fields were never extracted:
 * a logo is rarely in the markup in any usable form, the Google Business
 * Profile name lives on Google, and social handles are usually just an icon
 * row. Editing them is ordinary data entry and must not disturb the extraction
 * provenance or re-open the confirmation gate.
 */

const socialSchema = z.object({
  network: z.enum(["linkedin", "facebook", "instagram", "x", "youtube", "tiktok", "pinterest"]),
  handle: z.string().min(1).max(120),
  url: z.string().url("Enter the full profile address."),
});

const schema = z.object({
  businessId: z.string().uuid(),
  logoUrl: z.union([
    z.string().url().startsWith("https://", "The logo address must start with https://").max(2000),
    z.string().max(7_100_000).regex(
      /^data:image\/(?:png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/,
      "Choose a valid PNG, JPG, WEBP or SVG logo.",
    ),
  ]).nullable().optional(),
  gmbName: z.string().max(200).nullable().optional(),
  socialProfiles: z.array(socialSchema).max(10).optional(),
});

export const PATCH = route(async (ctx, req) => {
  requireRole(ctx, "editor");
  const body = await parseBody(req, schema, { maxBytes: 8 * 1024 * 1024 });
  const database = db();

  const before = await repo.getBusiness(database, ctx, body.businessId);

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (body.logoUrl !== undefined) updates["logoUrl"] = body.logoUrl;
  if (body.gmbName !== undefined) {
    updates["gmbName"] = body.gmbName === null ? null : body.gmbName.trim() || null;
  }
  if (body.socialProfiles !== undefined) {
    // One entry per network: a business has one LinkedIn page, and allowing
    // duplicates makes "which account do we post to" ambiguous later.
    const seen = new Set<string>();
    updates["socialProfiles"] = body.socialProfiles.filter((p) =>
      seen.has(p.network) ? false : (seen.add(p.network), true),
    );
  }

  const [updated] = await database
    .update(businesses)
    .set(updates)
    .where(and(eq(businesses.workspaceId, ctx.workspaceId), eq(businesses.id, body.businessId)))
    .returning();

  if (!updated) throw notFound("business");

  await repo.writeAudit(database, ctx, {
    action: "business.info_updated",
    entityType: "business",
    entityId: body.businessId,
    before: {
      logoUrl: before.logoUrl,
      gmbName: before.gmbName,
      socialProfiles: before.socialProfiles.length,
    },
    after: updates,
  });

  return {
    ok: true,
    logoUrl: updated.logoUrl,
    gmbName: updated.gmbName,
    socialProfiles: updated.socialProfiles,
  };
});
