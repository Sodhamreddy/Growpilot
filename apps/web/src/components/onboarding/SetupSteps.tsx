"use client";

import { useEffect, useState } from "react";

/**
 * Final setup steps — brand colours and content themes.
 *
 * Colours are genuinely detected from the customer's own crawled pages
 * (packages/seo/src/parse/colors.ts), not invented. When detection finds
 * nothing, the step says so and offers manual entry rather than showing
 * made-up swatches. The same crawl also supplies the best logo candidate.
 */

export interface BrandColor {
  hex: string;
  role: string;
}

const ROLE_LABEL: Record<string, string> = {
  primary: "Primary", secondary: "Secondary", accent: "Accent", surface: "Surface",
};

export function ColorsStep({
  value, onChange, logoValue, onLogoChange,
}: {
  value: BrandColor[];
  onChange: (c: BrandColor[]) => void;
  logoValue: string | null;
  onLogoChange: (logo: string | null) => void;
}) {
  const [detected, setDetected] = useState<BrandColor[] | null>(null);
  const [detectedLogo, setDetectedLogo] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState<string | null>(null);
  const [logoError, setLogoError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    /*
     * Never hang on this step.
     *
     * The previous version awaited a bare fetch with no deadline, so a slow or
     * dead request left "reading your site…" on screen forever with no way
     * forward — the customer cannot tell a slow answer from a broken one. Every
     * attempt now has a deadline, and the step always resolves to a state the
     * customer can act on.
     */
    const attempt = async (): Promise<{ colors: BrandColor[]; logoUrl: string | null; reason?: string } | null> => {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 8000);
      try {
        const res = await fetch("/api/business/colors", { signal: abort.signal });
        if (!res.ok) return null;
        return (await res.json()) as { colors: BrandColor[]; logoUrl: string | null; reason?: string };
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    };

    void (async () => {
      // The crawl may still be finishing when this step opens. Give it a few
      // tries before settling, rather than reporting "none detected" for a
      // palette that simply has not been written yet.
      for (let i = 0; i < 4 && !cancelled; i++) {
        const body = await attempt();

        if (body && (body.colors.length > 0 || body.logoUrl || !body.reason?.startsWith("crawl-"))) {
          if (cancelled) return;
          setDetected(body.colors);
          setDetectedLogo(body.logoUrl);
          // Seed the wizard's value so Continue carries the palette even if
          // the customer edits nothing.
          if (value.length === 0 && body.colors.length > 0) onChange(body.colors);
          if (!logoValue && body.logoUrl) onLogoChange(body.logoUrl);
          if (body.colors.length === 0) {
            setNote(
              body.reason === "no-crawl"
                ? "We have not read your site yet."
                : "Your colours live in an external stylesheet, which we do not fetch.",
            );
          }
          setLoading(false);
          return;
        }

        if (i < 3) await new Promise((r) => setTimeout(r, 2500));
      }

      if (cancelled) return;
      setDetected([]);
      setNote("We could not read your colours in time.");
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
    // Runs once on mount; controlled values/callbacks intentionally are not dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const colors = value.length > 0 ? value : (detected ?? []);
  const logo = logoValue ?? detectedLogo;

  function chooseLogo(file: File | undefined) {
    setLogoError(null);
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'].includes(file.type)) {
      setLogoError("Choose a PNG, JPG, WEBP or SVG file.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setLogoError("Choose a logo smaller than 5 MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") onLogoChange(reader.result);
    };
    reader.onerror = () => setLogoError("That logo could not be opened. Try another file.");
    reader.readAsDataURL(file);
  }

  return (
    <div className="brand-setup">
      <section className="card brand-colors-card">
        <div className="brand-card-head">
          <div>
            <h3>Brand colours</h3>
            <p>{loading ? "Reading your site…" : colors.length > 0 ? "Detected from your site. You can adjust them or add your own." : "Add the colours used by your business."}</p>
          </div>
          {!loading && colors.length < 6 ? (
            <button type="button" className="brand-add" onClick={() => onChange([...colors, { hex: "#635BFF", role: colors.length === 0 ? "primary" : colors.length === 1 ? "secondary" : "accent" }])}>＋ Add colour</button>
          ) : null}
        </div>

        {loading ? (
          <div className="brand-loading"><i /><span>Looking through the pages we read…</span></div>
        ) : colors.length === 0 ? (
          <p className="brand-empty">{note ?? "We could not pick colours out of your pages."}</p>
        ) : (
          <>
            <div className="swatches">
              {colors.map((c, i) => (
                <div className="swatch" key={`${c.role}-${i}`}>
                  <label className="chip-color" style={{ background: c.hex }} title={`${ROLE_LABEL[c.role] ?? c.role}: ${c.hex}`}>
                    <input
                      aria-label={`${ROLE_LABEL[c.role] ?? c.role} colour`}
                      type="color"
                      value={c.hex}
                      onChange={(e) => {
                        const next = [...colors];
                        next[i] = { ...c, hex: e.target.value.toUpperCase() };
                        onChange(next);
                      }}
                    />
                  </label>
                  <strong>{ROLE_LABEL[c.role] ?? c.role}</strong>
                  <span className="mono">{c.hex}</span>
                  <button type="button" className="brand-remove" aria-label={`Remove ${ROLE_LABEL[c.role] ?? c.role} colour`} onClick={() => { onChange(colors.filter((_, index) => index !== i)); setDetected([]); }}>Remove</button>
                </div>
              ))}
            </div>
            <p className="brand-help">Click a colour to adjust it. These are used wherever generated content needs your colours.</p>
          </>
        )}
      </section>

      <section className="card brand-logo-card">
        <div className="brand-card-head">
          <div>
            <h3>Brand logo</h3>
            <p>{logo ? "Detected from your site. Upload another file if you want to replace it." : "Add your logo so we can use it in your content."}</p>
          </div>
        </div>
        <div className="brand-logo-grid">
          <label className="brand-upload">
            <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" onChange={(e) => chooseLogo(e.target.files?.[0])} />
            <span className="brand-upload-icon" aria-hidden="true">⇧</span>
            <strong>Upload your logo</strong>
            <small>PNG, JPG, WEBP or SVG (max 5MB)</small>
            <span className="brand-choose">Choose file</span>
          </label>
          <div className="brand-preview-wrap">
            <span>Preview</span>
            <div className="brand-preview">
              {logo ? <img src={logo} alt="Your brand logo" /> : <span>No logo detected</span>}
            </div>
          </div>
        </div>
        {logoError ? <p role="alert" className="error brand-logo-error">{logoError}</p> : null}
      </section>
    </div>
  );
}

export const PILLARS = [
  { id: "education", title: "Education", desc: "How-tos, frameworks, explainers" },
  { id: "authority", title: "Authority", desc: "Original data, informed opinion" },
  { id: "proof", title: "Social proof", desc: "Case studies, client results" },
  { id: "personality", title: "Brand personality", desc: "Founder stories, behind the scenes" },
  { id: "community", title: "Community", desc: "Questions, conversations" },
  { id: "conversion", title: "Conversion", desc: "Lead magnets, offers" },
];

const TONES = ["professional", "casual", "witty", "inspirational", "educational", "bold"];
const PLATFORMS = ["Instagram", "LinkedIn", "Facebook", "X"];

export function PillarsStep({
  pillars, tone, platforms, onPillars, onTone, onPlatforms, showPlatforms,
}: {
  pillars: string[]; tone: string; platforms: string[];
  onPillars: (p: string[]) => void; onTone: (t: string) => void;
  onPlatforms: (p: string[]) => void; showPlatforms: boolean;
}) {
  const toggle = (list: string[], id: string, set: (v: string[]) => void) =>
    set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  return (
    <div className="pillars-setup">
      <section className="card pillars-card">
        <div className="pillars-head">
          <div>
            <h3>Content pillars</h3>
            <p>Choose the themes we should focus on. You can select multiple.</p>
          </div>
          <span className={`pillar-count ${pillars.length >= 2 ? "ready" : ""}`}>
            {pillars.length} of 6 selected
          </span>
        </div>
        <div className="pillar-grid">
          {PILLARS.map((p) => (
            <button
              key={p.id}
              type="button"
              className="pillar-choice"
              aria-pressed={pillars.includes(p.id)}
              onClick={() => toggle(pillars, p.id, onPillars)}
            >
              <PillarIcon id={p.id} />
              <span className="pillar-copy">
                <strong>{p.title}</strong>
                <small>{p.desc}</small>
              </span>
              <span className="pillar-radio" aria-hidden="true">{pillars.includes(p.id) ? "✓" : ""}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="card voice-card">
        <div className="voice-head">
          <h3>Brand voice</h3>
          <p>Pick the voice that sounds most like your brand.</p>
        </div>
        <div className="voice-options">
          {TONES.map((t) => (
            <button
              key={t}
              type="button"
              className="voice-pill"
              aria-pressed={tone === t}
              onClick={() => onTone(t)}
            >
              {t}
            </button>
          ))}
        </div>
        <p className="voice-note">
          A starting point. Your selection guides new drafts until you activate a complete brand voice
          profile in Voice Settings.
        </p>
      </section>

      {showPlatforms ? (
        <section className="card platforms-card">
          <div className="voice-head">
            <h3>Platforms</h3>
            <p>Choose where you want your social content prepared.</p>
          </div>
          <div className="voice-options">
            {PLATFORMS.map((p) => (
              <button
                key={p}
                type="button"
                className="voice-pill"
                aria-pressed={platforms.includes(p)}
                onClick={() => toggle(platforms, p, onPlatforms)}
              >
                {p}
              </button>
            ))}
          </div>
          <p className="voice-note">
            Connect the accounts later from Integrations. Captions are shaped per network.
          </p>
        </section>
      ) : null}
    </div>
  );
}

function PillarIcon({ id }: { id: string }) {
  const common = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  if (id === "education") return <span className="pillar-icon" aria-hidden="true"><svg {...common}><path d="M4.5 5.5c2.8-.8 5.3-.4 7.5 1.2v12c-2.2-1.6-4.7-2-7.5-1.2zM19.5 5.5c-2.8-.8-5.3-.4-7.5 1.2v12c2.2-1.6 4.7-2 7.5-1.2z" /></svg></span>;
  if (id === "authority") return <span className="pillar-icon" aria-hidden="true"><svg {...common}><path d="M12 3.5 18 6v5c0 4.2-2.5 7.4-6 9.5-3.5-2.1-6-5.3-6-9.5V6z"/><path d="M12 8v7M9.5 10.5 12 8l2.5 2.5"/></svg></span>;
  if (id === "proof") return <span className="pillar-icon" aria-hidden="true"><svg {...common}><circle cx="9" cy="9" r="2.5"/><circle cx="16.5" cy="10" r="2"/><path d="M4.5 18c.6-3.2 2.2-4.8 4.5-4.8s4 1.6 4.5 4.8M13 14.5c3.7-.6 5.7.6 6.5 3.5"/></svg></span>;
  if (id === "personality") return <span className="pillar-icon" aria-hidden="true"><svg {...common}><path d="m5 13 10-5v10L5 13Z"/><path d="M5 13v4M15 10.5l3-1.5M15 15.5l3 1.5"/></svg></span>;
  if (id === "community") return <span className="pillar-icon" aria-hidden="true"><svg {...common}><path d="M5 5.5h14v10H9l-4 3z"/><path d="M9 10.5h.01M12 10.5h.01M15 10.5h.01"/></svg></span>;
  return <span className="pillar-icon" aria-hidden="true"><svg {...common}><path d="M5 8h14v12H5zM4 8h16M12 8v12M7.5 8c-1.5-1.7-.8-4 1-4 1.6 0 2.7 1.5 3.5 4M16.5 8c1.5-1.7.8-4-1-4-1.6 0-2.7 1.5-3.5 4"/></svg></span>;
}
