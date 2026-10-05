export const dynamic = "force-dynamic";

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { config, newToken } from "@ob/core";
import { requireTenant } from "@/lib/auth";

/**
 * GET /api/integrations/meta/start — begin the Facebook/Instagram connect.
 *
 * Distinct from the Google sign-in flow next door in one way that matters:
 * this authorises *access to data*, not identity. A person is already signed
 * in when they reach here, so the session is what identifies them and the
 * token that comes back is stored against their workspace rather than used to
 * log anybody in.
 *
 * The `state` cookie carries the workspace id alongside the nonce. Without it
 * the callback would have to trust whichever session happens to be active when
 * Meta redirects back, and a person who switched accounts mid-flow would
 * attach a client's Facebook page to the wrong workspace.
 */

const STATE_COOKIE = "ob_meta_state";
const TTL_SECONDS = 600;

/*
 * Scopes, and why each is here.
 *
 *   pages_show_list          — enumerate the pages this person administers, so
 *                              they can pick which one belongs to the client.
 *   pages_read_engagement    — page-level insights: reach, impressions,
 *                              engagement.
 *   read_insights            — the historical series behind the trend chart.
 *   instagram_basic          — resolve the Instagram account linked to a page.
 *   instagram_manage_insights— Instagram reach and engagement.
 *
 * Plus publishing, now that the Schedule step posts: pages_manage_posts for
 * Page photos and instagram_content_publish for Instagram. Until App Review
 * approves those, Meta grants them only to people with a role on the app,
 * and the callback records what was actually granted so the schedule page
 * can say which networks will work rather than failing at posting time.
 */
const SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "read_insights",
  "instagram_basic",
  "instagram_manage_insights",
  "pages_manage_posts",
  "instagram_content_publish",
].join(",");

/** Where a person may be sent back to. Internal pages only, never a full URL. */
const RETURN_TO = new Set(["/social-insights", "/social/schedule"]);
const RETURN_COOKIE = "ob_meta_return";

export async function GET(req: Request): Promise<NextResponse> {
  const ctx = await requireTenant();
  const cfg = config();

  /*
   * Send them back, do not throw.
   *
   * This route's whole job is to redirect, so a thrown error surfaced as a
   * bare "HTTP ERROR 500" page with no explanation and no way back — the
   * browser's own error screen, not ours. Redirecting to the page they came
   * from, with a code it knows how to phrase, keeps the failure inside the
   * product.
   *
   * Missing credentials is the most likely case by far: the app has to be
   * registered with Meta before this can work at all.
   */
  if (!cfg.META_APP_ID || !cfg.META_APP_SECRET) {
    const url = new URL(`${cfg.APP_URL}/social-insights`);
    url.searchParams.set("meta_error", "not_configured");
    return NextResponse.redirect(url.toString());
  }

  const nonce = newToken(24);
  const state = `${nonce}.${ctx.workspaceId}`;

  const jar = await cookies();
  jar.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: cfg.NODE_ENV === "production",
    // `lax`, not `strict`: the cookie has to survive Meta's top-level redirect
    // back to us, which a strict cookie would not be sent on.
    sameSite: "lax",
    path: "/",
    maxAge: TTL_SECONDS,
  });
  const returnTo = new URL(req.url).searchParams.get("return") ?? "";
  jar.set(RETURN_COOKIE, RETURN_TO.has(returnTo) ? returnTo : "/social-insights", {
    httpOnly: true, secure: cfg.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: TTL_SECONDS,
  });

  const authorize = new URL("https://www.facebook.com/v24.0/dialog/oauth");
  authorize.searchParams.set("client_id", cfg.META_APP_ID);
  authorize.searchParams.set("redirect_uri", `${cfg.APP_URL}/api/integrations/meta/callback`);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", SCOPES);
  authorize.searchParams.set("state", state);
  // Ask again for anything declined last time; Meta otherwise skips it silently.
  authorize.searchParams.set("auth_type", "rerequest");

  return NextResponse.redirect(authorize.toString());
}
