import { createHash } from "node:crypto";
import { AppError, config } from "@ob/core";

export async function sendPasswordReset(email: string, resetUrl: string): Promise<void> {
  const cfg = config();
  if (!cfg.RESEND_API_KEY || !cfg.EMAIL_FROM) throw new AppError("dependency_unavailable", "Password recovery is temporarily unavailable. Contact your administrator.");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST", signal: AbortSignal.timeout(10_000),
    headers: { Authorization: `Bearer ${cfg.RESEND_API_KEY}`, "Content-Type": "application/json",
      "Idempotency-Key": `reset-${createHash("sha256").update(resetUrl).digest("hex")}` },
    body: JSON.stringify({ from: cfg.EMAIL_FROM, to: [email], subject: "Reset your GrowPilot password",
      text: `Use this link to reset your password within one hour:\n\n${resetUrl}\n\nIf you did not request this, ignore this email.` }),
  });
  if (!response.ok) throw new AppError("dependency_unavailable", "The reset email could not be sent. Try again shortly.", { retryable: true });
}
