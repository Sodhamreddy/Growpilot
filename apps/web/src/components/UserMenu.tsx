"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Account menu in the sidebar footer.
 *
 * The sign-out endpoint existed from the start but nothing in the UI called
 * it, so there was no way to leave a session without clearing cookies by hand.
 */
export function UserMenu({
  name, email, role, initials, workspaces = [], activeWorkspaceId,
}: {
  name: string; email: string; role: string; initials: string;
  /** Every workspace this person belongs to. The switcher shows when there is more than one. */
  workspaces?: { id: string; name: string }[];
  activeWorkspaceId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);

  async function switchWorkspace(workspaceId: string) {
    setBusy(true); setSwitchError(null);
    try {
      const res = await fetch("/api/session/workspace", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId }), signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error?.message ?? "Could not switch workspace.");
      window.location.replace("/home");
    } catch (err) {
      setSwitchError(err instanceof Error ? err.message : "Could not switch workspace.");
      setBusy(false);
    }
  }
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function signOut() {
    setBusy(true);
    try {
      await fetch("/api/auth/signout", {
        method: "POST",
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      /*
       * Leave anyway.
       *
       * `fetch` rejects when the server is unreachable, and with only a
       * `finally` here that rejection escaped the handler and surfaced as a
       * runtime error overlay — a crash, from clicking Sign out.
       *
       * Swallowing it is right for this action specifically. Somebody who
       * asked to sign out should not be left sitting in the dashboard because
       * the network dropped, and the outcome they want is mostly local: the
       * navigation below leaves the authenticated area, and the session
       * cookie is httpOnly with its own expiry, so a server that never heard
       * the request still ends the session on its own terms.
       *
       * The retry is the sign-out button on the next page, which is where
       * they already are.
       */
    } finally {
      setBusy(false);
    }
    // Replace, not push: the dashboard must not be reachable with Back.
    window.location.replace("/signin");
  }

  return (
    <div className="userchip-wrap" ref={ref}>
      {open ? (
        <div className="usermenu" role="menu">
          <div className="usermenu-head">
            <strong>{name}</strong>
            <span>{email}</span>
          </div>
          {workspaces.length > 1 ? (
            <div className="usermenu-workspaces" role="group" aria-label="Switch workspace">
              <span className="usermenu-label">Workspaces</span>
              {workspaces.map((workspace) => (
                <button key={workspace.id} type="button" role="menuitemradio" aria-checked={workspace.id === activeWorkspaceId}
                  disabled={busy || workspace.id === activeWorkspaceId} onClick={() => void switchWorkspace(workspace.id)}>
                  {workspace.id === activeWorkspaceId ? "✓ " : ""}{workspace.name}
                </button>
              ))}
              {switchError ? <span className="usermenu-error" role="alert">{switchError}</span> : null}
            </div>
          ) : null}
          <button type="button" role="menuitem" onClick={() => void signOut()} disabled={busy}>
            {busy ? "Signing out…" : "Sign out"}
          </button>
        </div>
      ) : null}

      <button
        type="button"
        className="userchip"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="avatar">{initials}</span>
        <span className="who">
          <strong>{name}</strong>
          <span>{email}</span>
        </span>
        <span className="role">{role}</span>
      </button>
    </div>
  );
}
