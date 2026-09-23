"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** Activate a draft voice profile — spec §18.2 "save approved voice". */
export function ActivateVoice({ voiceId, version }: { voiceId: string; version: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function activate() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/voice/${voiceId}/activate`, { method: "POST" });
      if (!res.ok) {
        const body: unknown = await res.json();
        setError((body as { error?: { message?: string } }).error?.message ?? "That did not work.");
        return;
      }
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span>
      <button className="btn" onClick={() => void activate()} disabled={busy}>
        {busy ? "Activating…" : `Activate v${version}`}
      </button>
      {error ? <span className="error" style={{ marginLeft: 8 }}>{error}</span> : null}
    </span>
  );
}
