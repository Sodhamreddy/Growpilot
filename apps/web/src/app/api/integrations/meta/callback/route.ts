export const dynamic = "force-dynamic";

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { config, seal } from "@ob/core";
import { integrations, repo } from "@ob/db";
import { exchangeForLongLivedToken, listPages, GraphError } from "@ob/social";
import { requireTenant } from "@/lib/auth";
import { db } from "@/lib/services";

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

function back(reason: string | null): NextResponse {
  const url = new URL(`${config().APP_URL}/social-insights`);
  if (reason) url.searchParams.set("meta_error", reason);
  else url.searchParams.set("meta", "connected");
  return NextResponse.redirect(url.toString());
}

export async function GET(req: Request): Promise<NextResponse> {
  const ctx = await requireTenant();
  const cfg = config();
  const params = new URL(req.url).searchParams;

  const jar = await cookies();
  const expected = jar.get(STATE_COOKIE)?.value;
  jar.delete(STATE_COOKIE);

  // Meta sends `error=access_denied` when somebody closes the consent screen.
  // Not a failure worth an alarming message — they simply changed their mind.
  if (params.get("error")) return back("cancelled");

  const state = params.get("state");
  if (!expected || !state || state !== expected) return back("state_mismatch");

  /*
   * The workspace comes from the state cookie, not from the session.
   *
   * A person who switched accounts in another tab during the consent screen
   * would otherwise attach this page to whichever workspace is active on the
   * way back, which is how a client's Facebook data lands in someone else's
   * dashboard.
   */
  const [, stateWorkspaceId] = expected.split(".");
  if (!stateWorkspaceId || stateWorkspaceId !== ctx.workspaceId) return back("wrong_workspace");

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
