"use client";

import { useEffect, useState } from "react";
import { onboardingRequest } from "@/lib/onboarding-request";

/**
 * Profile confirmation — spec §3.1 and §18 acceptance ("user can correct
 * extracted facts").
 *
 * Everything shown here was extracted from the customer's own site and carries
 * the page it came from. Confirming marks every fact verified, which is what
 * allows generation to state them without hedging — so the copy says that
 * plainly rather than treating this as a formality.
 */

interface Profile {
  business: {
    id: string; name: string; industry: string | null; audience: string | null;
    description: string | null; usp: string | null; websiteUrl: string | null;
  } | null;
  facts: { id: string; key: string; value: string; sourceUrl: string | null; confidence: number }[];
  locations: {
    id: string; label: string; streetAddress: string | null; locality: string | null;
    region: string | null; postalCode: string | null; country: string | null;
    phone: string | null; sourceUrl: string | null; confidence: number;
  }[];
}

export function ConfirmStep({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {
  const [data, setData] = useState<Profile | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    setError(null);
    void onboardingRequest<Profile>("/api/business/profile").then((profile) => {
      if (!alive) return;
      if (!profile.business) throw new Error("No business profile was found. Go back to add your business.");
      setData(profile);
    }).catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : "Could not load your profile."); });
    return () => { alive = false; };
  }, [attempt]);

  if (!data?.business) {
    return (
      <div className="ob-body">
        <div className="ob-ask">
          <div className="ob-eyebrow">04 — Your business</div>
          <h1>{error ? "Let’s try that again" : "Loading what we found"}</h1>
          <p role="status">{error ?? "One moment."}</p>
          {error ? <button className="btn" onClick={() => setAttempt((n) => n + 1)}>Retry</button> : null}
          <button className="btn" onClick={onBack}>Back to business source</button>
        </div>
        <div />
      </div>
    );
  }

  const b = data.business;
  const services = data.facts.filter((f) => f.key === "service");
  const others = data.facts.filter((f) => f.key !== "service");
  const val = (k: string, fallback: string | null) => edits[k] ?? fallback ?? "";

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await onboardingRequest("/api/business/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId: b.id,
          ...(edits["name"] !== undefined ? { name: edits["name"] } : {}),
          ...(edits["industry"] !== undefined ? { industry: edits["industry"] } : {}),
          ...(edits["audience"] !== undefined ? { audience: edits["audience"] } : {}),
          ...(edits["description"] !== undefined ? { description: edits["description"] } : {}),
          ...(edits["usp"] !== undefined ? { usp: edits["usp"] } : {}),
          confirm: true,
        }),
      });
      await onboardingRequest("/api/onboarding/step", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step: "confirm" }),
      });
      onDone();

    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="ob-body">
        <div className="ob-ask">
          <div className="ob-eyebrow">04 — Your business</div>
          <h1>Here&rsquo;s what we found</h1>
          <p>
            Check it over and correct anything that is wrong. Everything after this is built from
            what you confirm here.
          </p>
          {b.websiteUrl ? (
            <p className="confirm-source">
              Read from{" "}
              <a href={b.websiteUrl} target="_blank" rel="noopener noreferrer">
                {b.websiteUrl.replace(/^https?:\/\//, "")}
              </a>
            </p>
          ) : null}
          <div className="confirm-benefits">
            <span><i>▤</i><b>Pre-filled for you</b><small>We extracted this from your website.</small></span>
            <span><i>◇</i><b>You stay in control</b><small>Edit or add details anytime.</small></span>
            <span><i>✦</i><b>More accurate content</b><small>Better details produce better results.</small></span>
          </div>

          <div className="confirm-gate">
            <i aria-hidden="true">✓</i>
            <div>
              <b>What confirming does</b>
              <p>It marks all facts verified. Correct anything that looks wrong before you continue.</p>
            </div>
          </div>
        </div>

        <div className="confirm-content">
          <Panel className="confirm-brief" title="Business brief" note="What we understood you do.">
            <div className="confirm-field-grid">
              <Field label="Name" value={val("name", b.name)} onChange={(v) => setEdits({ ...edits, name: v })} />
              <Field label="Category" value={val("industry", b.industry)} onChange={(v) => setEdits({ ...edits, industry: v })} />
              <Field
                className="wide"
                label="What the business does" multiline
                value={val("description", b.description)}
                onChange={(v) => setEdits({ ...edits, description: v })}
              />
            </div>
          </Panel>

          <Panel
            className="confirm-locations"
            title="Where you serve customers"
            note="Decides which keyword volumes we use."
          >
            {data.locations.length > 0 ? (
              <div className="location-list">
                {data.locations.map((l) => (
                  <div className="location-detail" key={l.id}>
                    <b>{l.label}</b>
                    <span>{[
                      l.streetAddress,
                      [l.locality, l.region, l.postalCode].filter(Boolean).join(", "),
                      l.country,
                    ].filter(Boolean).join(" · ")}</span>
                    {l.phone ? <small>{l.phone}</small> : null}
                    {l.sourceUrl ? <a href={l.sourceUrl} target="_blank" rel="noopener noreferrer">View source</a> : null}
                  </div>
                ))}
              </div>
            ) : (
              <p className="confirm-empty">No service location was detected.</p>
            )}
            <Field
              className="confirm-audience"
              label="Audience"
              value={val("audience", b.audience)}
              onChange={(v) => setEdits({ ...edits, audience: v })}
            />
          </Panel>

          <Panel
            className="confirm-services"
            title="Services and capabilities"
            note="What you sell. Each one gets its own share of the plan."
          >
            {services.length === 0 ? (
              <p className="small muted" style={{ margin: 0 }}>
                None detected. Add them on your site and re-crawl, or edit the profile later.
              </p>
            ) : (
              <div className="service-review-list">
                {services.map((s) => (
                  <div className="service-review-row" key={s.id}>
                    <i aria-hidden="true">⠿</i>
                    <span>{s.value}</span>
                    {s.sourceUrl ? <a href={s.sourceUrl} target="_blank" rel="noopener noreferrer">Source</a> : null}
                  </div>
                ))}
              </div>
            )}
          </Panel>

          <Panel className="confirm-facts" title="Other facts" note="Each one carries the page it came from.">
            {others.length > 0 ? (
              <div className="chips">
                {others.map((f) => (
                  <span className="chip" key={f.id} title={f.sourceUrl ?? undefined}>
                    <b>{f.key.replace(/_/g, " ")}</b> {f.value}
                  </span>
                ))}
              </div>
            ) : (
              <p className="confirm-empty">No additional facts were detected.</p>
            )}
          </Panel>
        </div>
      </div>

      <footer className="ob-foot">
        <button className="back" onClick={onBack} disabled={busy}>Back</button>
        <span className="count">2 steps left</span>
        {error ? <span className="error">{error}</span> : null}
        <button className="btn primary" onClick={() => void confirm()} disabled={busy}>
          {busy ? "Saving…" : "Confirm and continue →"}
        </button>
      </footer>
    </>
  );
}

function Panel({
  title, note, children, className,
}: {
  title: string; note: string; children: React.ReactNode; className?: string;
}) {
  return (
    <section className={`card confirm-panel ${className ?? ""}`}>
      <h3 style={{ marginBottom: 2 }}>{title}</h3>
      <p className="small muted" style={{ marginBottom: 12 }}>{note}</p>
      {children}
    </section>
  );
}

function Field({
  label, value, onChange, multiline, className,
}: {
  label: string; value: string; onChange: (v: string) => void; multiline?: boolean; className?: string;
}) {
  return (
    <div className={`field ${className ?? ""}`}>
      <label className="fieldlabel" style={{ marginBottom: 5 }}>{label}</label>
      {multiline ? (
        <textarea aria-label={label} rows={4} value={value} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} />
      )}
    </div>
  );
}
