import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { requireRole, seal, config } from "@ob/core";
import { integrations, repo } from "@ob/db";
import { fetchMeasurement } from "@ob/blog";
import { route, parseBody } from "@/lib/api";
import { db, getQueues } from "@/lib/services";
import { payloadFrom } from "@ob/jobs";
export const dynamic = "force-dynamic";
const schema = z.object({ businessId: z.string().uuid(), provider: z.enum(["google_search_console", "google_analytics"]),
  property: z.string().trim().min(1).max(500), serviceAccount: z.object({ client_email: z.string().email(), private_key: z.string().min(100).max(20000) }) });
export const POST = route(async (ctx, req) => {
  requireRole(ctx, "admin");
  const body = await parseBody(req, schema);
  await repo.getBusiness(db(), ctx, body.businessId);
  const credential = { clientEmail: body.serviceAccount.client_email, privateKey: body.serviceAccount.private_key, property: body.property };
  await fetchMeasurement(body.provider, credential, 1);
  const values = { workspaceId: ctx.workspaceId, scopeKey: body.businessId, provider: body.provider,
    displayName: body.property, credentialSealed: seal(JSON.stringify(credential), config().CREDENTIAL_ENCRYPTION_KEY), status: "connected" as const, lastError: null };
  const [row] = await db().insert(integrations).values(values).onConflictDoUpdate({ target: [integrations.workspaceId, integrations.provider, integrations.scopeKey], set: values }).returning();
  await getQueues().enqueue("analytics", "analytics.measurement", payloadFrom(ctx, { integrationId: row!.id }));
  await repo.writeAudit(db(), ctx, { action: "measurement.connected", entityType: "business", entityId: body.businessId, after: { provider: body.provider, property: body.property } });
  return { ok: true };
}, { rateLimit: { limit: 10, windowSeconds: 3600 } });
export const DELETE = route(async (ctx, req) => {
  requireRole(ctx, "admin");
  const body = await parseBody(req, schema.pick({ businessId: true, provider: true }));
  await repo.getBusiness(db(), ctx, body.businessId);
  await db().delete(integrations).where(and(eq(integrations.workspaceId, ctx.workspaceId), eq(integrations.provider, body.provider), eq(integrations.scopeKey, body.businessId)));
  return { ok: true };
});
