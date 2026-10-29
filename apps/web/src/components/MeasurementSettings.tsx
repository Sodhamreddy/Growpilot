"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
export function MeasurementSettings({ businessId }: { businessId: string }) {
  const router = useRouter();
  const [provider, setProvider] = useState("google_search_console");
  const [property, setProperty] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function save(disconnect = false) {
    setBusy(true); setMessage("");
    try {
      const res = await fetch("/api/integrations/measurement", { method: disconnect ? "DELETE" : "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, provider, ...(disconnect ? {} : { property, serviceAccount: JSON.parse(key) }) }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message ?? "The connection could not be saved.");
      setKey(""); setMessage(disconnect ? "Disconnected." : "Connected. Your last 28 days of data are being synced; daily updates follow."); router.refresh();
    } catch (error) { setMessage(error instanceof SyntaxError ? "Paste the service account JSON key." : error instanceof Error ? error.message : "Please try again."); }
    finally { setBusy(false); }
  }
  return <section className="card"><h2>Search and website measurement</h2>
    <p>Grant the service account read access to this client's Search Console or GA4 property, then connect it here.</p>
    <label className="field">Source<select value={provider} onChange={e => setProvider(e.target.value)}><option value="google_search_console">Search Console</option><option value="google_analytics">Google Analytics 4</option></select></label>
    <label className="field">{provider === "google_analytics" ? "Numeric GA4 property ID" : "Search Console property (https://example.com/ or sc-domain:example.com)"}<input value={property} onChange={e => setProperty(e.target.value)} /></label>
    <label className="field">Service account JSON key<textarea autoComplete="off" spellCheck={false} value={key} onChange={e => setKey(e.target.value)} /></label>
    <button className="btn primary" disabled={busy || !key || !property} onClick={() => void save()}>Connect and sync</button>{" "}
    <button className="btn" disabled={busy} onClick={() => void save(true)}>Disconnect selected source</button>
    <p role="status">{message}</p></section>;
}
