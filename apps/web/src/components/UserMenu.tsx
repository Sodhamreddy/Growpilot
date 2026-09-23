"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Account menu in the sidebar footer.
 *
 * The sign-out endpoint existed from the start but nothing in the UI called
 * it, so there was no way to leave a session without clearing cookies by hand.
 */
export function UserMenu({
  name, email, role, initials,
}: {
  name: string; email: string; role: string; initials: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
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
