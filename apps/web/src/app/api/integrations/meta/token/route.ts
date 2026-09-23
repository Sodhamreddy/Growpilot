export const dynamic = "force-dynamic";

import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { AppError, requireRole, seal, config } from "@ob/core";
import { integrations, repo } from "@ob/db";
import { JOBS, payloadFrom } from "@ob/jobs";
import { exchangeForLongLivedToken, listPages, GraphError } from "@ob/social";
import { route, parseBody } from "@/lib/api";
import { db, getQueues } from "@/lib/services";

/**
 * POST /api/integrations/meta/token — connect by pasting a token.
 * DELETE — disconnect.
 *
 * An alternative to the OAuth redirect next door, for the case that flow
 * cannot run. Meta requires an App Domain with a real top-level domain, and
 * refuses `localhost`, so a local dev server cannot complete the redirect at
 * all without a tunnel or a fake hostname. A token generated in Meta's own
 * Graph API Explorer sidesteps that entirely: it is the same credential the
 * redirect would have produced, obtained by hand.
 *
 * Everything after the token is identical to the OAuth path — the same
 * long-lived exchange, the same page listing, the same sealed storage — so
 * whichever way a workspace connects, the sync job cannot tell the difference.
 *
 * The trade-off, which the UI states rather than hides: a user token from the
 * Explorer lasts about 60 days. OAuth re-authorises itself; this does not, so
 * it has to be re-pasted. That is a fair price for working today, and the
 * integration switches to OAuth with no data migration once the app has a
 * deployed URL.
 */

const schema = z.object({
  /*
   * A short-lived user token is expected and a long-lived one is accepted.
   * Exchanging an already-long-lived token is harmless — Meta returns an
   * equivalent one — so the caller does not have to know which they have.
   */
  token: z.string().trim().min(40, "That does not look like a Meta access token."),
});

export const POST = route(async (ctx, req) => {
  requireRole(ctx, "admin");
  const body = await parseBody(req, schema);
  const cfg = config();
  const database = db();

  if (!cfg.META_APP_ID || !cfg.META_APP_SECRET) {
    throw new AppError(
      "validation_failed",
      "META_APP_ID and META_APP_SECRET must be set before a token can be used.",
      { retryable: false },
    );
  }

  let pages;
  let longLivedToken: string;
  try {
    // Same two steps the OAuth callback takes. The exchange is what makes the
    // page tokens outlive the hour a fresh Explorer token is good for.
    const longLived = await exchangeForLongLivedToken(
      body.token, cfg.META_APP_ID, cfg.META_APP_SECRET,
    );
    longLivedToken = longLived.accessToken;
    pages = await listPages(longLivedToken);
  } catch (err) {
    if (err instanceof GraphError) {
      throw new AppError("validation_failed", err.message, { retryable: !err.permanent });
    }
    throw new AppError("internal", "Could not reach Meta with that token.", { cause: err });
  }

  if (pages.length === 0) {
    throw new AppError(
      "validation_failed",
      "That token works, but the account administers no Facebook Pages — so there are no insights to read. " +
        "Check the token was generated with pages_show_list and for the right account.",
      { retryable: false },
    );
  }

  const sealed = seal(JSON.stringify({
    userToken: longLivedToken,
    pages: pages.map((p) => ({
      id: p.id, name: p.name, accessToken: p.accessToken, instagramId: p.instagramId,
    })),
  }), cfg.CREDENTIAL_ENCRYPTION_KEY);

  const withInstagram = pages.filter((p) => p.instagramId);
  const entries = [
    { provider: "facebook", displayName: pages.map((p) => p.name).join(", "), externalId: pages[0]!.id },
    ...(withInstagram.length > 0
      ? [{
          provider: "instagram",
          displayName: withInstagram.map((p) => p.name).join(", "),
          externalId: withInstagram[0]!.instagramId!,
        }]
      : []),
  ];

  for (const entry of entries) {
    const [existing] = await database
      .select({ id: integrations.id })
      .from(integrations)
      .where(and(
        eq(integrations.workspaceId, ctx.workspaceId),
        eq(integrations.provider, entry.provider),
      ))
      .limit(1);

    const values = {
      status: "connected" as const,
      externalAccountId: entry.externalId,
      displayName: entry.displayName,
      credentialSealed: sealed,
      // Page tokens derived from a long-lived user token do not expire, so
      // recording the user token's own expiry would disconnect a working
      // integration on a date that means nothing to it.
      expiresAt: null,
      consecutiveFailures: 0,
      lastError: null,
    };

    if (existing) {
      await database.update(integrations).set(values).where(eq(integrations.id, existing.id));
    } else {
      await database.insert(integrations).values({
        workspaceId: ctx.workspaceId, provider: entry.provider, ...values,
      });
    }
  }

  await repo.writeAudit(database, ctx, {
    action: "integration.connected",
    entityType: "integration",
    entityId: pages[0]!.id,
    // The token itself is never logged, only what it turned out to reach.
    after: { method: "token", providers: entries.map((e) => e.provider), pages: pages.length },
  });

  /*
   * Sync straight away, rather than waiting for a schedule.
   *
   * Connecting and then seeing an empty page is indistinguishable from
   * connecting and having it silently fail — and the next scheduled run could
   * be hours away. Pulling a window immediately means the connection either
   * proves itself within a minute or reports why it could not.
   *
   * Enqueued outside the response path: Graph is slow enough that doing it
   * inline would hold the request open for tens of seconds, and a timeout
   * would look like a failed connection when the token is already stored.
   */
  const business = await repo.getPrimaryBusiness(database, ctx);
  let syncing = false;
  if (business) {
    try {
      await getQueues().enqueue(
        "analytics",
        JOBS.ingestMetrics,
        payloadFrom(ctx, { businessId: business.id, days: 30 }),
        { idempotencyKey: `meta-sync:${ctx.workspaceId}:${Date.now()}` },
      );
      syncing = true;
    } catch {
      // The connection is stored and valid; only the immediate pull failed.
      // Saying so beats failing the whole request over a queue hiccup.
      syncing = false;
    }
  }

  return {
    ok: true,
    pages: pages.map((p) => ({ name: p.name, instagram: Boolean(p.instagramId) })),
    instagram: withInstagram.length > 0,
    syncing,
  };
});

export const DELETE = route(async (ctx) => {
  requireRole(ctx, "admin");
  const database = db();

  /*
   * Both rows go together.
   *
   * They share one sealed credential, so removing only Facebook would leave
   * Instagram holding a reference to a token nothing else can reach — a
   * connection that looks live and cannot work.
   */
  for (const provider of ["facebook", "instagram"]) {
    await database.delete(integrations).where(and(
      eq(integrations.workspaceId, ctx.workspaceId),
      eq(integrations.provider, provider),
    ));
  }

  await repo.writeAudit(database, ctx, {
    action: "integration.disconnected",
    entityType: "integration",
    entityId: "meta",
    before: { providers: ["facebook", "instagram"] },
  });

  return { ok: true };
});
