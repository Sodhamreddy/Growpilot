export const dynamic = "force-dynamic";

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { config, newToken } from "@ob/core";
import { GBP_SCOPE, googleCredentials } from "@ob/gmb";
import { requireTenant } from "@/lib/auth";
import { GBP_STATE_COOKIE } from "@/lib/google-business";

/**
 * GET /api/integrations/google-business/start — connect Google Business Profile.
 *
 * Like the Meta connect: this authorises access to a listing's reviews, not
 * sign-in, so the person is already signed in and the grant is stored against
 * their workspace. The workspace rides in `state` for the same reason as
 * there: switching accounts mid-consent must not attach one client's listing
 * to another workspace.
 *
 * `access_type=offline` and `prompt=consent` together are what make Google
 * return a refresh token every time. Without the prompt it returns one only
 * on the very first consent, and a reconnect would store a connection that
 * stops working an hour later.
 */

export async function GET(): Promise<NextResponse> {
  const ctx = await requireTenant();
  const cfg = config();
  const creds = googleCredentials(cfg);
  if (!creds.clientId || !creds.clientSecret) {
    return NextResponse.redirect(`${cfg.APP_URL}/reviews?google_error=not_configured`);
  }

  const state = `${newToken(24)}.${ctx.workspaceId}`;
  (await cookies()).set(GBP_STATE_COOKIE, state, {
    httpOnly: true, secure: cfg.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 600,
  });

  const authorize = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authorize.searchParams.set("client_id", creds.clientId);
  authorize.searchParams.set("redirect_uri", `${cfg.APP_URL}/api/integrations/google-business/callback`);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", `openid email ${GBP_SCOPE}`);
  authorize.searchParams.set("access_type", "offline");
  authorize.searchParams.set("prompt", "consent");
  authorize.searchParams.set("include_granted_scopes", "true");
  authorize.searchParams.set("state", state);
  return NextResponse.redirect(authorize.toString());
}
