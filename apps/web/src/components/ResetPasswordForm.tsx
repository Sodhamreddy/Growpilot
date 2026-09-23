"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PasswordField } from "./PasswordField";

/**
 * Set a new password from a reset link.
 *
 * No session is created on success. Whoever holds the link proves they hold the
 * new password by signing in with it — logging them straight in would mean a
 * forwarded or intercepted link grants access without the password ever being
 * known.
 */
export function ResetPasswordForm({ token, valid }: { token: string; valid: boolean }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (!valid) {
    return (
      <div>
        <h2 className="authtitle">This link is no longer valid</h2>
        <p className="authlede">
          Reset links last one hour and can only be used once. Requesting a new one also
          retires any earlier link.
        </p>
        <a className="btn primary block" href="/signin">Request a new link</a>
      </div>
    );
  }

  if (done) {
    return (
      <div>
        <h2 className="authtitle">Password changed</h2>
        <p className="authlede">
          You have been signed out everywhere else. Sign in with your new password to continue.
        </p>
        <a className="btn primary block" href="/signin">Sign in</a>
      </div>
    );
  }

  // Checked here as well as on the server so the mismatch is caught before a
  // round trip, not after.
  const mismatch = confirm.length > 0 && password !== confirm;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (mismatch) return;

    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const body: unknown = await res.json();
      if (!res.ok) {
        setError(
          (body as { error?: { message?: string } }).error?.message ??
            "Could not change your password.",
        );
        return;
      }
      setDone(true);
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h2 className="authtitle">Set a new password</h2>
      <p className="authlede">Choose something you have not used here before.</p>

      <form onSubmit={(e) => void submit(e)}>
        <PasswordField
          id="new-password"
          label="New password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          hint="At least 12 characters. Length matters more than symbols."
        />

        <PasswordField
          id="confirm-password"
          label="Confirm new password"
          value={confirm}
          onChange={setConfirm}
          autoComplete="new-password"
          {...(mismatch ? { error: "These do not match." } : {})}
        />

        <button
          className="btn primary block"
          type="submit"
          disabled={busy || password.length < 12 || mismatch || confirm.length === 0}
        >
          {busy ? "Saving…" : "Change password"}
        </button>

        {error ? <div className="error" style={{ marginTop: 14 }}>{error}</div> : null}
      </form>
    </div>
  );
}
