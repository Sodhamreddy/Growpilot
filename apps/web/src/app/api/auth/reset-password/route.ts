export const dynamic = "force-dynamic";

import { z } from "zod";
import { publicRoute, parseBody } from "@/lib/api";
import { completePasswordReset, checkResetToken } from "@/lib/auth";

/**
 * Complete a password reset — spec §2.1.
 *
 * GET  — is this token still usable? Lets the page show the form or an
 *        explanation, rather than accepting a password and only then admitting
 *        the link expired.
 * POST — set the new password.
 *
 * Succeeding here signs the account out everywhere, which `completePasswordReset`
 * handles. No session is created: whoever just reset the password proves they
 * hold the new one by signing in with it. Logging them straight in would mean a
 * leaked link grants access without the password ever being known.
 */

const schema = z.object({
  token: z.string().min(10, "That reset link is not valid."),
  password: z
    .string()
    .min(12, "Use at least 12 characters.")
    .max(200),
});

export const GET = publicRoute(async (req) => {
  const token = new URL(req.url).searchParams.get("token") ?? "";
  if (!token) return { valid: false };
  return { valid: await checkResetToken(token) };
});

export const POST = publicRoute(
  async (req) => {
    const body = await parseBody(req, schema);
    await completePasswordReset(body.token, body.password);

    return {
      ok: true,
      message: "Your password has been changed. Sign in with it to continue.",
    };
  },
  // Tokens are 32 random bytes, so guessing is not the threat; this caps the
  // damage from a script hammering the endpoint with stolen candidates.
  { rateLimit: { limit: 10, windowSeconds: 900 } },
);
