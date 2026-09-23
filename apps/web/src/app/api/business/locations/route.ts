export const dynamic = "force-dynamic";

import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { requireRole, AppError } from "@ob/core";
import { businessLocations, repo } from "@ob/db";
import { route, parseBody } from "@/lib/api";
import { db } from "@/lib/services";

/**
 * Business locations, entered or corrected by hand.
 *
 * The crawler finds addresses when a site publishes them in a readable form,
 * but plenty of sites put the address in an image, a map embed, or nowhere at
 * all. Local content and directory listings both need a complete address, so
 * there has to be a way to type one in.
 *
 * A hand-entered location gets `confidence: 1` and no source URL, which is the
 * same honesty rule the services route follows: a person vouched for it, and it
 * did not come from a page we read.
 */

const locationFields = {
  label: z.string().min(1, "Give this location a name.").max(120),
  streetAddress: z.string().max(300).nullable().optional(),
  locality: z.string().max(120).nullable().optional(),
  region: z.string().max(120).nullable().optional(),
  postalCode: z.string().max(40).nullable().optional(),
  country: z.string().max(120).nullable().optional(),
  phone: z.string().max(60).nullable().optional(),
};

const createSchema = z.object({ businessId: z.string().uuid(), ...locationFields });
const updateSchema = z.object({
  businessId: z.string().uuid(),
  locationId: z.string().uuid(),
  ...locationFields,
});
const deleteSchema = z.object({
  businessId: z.string().uuid(),
  locationId: z.string().uuid(),
});

const trimmed = (v: string | null | undefined) =>
  v === undefined || v === null ? null : v.trim() || null;

export const GET = route(async (ctx, req) => {
  const businessId = new URL(req.url).searchParams.get("businessId");
  if (!businessId) return { locations: [] };

  const rows = await db()
    .select()
    .from(businessLocations)
    .where(and(
      eq(businessLocations.workspaceId, ctx.workspaceId),
      eq(businessLocations.businessId, businessId),
    ));

  return { locations: rows };
});

export const POST = route(async (ctx, req) => {
  requireRole(ctx, "editor");
  const body = await parseBody(req, createSchema);
  const database = db();
  await repo.getBusiness(database, ctx, body.businessId);

  const [created] = await database
    .insert(businessLocations)
    .values({
      workspaceId: ctx.workspaceId,
      businessId: body.businessId,
      label: body.label.trim(),
      streetAddress: trimmed(body.streetAddress),
      locality: trimmed(body.locality),
      region: trimmed(body.region),
      postalCode: trimmed(body.postalCode),
      country: trimmed(body.country),
      phone: trimmed(body.phone),
      sourceUrl: null,
      confidence: 1,
    })
    .returning();

  await repo.writeAudit(database, ctx, {
    action: "business.location_added",
    entityType: "business",
    entityId: body.businessId,
    after: { label: created!.label, locality: created!.locality },
  });

  return { ok: true, location: created };
});

export const PATCH = route(async (ctx, req) => {
  requireRole(ctx, "editor");
  const body = await parseBody(req, updateSchema);
  const database = db();
  await repo.getBusiness(database, ctx, body.businessId);

  const [updated] = await database
    .update(businessLocations)
    .set({
      label: body.label.trim(),
      streetAddress: trimmed(body.streetAddress),
      locality: trimmed(body.locality),
      region: trimmed(body.region),
      postalCode: trimmed(body.postalCode),
      country: trimmed(body.country),
      phone: trimmed(body.phone),
      // A corrected address is a human judgement, whatever it was before.
      confidence: 1,
    })
    .where(and(
      eq(businessLocations.workspaceId, ctx.workspaceId),
      eq(businessLocations.businessId, body.businessId),
      eq(businessLocations.id, body.locationId),
    ))
    .returning();

  if (!updated) throw new AppError("not_found", "That location no longer exists.", { retryable: false });

  await repo.writeAudit(database, ctx, {
    action: "business.location_updated",
    entityType: "business",
    entityId: body.businessId,
    after: { label: updated.label, locality: updated.locality },
  });

  return { ok: true, location: updated };
});

export const DELETE = route(async (ctx, req) => {
  requireRole(ctx, "editor");
  const body = await parseBody(req, deleteSchema);
  const database = db();
  await repo.getBusiness(database, ctx, body.businessId);

  const [removed] = await database
    .delete(businessLocations)
    .where(and(
      eq(businessLocations.workspaceId, ctx.workspaceId),
      eq(businessLocations.businessId, body.businessId),
      eq(businessLocations.id, body.locationId),
    ))
    .returning({ label: businessLocations.label });

  if (!removed) throw new AppError("not_found", "That location no longer exists.", { retryable: false });

  await repo.writeAudit(database, ctx, {
    action: "business.location_removed",
    entityType: "business",
    entityId: body.businessId,
    before: { label: removed.label },
  });

  return { ok: true };
});
