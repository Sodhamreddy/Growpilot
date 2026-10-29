export const dynamic = "force-dynamic";

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { config, seal, hasRole } from "@ob/core";
import { businesses, integrations, repo } from "@ob/db";
import { exchangeForLongLivedToken, listPages, grantedPermissions, GraphError } from "@ob/social";
import { requireTenant } from "@/lib/auth";
import { JOBS, payloadFrom } from "@ob/jobs";
import { db, getQueues } from "@/lib/services";
import { readIntegrationState } from "@/lib/integration-state";

/**
 * GET /api/integrations/meta/callback — finish the connect.
 *
 * Redirects rather than rendering: the useful next step is always the insights
 * page, and every failure here is something a person retries from there. A
 * short code travels in the query string and the page turns it into a
 * sentence, so nothing technical reaches the customer.
 *
 * ── The step that is easy to skip ──
 *
 * The code Meta returns buys a short-lived user token, good for about an hour.
 * Page tokens derived from it inherit that hour, so a sync built on them works
 * during testing and stops overnight — with no error, because the token is
 * simply gone. `exchangeForLongLivedToken` converts it to a 60-day token
 * first, and page tokens read from *that* do not expire at all.
 */

const STATE_COOKIE = "ob_meta_state";
const RETURN_COOKIE = "ob_meta_return";
/** Where a connect may return to. The cookie is ours, but it is still checked. */
const RETURN_TO = new Set(["/social-insights", "/social/schedule"]);

function backTo(path: string, reason: string | null): NextResponse {
  const url = new URL(`${config().APP_URL}${RETURN_TO.has(path) ? path : "/social-insights"}`);
  if (reason) url.searchParams.set("meta_error", reason);
  else url.searchParams.set("meta", "connected");
  return NextResponse.redirect(url.toString());
}

export async function GET(req: Request): Promise<NextResponse> {
  const ctx = await requireTenant();
  if (!hasRole(ctx, "admin")) return NextResponse.json({ error: { message: "Only admins can manage connections." } }, { status: 403 });
  const cfg = config();
  const params = new URL(req.url).searchParams;

  const jar = await cookies();
  const expected = jar.get(STATE_COOKIE)?.value;
  jar.delete(STATE_COOKIE);
  const returnTo = jar.get(RETURN_COOKIE)?.value ?? "/social-insights";
  jar.delete(RETURN_COOKIE);
  const back = (reason: string | null) => backTo(returnTo, reason);

  // Meta sends `error=access_denied` when somebody closes the consent screen.
  // Not a failure worth an alarming message — they simply changed their mind.
  if (params.get("error")) return back("cancelled");

  const state = params.get("state");
  const binding = readIntegrationState(expected, state, ctx);
  if (!binding) return back("state_mismatch");

  /*
   * The workspace comes from the state cookie, not from the session.
   *
   * A person who switched accounts in another tab during the consent screen
   * would otherwise attach this page to whichever workspace is active on the
   * way back, which is how a client's Facebook data lands in someone else's
   * dashboard.
   */
  const business = binding.businessId ? await repo.getBusiness(db(), ctx, binding.businessId).catch(() => null) : null;
  if (binding.businessId && !business) return back("state_mismatch");

  const code = params.get("code");
  if (!code) return back("no_code");
  if (!cfg.META_APP_ID || !cfg.META_APP_SECRET) return back("not_configured");

  try {
    // 1. The code buys a short-lived user token.
    const tokenUrl = new URL("https://graph.facebook.com/v24.0/oauth/access_token");
    tokenUrl.searchParams.set("client_id", cfg.META_APP_ID);
    tokenUrl.searchParams.set("client_secret", cfg.META_APP_SECRET);
    tokenUrl.searchParams.set("redirect_uri", `${cfg.APP_URL}/api/integrations/meta/callback`);
    tokenUrl.searchParams.set("code", code);

    const tokenRes = await fetch(tokenUrl.toString(), { signal: AbortSignal.timeout(20_000) });
    const tokenBody = (await tokenRes.json().catch(() => ({}))) as {
      access_token?: string; error?: unknown;
    };
    if (!tokenRes.ok || !tokenBody.access_token) return back("exchange_failed");

    // 2. Trade it for one that outlives the session. See the note above.
    const longLived = await exchangeForLongLivedToken(
      tokenBody.access_token, cfg.META_APP_ID, cfg.META_APP_SECRET,
    );

    // 3. Read the pages, with their own tokens and any linked Instagram.
    const pages = await listPages(longLived.accessToken);
    if (pages.length === 0) return back("no_pages");

    // What was granted, not what was asked for: a person can untick posting on
    // the consent screen, and the schedule page needs to know before it tries.
    const scopes = await grantedPermissions(longLived.accessToken).catch(() => [] as string[]);

    /*
     * One row per network, sharing the same page token.
     *
     * Stored separately because the dashboard filters by channel and a person
     * may want Instagram without Facebook. The unique index is on
     * (workspace, provider), so reconnecting updates rather than duplicating.
     */
    const database = db();
    const sealed = seal(JSON.stringify({
      userToken: longLived.accessToken,
      pages: pages.map((p) => ({
        id: p.id, name: p.name, accessToken: p.accessToken, instagramId: p.instagramId,
      })),
    }), cfg.CREDENTIAL_ENCRYPTION_KEY);

    const withInstagram = pages.filter((p) => p.instagramId);
    const providers: { provider: string; displayName: string; externalId: string }[] = [
      { provider: "facebook", displayName: pages.map((p) => p.name).join(", "), externalId: pages[0]!.id },
      ...(withInstagram.length > 0
        ? [{
            provider: "instagram",
            displayName: withInstagram.map((p) => p.name).join(", "),
            externalId: withInstagram[0]!.instagramId!,
          }]
        : []),
    ];

    for (const entry of providers) {
      const existing = await database
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
        scopes,
        // Page tokens from a long-lived user token do not expire. Recording
        // the user token's expiry would disconnect a working integration on a
        // date that means nothing.
        expiresAt: null,
        consecutiveFailures: 0,
        lastError: null,
      };

      if (existing[0]) {
        await database.update(integrations).set(values)
          .where(eq(integrations.id, existing[0].id));
      } else {
        await database.insert(integrations).values({
          workspaceId: ctx.workspaceId, provider: entry.provider, ...values,
        });
      }
    }

    /*
     * One Page is this client's Page.
     *
     * Choosing from a list of one is a step that only exists to be clicked,
     * and "log in and it is connected" is the whole point of the button. With
     * several Pages (an agency's login) the person still picks, on the page
     * they return to, because guessing would post to someone else's audience.
     */
    if (business && !business.metaPageId && pages.length === 1) {
      await database
        .update(businesses)
        .set({ metaPageId: pages[0]!.id, metaPageName: pages[0]!.name, updatedAt: new Date() })
        .where(and(eq(businesses.workspaceId, ctx.workspaceId), eq(businesses.id, business.id)));
    }

    // Start this client's first refresh immediately; a temporary queue outage
    // does not discard the successfully saved connection.
    if (business && (pages.some((p) => p.id === business.metaPageId) || (!business.metaPageId && pages.length === 1))) {
      await getQueues().enqueue("analytics", JOBS.ingestMetrics,
        payloadFrom(ctx, { businessId: business.id, days: 30 }),
        { idempotencyKey: `meta-sync:${business.id}:${Date.now()}` }).catch(() => undefined);
    }

    await repo.writeAudit(database, ctx, {
      action: "integration.connected",
      entityType: "integration",
      entityId: pages[0]!.id,
      after: { providers: providers.map((p) => p.provider), pages: pages.length },
    });

    return back(null);
  } catch (err) {
    // A classified Graph failure carries a message worth keeping; anything
    // else is reported generically rather than leaking an internal error.
    return back(err instanceof GraphError ? "graph_error" : "failed");
  }
}
