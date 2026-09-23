"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Profile confirmation — spec §3.1 final step.
 *
 * Confirming marks every extracted fact verified, which is what allows
 * generation to state them without hedging (spec §15.1 "Business facts: use
 * verified profile"). The copy says so plainly, because it is a real gate and
 * not a formality.
 */
export function ConfirmProfile({ businessId, factCount }: { businessId: string; factCount: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/business/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, confirm: true }),
      });
      if (!res.ok) {
        const body: unknown = await res.json();
        setError((body as { error?: { message?: string } }).error?.message ?? "That did not work.");
        return;
      }
      router.refresh();
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ borderColor: "var(--accent)" }}>
      <h2>Confirm this profile</h2>
      <p className="muted">
        Confirming marks all {factCount} extracted facts as verified. Generated content is allowed to
        state verified facts directly, so please correct anything wrong before you confirm.
      </p>
      <button className="btn primary" onClick={() => void confirm()} disabled={busy}>
        {busy ? "Confirming…" : "Everything looks right — confirm"}
      </button>
      {error ? <div className="error" style={{ marginTop: 12 }}>{error}</div> : null}
    </div>
  );
}
