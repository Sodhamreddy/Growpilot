export const dynamic = "force-dynamic";

import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { requireRole, AppError } from "@ob/core";
import { businessFacts, repo } from "@ob/db";
import { route, parseBody } from "@/lib/api";
import { db } from "@/lib/services";

/**
 * Services a customer adds or removes by hand.
 *
 * Services live in `business_facts` under the "service" key, alongside the ones
 * the crawler extracted. A hand-entered service is stored `verified: true` with
 * no source URL — which is honest on both counts: a person vouched for it, and
 * it did not come from a page we read. The crawler's re-extraction deliberately
 * preserves verified facts, so adding a service here survives a re-crawl.
 */

const createSchema = z.object({
  businessId: z.string().uuid(),
  /** "Name — description", matching how extraction stores them. */
  value: z.string().min(2, "Give the service a name.").max(500),
});

const deleteSchema = z.object({
  businessId: z.string().uuid(),
  factId: z.string().uuid(),
});

export const GET = route(async (ctx, req) => {
  const businessId = new URL(req.url).searchParams.get("businessId");
  if (!businessId) return { services: [] };

  const facts = await repo.listFacts(db(), ctx, businessId);
  return {
    services: facts
      .filter((f) => f.key === "service")
      .map((f) => ({
        id: f.id,
        value: f.value,
        sourceUrl: f.sourceUrl,
        confidence: f.confidence,
        verified: f.verified,
      })),
  };
});

export const POST = route(async (ctx, req) => {
  requireRole(ctx, "editor");
  const body = await parseBody(req, createSchema);
  const database = db();

  // Confirms the business belongs to this workspace before writing to it.
  await repo.getBusiness(database, ctx, body.businessId);

  const value = body.value.trim();
  const existing = await repo.listFacts(database, ctx, body.businessId);
  if (existing.some((f) => f.key === "service" && f.value.toLowerCase() === value.toLowerCase())) {
    throw new AppError("conflict", "That service is already listed.", { retryable: false });
  }

  const [created] = await database
    .insert(businessFacts)
    .values({
      workspaceId: ctx.workspaceId,
      businessId: body.businessId,
      key: "service",
      value,
      sourceUrl: null,
      sourceQuote: null,
      // Entered by a person, so it carries full confidence and is exempt from
      // the re-crawl wipe that clears unverified extractions.
      confidence: 1,
      verified: true,
    })
    .returning();

  await repo.writeAudit(database, ctx, {
    action: "business.service_added",
    entityType: "business",
    entityId: body.businessId,
    after: { value },
  });

  return { ok: true, service: { id: created!.id, value: created!.value, verified: true } };
});

export const DELETE = route(async (ctx, req) => {
  requireRole(ctx, "editor");
  const body = await parseBody(req, deleteSchema);
  const database = db();

  await repo.getBusiness(database, ctx, body.businessId);

  const [removed] = await database
    .delete(businessFacts)
    .where(and(
      eq(businessFacts.workspaceId, ctx.workspaceId),
      eq(businessFacts.businessId, body.businessId),
      eq(businessFacts.id, body.factId),
      eq(businessFacts.key, "service"),
    ))
    .returning({ value: businessFacts.value });

  if (!removed) throw new AppError("not_found", "That service no longer exists.", { retryable: false });

  await repo.writeAudit(database, ctx, {
    action: "business.service_removed",
    entityType: "business",
    entityId: body.businessId,
    before: { value: removed.value },
  });

  return { ok: true };
});
