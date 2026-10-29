"use client";

import { useState } from "react";
import type { PackSchedule, SocialContentPack, SocialNetworkId } from "@ob/db";

export function SocialPublishRecovery({ topicId, schedule, onSaved }: {
  topicId: string; schedule: PackSchedule; onSaved: (pack: SocialContentPack) => void;
}) {
  const pending = schedule.networks.filter(n => schedule.results[n]?.status !== "published");
  const [outcomes, setOutcomes] = useState<Partial<Record<SocialNetworkId, { state: string; id: string; url: string }>>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    setBusy(true); setError("");
    try {
      const res = await fetch("/api/social/schedule", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        topicId, confirmed, outcomes: pending.map(network => ({ network, state: outcomes[network]?.state,
          ...(outcomes[network]?.state === "published" ? { id: outcomes[network]?.id, url: outcomes[network]?.url } : {}) })),
      }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error?.message ?? "Recovery failed.");
      onSaved(body.pack);
    } catch (err) { setError(err instanceof Error ? err.message : "Could not reach the server."); }
    finally { setBusy(false); }
  }
  return <details className="card"><summary>Recover interrupted publishing</summary>
    <p>Check each account directly. Record any existing post here before scheduling another attempt. Recovery is available once the worker has stopped.</p>
    {schedule.pageId ? <p>Scheduled Facebook Page: {schedule.pageId}{schedule.instagramId ? `; Instagram account: ${schedule.instagramId}` : ""}.</p> : null}
    {pending.map(network => {
      const value = outcomes[network] ?? { state: "", id: "", url: "" };
      const update = (patch: Partial<typeof value>) => setOutcomes(all => ({ ...all, [network]: { ...value, ...patch } }));
      return <fieldset key={network}><legend>{network}</legend>
        <label>Result <select value={value.state} onChange={e => update({ state: e.target.value })}>
          <option value="">Choose after checking</option><option value="published">Post exists</option><option value="absent">No post exists</option>
        </select></label>
        {value.state === "published" ? <><label>Post ID <input value={value.id} onChange={e => update({ id: e.target.value })} /></label>
          <label>Post URL <input type="url" value={value.url} onChange={e => update({ url: e.target.value })} /></label></> : null}
      </fieldset>;
    })}
    <label><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} /> I checked every listed account.</label>
    <button type="button" className="btn small" disabled={busy || !confirmed || pending.some(n => !outcomes[n]?.state)} onClick={() => void save()}>{busy ? "Saving…" : "Save checked results"}</button>
    {error ? <p role="alert">{error}</p> : null}
  </details>;
}
