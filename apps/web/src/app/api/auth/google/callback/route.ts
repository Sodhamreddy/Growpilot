export const dynamic = "force-dynamic";

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { config } from "@ob/core";
import { signInWithGoogle, createSession } from "@/lib/auth";

/**
 * GET /api/auth/google/callback — finish the OAuth redirect.
 *
 * Order matters here, and each step exists to stop a specific attack:
 *
 *   1. Compare `state` against the cookie, in constant time. Without this a
 *      third-party page can start the flow and land its own Google account in
 *      the victim's browser.
 *   2. Exchange the code at Google's token endpoint using the client secret.
 *      The code alone is useless to anyone who intercepts the redirect.
 *   3. Verify the ID token's signature against Google's published keys, and
 *      check issuer, audience and expiry. An unverified JWT is just a string
 *      the caller chose.
 *   4. Compare `nonce` against the cookie, which ties the token to this browser
 *      and this attempt.
 *
 * Failures redirect back to /signin with a short reason rather than rendering
 * an error page: whatever went wrong, the useful next step is to try again.
 */

const STATE_COOKIE = "ob_oauth_state";
const NONCE_COOKIE = "ob_oauth_nonce";
const MODE_COOKIE = "ob_oauth_mode";

const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";

function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

function back(reason: string): NextResponse {
  const cfg = config();
  return NextResponse.redirect(`${cfg.APP_URL}/signin?auth_error=${encodeURIComponent(reason)}`);
}

export async function GET(req: Request): Promise<NextResponse> {
  const cfg = config();
  const clientId = cfg.GOOGLE_CLIENT_ID || cfg.GOOGLE_ADS_CLIENT_ID;
  const clientSecret = cfg.GOOGLE_CLIENT_SECRET || cfg.GOOGLE_ADS_CLIENT_SECRET;
  const url = new URL(req.url);
  const jar = await cookies();

  const clear = (res: NextResponse) => {
    for (const name of [STATE_COOKIE, NONCE_COOKIE, MODE_COOKIE]) {
      res.cookies.set(name, "", { path: "/", maxAge: 0 });
    }
    return res;
  };

  // Google reports a declined consent screen this way; it is not an error.
  if (url.searchParams.get("error")) {
    return clear(back("cancelled"));
  }

  if (!clientId || !clientSecret) {
    return clear(back("not_configured"));
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expectedState = jar.get(STATE_COOKIE)?.value;
  const expectedNonce = jar.get(NONCE_COOKIE)?.value;
  const mode = jar.get(MODE_COOKIE)?.value === "signup" ? "signup" : "signin";

  if (!code || !state || !expectedState || !expectedNonce) {
    return clear(back("expired"));
  }
  if (!constantTimeEqual(state, expectedState)) {
    return clear(back("state_mismatch"));
  }

  // ── Exchange the code ──
  let idToken: string;
  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: `${cfg.APP_URL}/api/auth/google/callback`,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenRes.ok) return clear(back("exchange_failed"));

    const tokens = (await tokenRes.json()) as { id_token?: string };
    if (!tokens.id_token) return clear(back("no_id_token"));
    idToken = tokens.id_token;
  } catch {
    return clear(back("google_unreachable"));
  }

  // ── Verify the ID token ──
  let claims: {
    iss?: string; aud?: string; exp?: number; nonce?: string;
    email?: string; email_verified?: boolean | string; name?: string;
  };
  try {
    claims = await verifyGoogleIdToken(idToken, clientId);
  } catch {
    return clear(back("token_invalid"));
  }

  if (!claims.nonce || !constantTimeEqual(claims.nonce, expectedNonce)) {
    return clear(back("nonce_mismatch"));
  }
  if (!claims.email) {
    return clear(back("no_email"));
  }

  // Google sends this as a boolean or the string "true" depending on the path.
  const emailVerified = claims.email_verified === true || claims.email_verified === "true";

  try {
    const result = await signInWithGoogle({
      email: claims.email,
      emailVerified,
      name: claims.name ?? null,
    });
    await createSession(result);

    // A brand-new account has nothing set up, so it starts the flow. An
    // existing one resumes, whichever button they happened to press.
    const destination = result.created || mode === "signup" ? "/onboarding" : "/home";
    return clear(NextResponse.redirect(`${cfg.APP_URL}${destination}`));
  } catch {
    return clear(back("sign_in_failed"));
  }
}

/**
 * Verify a Google ID token against their published signing keys.
 *
 * Written out rather than pulled from a library because it is short, and
 * because the checks it performs are exactly the ones that must not be skipped:
 * a JWT whose signature is not verified carries no more authority than a query
 * parameter.
 */
async function verifyGoogleIdToken(
  idToken: string,
  audience: string,
): Promise<Record<string, unknown>> {
  const { createLocalJWKSet, jwtVerify } = await import("jose");

  const jwksRes = await fetch(JWKS_URL, { cache: "no-store" });
  if (!jwksRes.ok) throw new Error("Could not fetch Google signing keys.");
  const jwks = createLocalJWKSet((await jwksRes.json()) as Parameters<typeof createLocalJWKSet>[0]);

  const { payload } = await jwtVerify(idToken, jwks, {
    issuer: [...GOOGLE_ISSUERS],
    audience,
    // Signature, issuer, audience and expiry are all checked here; `jose`
    // throws on any of them rather than returning a partially-trusted result.
  });

  return payload as Record<string, unknown>;
}
