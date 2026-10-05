export const dynamic = "force-dynamic";

import { and, eq } from "drizzle-orm";
import { requireRole } from "@ob/core";
import { integrations, repo } from "@ob/db";
import { GBP_PROVIDER } from "@ob/gmb";
import { route } from "@/lib/api";
import { db } from "@/lib/services";

/**
 * DELETE /api/integrations/google-business — disconnect Google Business Profile.
 *
 * Reviews already read stay, and so do their drafts: they are the client's
 * record, and reconnecting picks up where it left off.
 */
export const DELETE = route(async (ctx) => {
  requireRole(ctx, "admin");
  const database = db();
  await database.delete(integrations).where(and(
    eq(integrations.workspaceId, ctx.workspaceId), eq(integrations.provider, GBP_PROVIDER),
  ));
  await repo.writeAudit(database, ctx, {
    action: "integration.disconnected", entityType: "integration", entityId: GBP_PROVIDER,
  });
  return { ok: true };
});
