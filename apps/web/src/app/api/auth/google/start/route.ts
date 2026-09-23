export const dynamic = "force-dynamic";

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { config, newToken, AppError } from "@ob/core";

/**
 * GET /api/auth/google/start — begin the OAuth redirect.
 *
 * Two values are minted here and stashed in short-lived, httpOnly cookies:
 *
 *   state — returned by Google and compared on the way back. Without it, a
 *           third-party page can trigger this flow and land its own Google
 *           account into the victim's browser session (login CSRF).
 *   nonce — embedded in the ID token and compared after verification, which is
 *           what stops a token minted for another session being replayed here.
 *
 * Both are single-use and expire in ten minutes: the window only needs to cover
 * a person clicking through Google's consent screen.
 */

const STATE_COOKIE = "ob_oauth_state";
const NONCE_COOKIE = "ob_oauth_nonce";
const MODE_COOKIE = "ob_oauth_mode";
const TTL_SECONDS = 600;

export async function GET(req: Request): Promise<NextResponse> {
  const cfg = config();
  const clientId = cfg.GOOGLE_CLIENT_ID || cfg.GOOGLE_ADS_CLIENT_ID;
  const clientSecret = cfg.GOOGLE_CLIENT_SECRET || cfg.GOOGLE_ADS_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    // The button is only rendered when this is configured, so reaching here
    // means a direct request or a half-finished setup. Say which, plainly.
    throw new AppError(
      "validation_failed",
      "Google sign-in is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.",
      { retryable: false },
    );
  }

  const state = newToken(24);
  const nonce = newToken(24);
  const mode = new URL(req.url).searchParams.get("mode") === "signup" ? "signup" : "signin";

  const jar = await cookies();
  const secure = cfg.NODE_ENV === "production";
  const common = {
    httpOnly: true,
    secure,
    // `lax` rather than `strict`: the cookie has to survive Google's top-level
    // redirect back to us, which a strict cookie would not be sent on.
    sameSite: "lax" as const,
    path: "/",
    maxAge: TTL_SECONDS,
  };

  jar.set(STATE_COOKIE, state, common);
  jar.set(NONCE_COOKIE, nonce, common);
  jar.set(MODE_COOKIE, mode, common);

  const authorize = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", `${cfg.APP_URL}/api/auth/google/callback`);
  authorize.searchParams.set("response_type", "code");
  // Identity only. This flow signs people in; it does not read their mail or
  // their Business Profile, and asking for more than that is how consent
  // screens start looking alarming.
  authorize.searchParams.set("scope", "openid email profile");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("nonce", nonce);
  // Ask for the account chooser rather than silently reusing whichever Google
  // account the browser happens to be signed into.
  authorize.searchParams.set("prompt", "select_account");

  return NextResponse.redirect(authorize.toString());
}
