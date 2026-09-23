"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Business source selection — spec §2.3.
 *
 * Two paths, website or manual. Spec §2.2 asks that users never repeat what we
 * can detect, so the website path is presented first and the manual path is a
 * clearly labelled fallback rather than a parallel option.
 */
export function BusinessSetup() {
  const router = useRouter();
  const [mode, setMode] = useState<"website" | "manual">("website");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  const [url, setUrl] = useState("");
  const [manual, setManual] = useState({ name: "", offer: "", audience: "", serviceArea: "" });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFields({});

    const payload =
      mode === "website"
        ? { source: "website", url }
        : {
            source: "manual",
            name: manual.name,
            offer: manual.offer,
            audience: manual.audience,
            serviceArea: manual.serviceArea || undefined,
          };

    try {
      const res = await fetch("/api/onboarding/business-source", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body: unknown = await res.json();

      if (!res.ok) {
        const err = (body as { error?: { message?: string; details?: { fields?: Record<string, string> } } })
          .error;
        setError(err?.message ?? "That did not work.");
        setFields(err?.details?.fields ?? {});
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
    <div className="card" style={{ maxWidth: 560 }}>
      <div className="segmented" role="tablist" aria-label="How to add the business">
        <button
          type="button"
          role="tab"
          aria-selected={mode === "website"}
          onClick={() => setMode("website")}
        >
          Use my website
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "manual"}
          onClick={() => setMode("manual")}
        >
          Enter details manually
        </button>
      </div>

      <form onSubmit={(e) => void submit(e)}>
        {mode === "website" ? (
          <>
            <p className="muted small">
              We read your public pages, extract the facts with a source for each one, and show you
              the result to confirm. We respect robots.txt and never publish anything.
            </p>
            <div className="field">
              <label htmlFor="url">Website address</label>
              <input
                id="url"
                type="url"
                required
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com"
              />
              {fields["url"] ? <div className="error">{fields["url"]}</div> : null}
            </div>
          </>
        ) : (
          <>
            <p className="muted small">
              Use this if the business has no website yet, or if the site is not publicly readable.
            </p>
            <div className="field">
              <label htmlFor="name">Business name</label>
              <input
                id="name"
                required
                value={manual.name}
                onChange={(e) => setManual({ ...manual, name: e.target.value })}
              />
              {fields["name"] ? <div className="error">{fields["name"]}</div> : null}
            </div>
            <div className="field">
              <label htmlFor="offer">What does the business offer?</label>
              <textarea
                id="offer"
                required
                rows={3}
                value={manual.offer}
                onChange={(e) => setManual({ ...manual, offer: e.target.value })}
              />
              {fields["offer"] ? <div className="error">{fields["offer"]}</div> : null}
            </div>
            <div className="field">
              <label htmlFor="audience">Who does it serve?</label>
              <input
                id="audience"
                required
                value={manual.audience}
                onChange={(e) => setManual({ ...manual, audience: e.target.value })}
              />
              {fields["audience"] ? <div className="error">{fields["audience"]}</div> : null}
            </div>
            <div className="field">
              <label htmlFor="area">Service area (optional)</label>
              <input
                id="area"
                value={manual.serviceArea}
                onChange={(e) => setManual({ ...manual, serviceArea: e.target.value })}
              />
            </div>
          </>
        )}

        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? "Working…" : mode === "website" ? "Read my website" : "Save profile"}
        </button>

        {error ? <div className="error" style={{ marginTop: 12 }}>{error}</div> : null}
      </form>
    </div>
  );
}
