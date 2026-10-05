export const dynamic = "force-dynamic";

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { config, seal } from "@ob/core";
import { businesses, integrations, repo } from "@ob/db";
import {
  GBP_PROVIDER, GBP_SCOPE, GoogleApiError, exchangeGoogleCode, googleCredentials, listGbpLocations,
  type SealedGoogle,
} from "@ob/gmb";
import { requireTenant } from "@/lib/auth";
import { db } from "@/lib/services";
import { GBP_STATE_COOKIE } from "@/lib/google-business";

/**
 * GET /api/integrations/google-business/callback — finish the connect.
 *
 * Stores the refresh token sealed, then asks Google for the listings this
 * account manages, straight away. That one call answers the question that
 * matters most on this page: whether Google has approved Business Profile API
 * access for the project yet. A connection is kept either way; while access
 * is pending the page says so and reads reviews through the Places API.
 */

function back(reason: string, ok = false): NextResponse {
  const url = new URL(`${config().APP_URL}/reviews`);
  url.searchParams.set(ok ? "google" : "google_error", reason);
  return NextResponse.redirect(url.toString());
}

export async function GET(req: Request): Promise<NextResponse> {
  const ctx = await requireTenant();
  const cfg = config();
  const creds = googleCredentials(cfg);
  const params = new URL(req.url).searchParams;

  const jar = await cookies();
  const expected = jar.get(GBP_STATE_COOKIE)?.value;
  jar.delete(GBP_STATE_COOKIE);

  if (params.get("error")) return back(params.get("error") === "access_denied" ? "cancelled" : "failed");
  const state = params.get("state");
  if (!expected || !state || state !== expected) return back("state_mismatch");
  if (expected.split(".")[1] !== ctx.workspaceId) return back("wrong_workspace");
  const code = params.get("code");
  if (!code) return back("failed");
  if (!creds.clientId || !creds.clientSecret) return back("not_configured");

  let tokens;
  try {
    tokens = await exchangeGoogleCode(code, creds.clientId, creds.clientSecret, `${cfg.APP_URL}/api/integrations/google-business/callback`);
  } catch {
    return back("exchange_failed");
  }
  // Someone can untick the Business Profile box on the consent screen.
  if (!tokens.scopes.includes(GBP_SCOPE)) return back("scope_declined");
  if (!tokens.refreshToken) return back("no_refresh_token");

  const database = db();
  const sealed = seal(JSON.stringify({ refreshToken: tokens.refreshToken, email: tokens.email } satisfies SealedGoogle), cfg.CREDENTIAL_ENCRYPTION_KEY);

  // The access check, and the listings when access exists.
  let outcome: "connected" | "pending" | "disabled" = "connected";
  let accessNote: string | null = null;
  let locations: Awaited<ReturnType<typeof listGbpLocations>> = [];
  try {
    locations = await listGbpLocations(tokens.accessToken);
  } catch (err) {
    if (!(err instanceof GoogleApiError)) throw err;
    outcome = err.kind === "access_pending" ? "pending" : err.kind === "api_disabled" ? "disabled" : "connected";
    accessNote = err.message;
  }

  const values = {
    status: "connected" as const,
    displayName: tokens.email ?? "Google account",
    externalAccountId: tokens.email ?? "google",
    credentialSealed: sealed,
    scopes: tokens.scopes,
    expiresAt: null,
    consecutiveFailures: 0,
    lastError: accessNote,
  };
  const [existing] = await database.select({ id: integrations.id }).from(integrations)
    .where(and(eq(integrations.workspaceId, ctx.workspaceId), eq(integrations.provider, GBP_PROVIDER))).limit(1);
  if (existing) await database.update(integrations).set(values).where(eq(integrations.id, existing.id));
  else await database.insert(integrations).values({ workspaceId: ctx.workspaceId, provider: GBP_PROVIDER, ...values });

  // One listing is this client's listing; with several, the person chooses on the page.
  const business = await repo.getPrimaryBusiness(database, ctx);
  if (business && locations.length === 1 && !business.googleListing?.gbpLocation) {
    const l = locations[0]!;
    await database.update(businesses).set({
      googleListing: {
        ...(business.googleListing ?? {}),
        gbpLocation: l.name, gbpTitle: l.title,
        placeId: business.googleListing?.placeId ?? l.placeId ?? undefined,
        title: business.googleListing?.title ?? l.title,
        address: business.googleListing?.address ?? l.address ?? undefined,
        mapsUri: business.googleListing?.mapsUri ?? l.mapsUri ?? undefined,
      },
      updatedAt: new Date(),
    }).where(and(eq(businesses.workspaceId, ctx.workspaceId), eq(businesses.id, business.id)));
  }

  await repo.writeAudit(database, ctx, {
    action: "integration.connected", entityType: "integration", entityId: GBP_PROVIDER,
    after: { provider: GBP_PROVIDER, access: outcome, locations: locations.length },
  });
  return back(outcome, true);
}
