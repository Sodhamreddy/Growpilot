"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { IconAlert, IconCheck, IconClock, IconSpark } from "./Icons";

export interface ClientCrawlSource {
  id: string;
  url: string;
  status: string;
  pagesDiscovered: number;
  pagesFetched: number;
  lastCrawledAt: string | null;
  lastError: string | null;
}

export function ClientSetupPanel({
  businessId,
  businessName,
  websiteUrl,
  confirmed,
  initialSource,
  canManage,
}: {
  businessId: string;
  businessName: string;
  websiteUrl: string | null;
  confirmed: boolean;
  initialSource: ClientCrawlSource | null;
  canManage: boolean;
}) {
  const router = useRouter();
  const [source, setSource] = useState(initialSource);
  const [address, setAddress] = useState(websiteUrl ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [waitedSeconds, setWaitedSeconds] = useState(0);
  const refreshedTerminal = useRef<string | null>(null);

  useEffect(() => {
    setSource(initialSource);
    setAddress(websiteUrl ?? "");
  }, [businessId, initialSource, websiteUrl]);

  const status = source?.status ?? "not_started";
  const active = status === "pending" || status === "running";
  const failed = status === "failed" || status === "blocked";
  const succeeded = status === "succeeded";
  const stalled = status === "pending" && waitedSeconds >= 60;

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setWaitedSeconds((seconds) => seconds + 1), 1000);
    return () => window.clearInterval(timer);
  }, [active, businessId]);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    let checking = false;

    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        const res = await fetch(`/api/clients/crawl?businessId=${encodeURIComponent(businessId)}`, {
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) return;
        const body = (await res.json()) as { source: ClientCrawlSource | null };
        if (!alive || !body.source) return;
        setSource(body.source);

        if (["succeeded", "failed", "blocked"].includes(body.source.status) &&
            refreshedTerminal.current !== body.source.status) {
          refreshedTerminal.current = body.source.status;
          router.refresh();
        }
      } catch {
        // The next poll retries. Keep the last useful progress on screen.
      } finally {
        checking = false;
      }
    };

    void check();
    const timer = window.setInterval(() => void check(), 5000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [active, businessId, router]);

  async function startScan() {
    setBusy(true);
    setError(null);
    refreshedTerminal.current = null;
    try {
      const res = await fetch("/api/clients/crawl", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, websiteUrl: address.trim() || undefined }),
      });
      const body: unknown = await res.json();
      if (!res.ok) {
        setError((body as { error?: { message?: string } }).error?.message ?? "The website scan could not start.");
        return;
      }
      const next = (body as { source: ClientCrawlSource }).source;
      setSource(next);
      setAddress(next.url);
      setWaitedSeconds(0);
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  const progress = succeeded
    ? 100
    : source && source.pagesDiscovered > 0
      ? Math.min(90, Math.max(12, Math.round((source.pagesFetched / source.pagesDiscovered) * 90)))
      : active
        ? 10
        : 0;

  const title = succeeded
    ? confirmed ? "Website setup is complete" : "Website information is ready to review"
    : failed
      ? "Website information could not be imported"
      : stalled
        ? "The website scan has not started"
        : active
          ? source?.pagesFetched ? "Extracting business information" : "Reading the client website"
          : "Set up this client automatically";

  const description = succeeded
    ? confirmed
      ? `GrowPilot has imported the available information for ${businessName}. Refresh it whenever the website changes.`
      : "Services, locations, brand details and business facts have been imported. Review and confirm them before automation starts."
    : failed
      ? source?.lastError ?? "Check the website address and try the scan again."
      : stalled
        ? "The scan is still queued. Make sure the background worker is running, then retry without adding the client again."
        : active
          ? "GrowPilot is importing services, locations, business details, brand colours and a logo where the website provides them. This page updates automatically."
          : websiteUrl
            ? "Scan the saved website to import services, locations, business details, brand colours and a logo."
            : "Add the client's website below. Without a website, the business information must be entered manually."

  return (
    <section className={`client-setup-panel ${failed ? "failed" : succeeded ? "ready" : active ? "working" : "idle"}`}>
      <span className="client-setup-icon" aria-hidden>
        {failed ? <IconAlert size={22}/> : succeeded ? <IconCheck size={22}/> : active ? <IconClock size={22}/> : <IconSpark size={22}/>}
      </span>
      <div className="client-setup-main">
        <div className="client-setup-heading">
          <div>
            <span className="client-setup-eyebrow">Automatic website setup</span>
            <h2>{title}</h2>
          </div>
          <span className={`badge ${failed ? "fail" : succeeded ? "ok" : active ? "neutral" : "warn"}`}>
            {failed ? "needs attention" : succeeded ? confirmed ? "complete" : "review needed" : active ? stalled ? "waiting" : "in progress" : "not started"}
          </span>
        </div>
        <p>{description}</p>

        {active || succeeded ? (
          <div className="client-setup-progress" role="status" aria-label={`Website setup ${progress}% complete`}>
            <div className="track"><i style={{ width: `${progress}%` }}/></div>
            <span>{active && source ? `${source.pagesFetched} of ${source.pagesDiscovered || "?"} pages` : "Import complete"}</span>
          </div>
        ) : null}

        {(!source || failed) && canManage ? (
          <div className="client-setup-form">
            <label>
              <span>Client website</span>
              <input
                type="url"
                inputMode="url"
                value={address}
                placeholder="https://clientwebsite.com"
                disabled={busy}
                onChange={(event) => setAddress(event.target.value)}
              />
            </label>
            <button type="button" className="btn primary" disabled={busy || !address.trim()}
                    onClick={() => void startScan()}>
              {busy ? "Starting…" : failed ? "Retry website scan" : "Save and scan website"}
            </button>
          </div>
        ) : null}

        <div className="client-setup-actions">
          {succeeded ? <Link className="btn primary" href="/business#extracted-facts">Review and confirm profile</Link> : null}
          {succeeded && canManage ? (
            <button type="button" className="btn" disabled={busy} onClick={() => void startScan()}>
              {busy ? "Starting…" : "Refresh from website"}
            </button>
          ) : null}
          {stalled && canManage ? (
            <button type="button" className="btn" disabled={busy} onClick={() => void startScan()}>
              {busy ? "Retrying…" : "Retry scan"}
            </button>
          ) : null}
        </div>
        {error ? <p className="error" role="alert">{error}</p> : null}
      </div>
    </section>
  );
}
