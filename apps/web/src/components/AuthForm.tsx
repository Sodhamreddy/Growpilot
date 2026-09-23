"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PasswordField } from "./PasswordField";

/** Sign-in, sign-up and forgot-password — spec §2.1. */

type Mode = "signin" | "signup" | "forgot";

/** Must match the server-side rule in /api/auth/signup. */
const MIN_PASSWORD = 8;

function passwordHint(password: string): string {
  if (!password) return "8+ characters with uppercase, lowercase, number, and special character.";
  const missing = [
    password.length >= MIN_PASSWORD ? null : `${MIN_PASSWORD - password.length} more character${MIN_PASSWORD - password.length === 1 ? "" : "s"}`,
    /[A-Z]/.test(password) ? null : "uppercase letter",
    /[a-z]/.test(password) ? null : "lowercase letter",
    /[0-9]/.test(password) ? null : "number",
    /[^A-Za-z0-9]/.test(password) ? null : "special character",
  ].filter(Boolean);
  return missing.length ? `Add: ${missing.join(", ")}.` : "Password looks good.";
}

export function AuthForm({ googleEnabled = false }: { googleEnabled?: boolean }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("signin");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);
  const [notice, setNotice] = useState<{ message: string; devUrl?: string } | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [form, setForm] = useState({ email: "", password: "", name: "", workspaceName: "" });

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
    setNotice(null);
    setFields({});
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    setFields({});

    const endpoint =
      mode === "signup" ? "signup" : mode === "forgot" ? "forgot-password" : "signin";

    const payload =
      mode === "signup"
        ? {
            email: form.email,
            password: form.password,
            name: form.name || undefined,
            workspaceName: form.workspaceName || undefined,
          }
        : mode === "forgot"
          ? { email: form.email }
          : { email: form.email, password: form.password };

    try {
      const res = await fetch(`/api/auth/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      });
      const body: unknown = await res.json();

      if (!res.ok) {
        const err = (
          body as {
            error?: {
              message?: string;
              details?: { fields?: Record<string, string>; hint?: string; devCause?: string };
            };
          }
        ).error;
        setError({
          message: err?.message ?? "That did not work.",
          hint: err?.details?.hint ?? err?.details?.devCause,
        });
        setFields(err?.details?.fields ?? {});
        return;
      }

      if (mode === "forgot") {
        const ok = body as { message?: string; devResetUrl?: string };
        setNotice({
          message: ok.message ?? "Check your inbox.",
          ...(ok.devResetUrl ? { devUrl: ok.devResetUrl } : {}),
        });
        return;
      }

      // A new account has nothing set up yet, so it starts the flow rather than
      // landing on an empty dashboard. Sign-in resumes wherever they were.
      window.location.replace(mode === "signup" ? "/onboarding" : "/home");
    } catch (err) {
      const timedOut = err instanceof DOMException && err.name === "TimeoutError";
      setError({
        message: timedOut
          ? "The server is taking too long. Please try again."
          : "Could not reach the server. Check your connection and try again.",
      });
    } finally {
      setBusy(false);
    }
  }

  // ── Forgot password is its own view, not a third tab ──
  // It is a recovery path, not a way in: giving it equal billing in the
  // segmented control would suggest it is a third way to sign in.
  if (mode === "forgot") {
    return (
      <div>
        <button type="button" className="linkback" onClick={() => switchMode("signin")}>
          ← Back to sign in
        </button>

        <h2 className="authtitle">Reset your password</h2>
        <p className="authlede">
          Enter the address you signed up with and we will send a link to set a new password.
        </p>

        <form onSubmit={(e) => void submit(e)}>
          <div className="field">
            <label htmlFor="forgot-email">Email</label>
            <input
              id="forgot-email"
              type="email"
              required
              autoComplete="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
            {fields["email"] ? <div className="error">{fields["email"]}</div> : null}
          </div>

          <button className="btn primary block" type="submit" disabled={busy}>
            {busy ? "Sending…" : "Send reset link"}
          </button>

          {notice ? (
            <div className="notice" style={{ marginTop: 14 }}>
              <div>{notice.message}</div>
              {notice.devUrl ? (
                <div className="hint" style={{ marginTop: 8 }}>
                  No email provider is configured, so the link is here instead:{" "}
                  <a href={notice.devUrl}>open reset link</a>
                </div>
              ) : null}
            </div>
          ) : null}

          {error ? (
            <div className="error" style={{ marginTop: 14 }}>
              <div>{error.message}</div>
              {error.hint ? <div className="hint" style={{ marginTop: 4 }}>{error.hint}</div> : null}
            </div>
          ) : null}
        </form>
      </div>
    );
  }

  return (
    <div>
      {/* A segmented control, not two buttons: these are two views of one form,
          and rendering them as a filled + outlined button pair made them read
          as two competing actions. */}
      <div className="segmented" role="tablist" aria-label="Sign in or create an account">
        <button
          type="button"
          role="tab"
          aria-selected={mode === "signin"}
          onClick={() => switchMode("signin")}
        >
          Sign in
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "signup"}
          onClick={() => switchMode("signup")}
        >
          Create account
        </button>
      </div>

      {/*
        * The label follows the tab.
        *
        * "Continue with Google" on both tabs left the button reading the same
        * whether it was about to create an account or open an existing one —
        * on the Create account tab that is the one thing a person needs it to
        * say. The `mode` it already carries to the OAuth route is the same
        * answer, so the wording now comes from it rather than being fixed.
        */}
      {googleEnabled ? (
        <a className="btn block googlebtn" href={`/api/auth/google/start?mode=${mode}`}>
          <GoogleMark /> {mode === "signup" ? "Sign up with Google" : "Sign in with Google"}
        </a>
      ) : (
        <button className="btn block googlebtn" type="button" disabled title="Google sign-in is not configured on this server.">
          <GoogleMark /> {mode === "signup" ? "Sign up with Google" : "Sign in with Google"}
        </button>
      )}
      <div className="authdivider"><span>or</span></div>

      <form onSubmit={(e) => void submit(e)}>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            required
            autoComplete="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
          {fields["email"] ? <div className="error">{fields["email"]}</div> : null}
        </div>

        <PasswordField
          id="password"
          label="Password"
          value={form.password}
          onChange={(password) => setForm({ ...form, password })}
          autoComplete={mode === "signup" ? "new-password" : "current-password"}
          {...(fields["password"] ? { error: fields["password"] } : {})}
          {...(mode === "signup" && !fields["password"]
            ? { hint: passwordHint(form.password) }
            : {})}
        >
          {mode === "signin" ? (
            <button type="button" className="linkish" onClick={() => switchMode("forgot")}>
              Forgot password?
            </button>
          ) : null}
        </PasswordField>

        {mode === "signup" ? (
          <>
            <div className="field">
              <label htmlFor="name">Your name (optional)</label>
              <input
                id="name"
                autoComplete="name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="workspace">Workspace name (optional)</label>
              <input
                id="workspace"
                value={form.workspaceName}
                onChange={(e) => setForm({ ...form, workspaceName: e.target.value })}
                placeholder="Acme Marketing"
              />
            </div>
          </>
        ) : null}

        <button className="btn primary block" type="submit" disabled={busy}>
          {busy ? "Working…" : mode === "signup" ? "Create account" : "Sign in"}
        </button>

        <p className="auth-terms">
          By continuing, you agree to the <span>Terms of Service</span> and <span>Privacy Policy</span>.
        </p>

        {/* Only shown when it says something the inline field errors do not.
            A generic "some fields need attention" under a field that is already
            marked in red is noise. */}
        {error && Object.keys(fields).length === 0 ? (
          <div className="error" style={{ marginTop: 14 }}>
            <div>{error.message}</div>
            {error.hint ? <div className="hint" style={{ marginTop: 4 }}>{error.hint}</div> : null}
          </div>
        ) : null}
      </form>
    </div>
  );
}

/** Google's mark, from their brand guidelines. */
function GoogleMark() {
  return (
    <svg viewBox="0 0 18 18" width="17" height="17" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z" />
      <path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.46 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z" />
    </svg>
  );
}
