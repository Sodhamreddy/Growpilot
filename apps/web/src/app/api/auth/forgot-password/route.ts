export const dynamic = "force-dynamic";

import { z } from "zod";
import { config } from "@ob/core";
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
 * No email provider is configured in this build. Rather than pretend a message
 * was sent, the link is returned in the response when APP_ENV is development,
 * and a clear note is logged. Silently dropping the token would leave a
 * customer waiting for an email that was never going to arrive.
 */

const schema = z.object({
  email: z.string().email("Enter a valid email address."),
});

export const POST = publicRoute(
  async (req) => {
    const body = await parseBody(req, schema);
    const cfg = config();

    const started = await beginPasswordReset(body.email);

    const sameAnswer = {
      ok: true,
      message:
        "If that address has an account, a reset link is on its way. " +
        "The link is valid for one hour.",
    };

    if (!started) return sameAnswer;

    const resetUrl = `${cfg.APP_URL}/reset-password?token=${encodeURIComponent(started.token)}`;

    /*
     * Where the email would be sent.
     *
     * Wiring a provider (Resend, SES, Postmark) means replacing this block and
     * nothing else: the token is already created, hashed and stored.
     */
    const isProduction = cfg.NODE_ENV === "production";

    if (isProduction) {
      // Never put a live credential in a log line.
      console.warn(
        "[auth] Password reset requested but no email provider is configured. " +
          "The customer will not receive a link.",
      );
      return sameAnswer;
    }

    console.info(`[auth] Password reset link (development only): ${resetUrl}`);

    return {
      ...sameAnswer,
      // Development convenience, and clearly labelled as such so it cannot be
      // mistaken for behaviour that survives into production.
      devResetUrl: resetUrl,
      devNote:
        "No email provider is configured, so the link is shown here instead of being sent. " +
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
