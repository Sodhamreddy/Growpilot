"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
export function PublishRecovery({ id, status }: { id: string; status: string }) {
  const router = useRouter();
  const [externalId, setExternalId] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function recover(action: "retry" | "reconcile") {
    setBusy(true);
    try {
      const res = await fetch("/api/publishing/recover", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, action, confirmedAbsent: confirmed, ...(externalId ? { externalId: Number(externalId) } : {}) }) });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error?.message ?? "Could not recover publication.");
      setMessage(action === "retry" ? "Queued for retry." : "Publication reconciled."); router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Please try again."); }
    finally { setBusy(false); }
  }
  return <details><summary>Check publication</summary>
    <p>Check WordPress for the draft before retrying. If it exists, enter its post ID to reconcile it here.</p>
    <input aria-label="WordPress post ID" type="number" min="1" value={externalId} onChange={e => setExternalId(e.target.value)} />
    <button className="btn" disabled={busy || !externalId} onClick={() => void recover("reconcile")}>Verify existing post</button>
    {["running", "failed"].includes(status) ? <><label><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />I checked the target site and no post was created.</label><button className="btn" disabled={busy || !confirmed} onClick={() => void recover("retry")}>Retry publication</button></> : null}
    <p role="status">{message}</p></details>;
}
