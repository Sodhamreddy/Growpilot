"use client";

import { useState } from "react";
import { PasswordField } from "./PasswordField";
import { passwordHint } from "./AuthForm";

export type JoinView =
  | { kind: "create"; invitedEmail: string; workspaceName: string; joiningAs: string }
  | { kind: "accept"; workspaceName: string; joiningAs: string }
  | { kind: "sign-in"; invitedEmail: string }
  | { kind: "wrong-account"; signedInAs: string; invitedEmail: string }
  | { kind: "ended"; reason: "invalid" | "expired" | "revoked" | "accepted" };

const ENDED: Record<string, { title: string; text: string }> = {
  invalid: { title: "This invite link doesn't work", text: "Check that the whole link was copied, or ask your workspace admin for a new invite." },
  expired: { title: "This invite has expired", text: "Invite links work for a week. Ask your workspace admin for a new one." },
  revoked: { title: "This invite was cancelled", text: "It was cancelled or replaced by a newer link. Ask your workspace admin for a new one." },
  accepted: { title: "This invite was already used", text: "If that was you, sign in to open the workspace." },
};

async function post(url: string, body?: unknown) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(30_000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const fields = data.error?.details?.fields as Record<string, string> | undefined;
    throw Object.assign(new Error(data.error?.message ?? "That did not work. Please try again."), { fields: fields ?? {} });
  }
  return data;
}

/** The action on the join page: create an account, accept as yourself, or explain why not. */
export function JoinWorkspace({ token, view }: { token: string; view: JoinView }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");

  async function run(work: () => Promise<void>) {
    setBusy(true); setError(null); setFields({});
    try { await work(); }
    catch (err) {
      const failure = err as Error & { fields?: Record<string, string> };
      setFields(failure.fields ?? {});
      setError(Object.keys(failure.fields ?? {}).length ? null : failure.message);
      setBusy(false);
    }
  }

  if (view.kind === "ended") {
    const ended = ENDED[view.reason]!;
    return <div>
      <div className="auth-form-head"><h1>{ended.title}</h1><p>{ended.text}</p></div>
      <a className="btn block" href="/signin">Go to sign in</a>
    </div>;
  }

  if (view.kind === "sign-in") {
    return <div>
      <div className="auth-form-head"><h1>Sign in to join</h1><p>{view.invitedEmail} already has a GrowPilot account. Sign in with it and you&apos;ll come straight back here to join.</p></div>
      <a className="btn primary block" href={`/signin?next=${encodeURIComponent(`/join/${token}`)}`}>Sign in as {view.invitedEmail}</a>
    </div>;
  }

  if (view.kind === "wrong-account") {
    return <div>
      <div className="auth-form-head"><h1>This invite is for someone else</h1>
        <p>You&apos;re signed in as {view.signedInAs}, but this invite is for {view.invitedEmail}. Sign out, then open the link again.</p></div>
      <button type="button" className="btn primary block" disabled={busy} onClick={() => void run(async () => {
        await fetch("/api/auth/signout", { method: "POST", signal: AbortSignal.timeout(5_000) }).catch(() => undefined);
        window.location.reload();
      })}>{busy ? "Signing out…" : "Sign out"}</button>
    </div>;
  }

  if (view.kind === "accept") {
    return <div>
      <div className="auth-form-head"><h1>Join {view.workspaceName}</h1><p>You&apos;ll join {view.joiningAs}, and switch to this workspace. Your other workspaces stay in your account menu.</p></div>
      <button type="button" className="btn primary block" disabled={busy} onClick={() => void run(async () => {
        await post("/api/invites/accept", { token });
        window.location.replace("/home");
      })}>{busy ? "Joining…" : `Join ${view.workspaceName}`}</button>
      {error && <div className="error" role="alert" style={{ marginTop: 14 }}>{error}</div>}
    </div>;
  }

  return <div>
    <div className="auth-form-head"><h1>Create your account</h1><p>You&apos;re joining {view.workspaceName} {view.joiningAs}. Set a password to finish.</p></div>
    <form onSubmit={(event) => {
      event.preventDefault();
      void run(async () => {
        await post("/api/auth/join", { token, name, password });
        window.location.replace("/home");
      });
    }}>
      <div className="field">
        <label htmlFor="join-email">Email</label>
        <input id="join-email" type="email" value={view.invitedEmail} readOnly aria-readonly="true" />
      </div>
      <div className="field">
        <label htmlFor="join-name">Your name</label>
        <input id="join-name" autoComplete="name" required value={name} onChange={(event) => setName(event.target.value)} />
        {fields["name"] ? <div className="error">{fields["name"]}</div> : null}
      </div>
      <PasswordField id="join-password" label="Password" value={password} onChange={setPassword} autoComplete="new-password"
        {...(fields["password"] ? { error: fields["password"] } : { hint: passwordHint(password) })} />
      <button className="btn primary block" type="submit" disabled={busy}>{busy ? "Creating account…" : "Create account and join"}</button>
      {error && <div className="error" role="alert" style={{ marginTop: 14 }}>{error}</div>}
    </form>
  </div>;
}
