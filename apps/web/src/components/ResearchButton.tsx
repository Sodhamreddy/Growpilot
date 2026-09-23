"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** Kick off keyword research on the research queue (spec §6.1, §12). */
export function ResearchButton({ businessId }: { businessId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/keywords/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId }),
      });
      if (!res.ok) {
        const body: unknown = await res.json();
        setError((body as { error?: { message?: string } }).error?.message ?? "That did not work.");
        return;
      }
      setQueued(true);
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button className="btn primary" onClick={() => void run()} disabled={busy}>
        {busy ? "Starting…" : "Run keyword research"}
      </button>
      {queued ? (
        <span className="muted small">Queued. This runs in the background — refresh to see results.</span>
      ) : null}
      {error ? <span className="error">{error}</span> : null}
    </>
  );
}
