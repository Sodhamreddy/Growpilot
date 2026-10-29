import { sendPasswordReset } from "@/lib/email";
export const dynamic = "force-dynamic";

import { z } from "zod";
import { AppError, config } from "@ob/core";
import { publicRoute, parseBody } from "@/lib/api";
import { beginPasswordReset } from "@/lib/auth";

/**
 * POST /api/auth/forgot-password — spec §2.1.
 *
 * Always answers the same way, whether or not the address has an account.
 * Whether someone banks here is not public information, and a form that says
 * "no such account" is a user-enumeration endpoint no matter what else it does.
 * The person who owns the inbox finds out; nobody else does.
 *
 * Production delivers via Resend; local development displays the link for testing.
 */

const schema = z.object({
  email: z.string().email("Enter a valid email address."),
});

export const POST = publicRoute(
  async (req) => {
    const body = await parseBody(req, schema);
    const cfg = config();

    if (cfg.NODE_ENV === "production" && (!cfg.RESEND_API_KEY || !cfg.EMAIL_FROM)) {
      throw new AppError("dependency_unavailable", "Password recovery is temporarily unavailable. Contact your administrator.");
    }
    const started = await beginPasswordReset(body.email);

    const sameAnswer = {
      ok: true,
      message:
        "If that address has an account, a reset link is on its way. " +
        "The link is valid for one hour.",
    };

    if (!started) return sameAnswer;

    const resetUrl = `${cfg.APP_URL}/reset-password?token=${encodeURIComponent(started.token)}`;

    const isProduction = cfg.NODE_ENV === "production";

    if (isProduction) {
      // Keep the public response identical for registered and unknown addresses.
      try { await sendPasswordReset(body.email, resetUrl); }
      catch { console.error("[auth] Reset delivery failed; check the email provider."); }
      return sameAnswer;
    }

    console.info(`[auth] Password reset link (development only): ${resetUrl}`);

    return {
      ...sameAnswer,
      // Development convenience, and clearly labelled as such so it cannot be
      // mistaken for behaviour that survives into production.
      devResetUrl: resetUrl,
      devNote:
        "Development mode shows the link here instead of sending an email. " +
        "This only happens outside production.",
    };
  },
  /*
   * Rate limited per IP.
   *
   * Each request invalidates the previous link for that account, so an
   * unlimited endpoint lets anyone who knows an address keep that account's
   * reset permanently broken by requesting a new token faster than the owner
   * can use one.
   */
  { rateLimit: { limit: 5, windowSeconds: 900 } },
);
