export const dynamic = "force-dynamic";

import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { AppError, requireRole, seal, config } from "@ob/core";
import { integrations, repo } from "@ob/db";
import { verifyConnection, type WordPressCredential } from "@ob/publish";
import { route, parseBody } from "@/lib/api";
import { db } from "@/lib/services";

/**
 * WordPress connection — spec §11.1.
 *
 * POST connects (or reconnects) the site; DELETE disconnects it.
 *
 * The credential is verified against the live site before it is stored, so a
 * connection that appears in the UI is one that actually works. It is sealed
 * with AES-256-GCM on the way in and never leaves the server again — not in
 * this route's response, not in the integrations list. An application password
 * is equivalent to a login, and a credential that can be read back out of an
 * API is a credential that leaks.
 */

const connectSchema = z.object({
  businessId: z.string().uuid(),
  /** Site root, e.g. https://example.com */
  baseUrl: z.string().url("Enter the full site address, including https://"),
  username: z.string().min(1, "Enter the WordPress username."),
  /** Application Password — WordPress shows it in space-separated groups. */
  applicationPassword: z.string().min(1, "Paste the application password."),
});

export const POST = route(async (ctx, req) => {
  // Connecting a publishing target is an outward-facing capability: anyone who
  // can do it can cause content to appear on the customer's own website.
  requireRole(ctx, "admin");

  const body = await parseBody(req, connectSchema);
  const database = db();
  await repo.getBusiness(database, ctx, body.businessId);

  const credential: WordPressCredential = {
    baseUrl: body.baseUrl.trim(),
    username: body.username.trim(),
    applicationPassword: body.applicationPassword,
  };

  // Verify before storing. This reaches the customer's site, so its failures
  // are already written for a person to read — surfacing them unchanged is
  // more useful than a generic "could not connect".
  const identity = await verifyConnection(credential);

  if (!identity.canPublish) {
    throw new AppError(
      "forbidden",
      "That WordPress user cannot create posts. Use an account with the Author, Editor or " +
        "Administrator role.",
      { details: { user: identity.displayName }, retryable: false },
    );
  }

  const sealed = seal(JSON.stringify(credential), config().CREDENTIAL_ENCRYPTION_KEY);

  await database
    .insert(integrations)
    .values({
      workspaceId: ctx.workspaceId,
      provider: "wordpress",
      scopeKey: body.businessId,
      status: "connected",
      externalAccountId: String(identity.userId),
      displayName: identity.displayName + " · " + new URL(credential.baseUrl).host,
      scopes: ["posts:write"],
      credentialSealed: sealed,
      consecutiveFailures: 0,
      lastError: null,
      connectedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [integrations.workspaceId, integrations.provider, integrations.scopeKey],
      set: {
        status: "connected",
        externalAccountId: String(identity.userId),
        displayName: identity.displayName + " · " + new URL(credential.baseUrl).host,
        credentialSealed: sealed,
        consecutiveFailures: 0,
        lastError: null,
        connectedAt: new Date(),
      },
    });

  await repo.writeAudit(database, ctx, {
    action: "integration.connected",
    entityType: "integration",
    entityId: "wordpress",
    // The credential itself is deliberately absent from the audit record.
    after: { provider: "wordpress", site: new URL(credential.baseUrl).host, user: identity.displayName },
  });

  return {
    ok: true,
    provider: "wordpress",
    site: new URL(credential.baseUrl).host,
    user: identity.displayName,
  };
});

export const DELETE = route(async (ctx, req) => {
  const body = await parseBody(req, z.object({ businessId: z.string().uuid() }));
  requireRole(ctx, "admin");
  const database = db();

  await database
    .delete(integrations)
    .where(and(
      eq(integrations.workspaceId, ctx.workspaceId),
      eq(integrations.provider, "wordpress"),
      eq(integrations.scopeKey, body.businessId),
    ));

  await repo.writeAudit(database, ctx, {
    action: "integration.disconnected",
    entityType: "integration",
    entityId: "wordpress",
    after: { provider: "wordpress" },
  });

  return { ok: true };
});
