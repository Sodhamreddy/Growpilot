"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * Workspace policy — spec §15.1.
 *
 * Each control states what it actually governs, because these are not
 * preferences in the cosmetic sense: they decide whether content can be
 * published and how much the workspace may spend.
 */

export interface PreferencesValues {
  name: string;
  timezone: string;
  requireApprovalBeforePublish: boolean;
  requireHumanReviewForSensitive: boolean;
  autoPublishEnabled: boolean;
  minSeoScoreToPublish: number;
  minVoiceScoreToPublish: number;
  aiBudgetUsd: number;
}

const TIMEZONES = [
  "UTC", "Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Europe/London",
  "Europe/Berlin", "America/New_York", "America/Chicago", "America/Los_Angeles",
  "Australia/Sydney",
];

export function PreferencesForm({
  initial,
  canEdit,
}: {
  initial: PreferencesValues;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [v, setV] = useState<PreferencesValues>(initial);
  const [busy, setBusy] = useState(false);
  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = JSON.stringify(v) !== JSON.stringify(initial);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(v),
      });
      if (!res.ok) {
        const body: unknown = await res.json();
        setError((body as { error?: { message?: string } }).error?.message ?? "That did not save.");
        return;
      }
      setSaved(true);
      startTransition(() => router.refresh());
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  const disabled = !canEdit || busy || pending;

  return (
    <form onSubmit={(e) => void save(e)}>
      {!canEdit ? (
        <div className="finding warn" style={{ marginBottom: 18 }}>
          <div>Only an admin or owner can change workspace policy.</div>
          <div className="suggestion">→ You can see the current settings, but not edit them.</div>
        </div>
      ) : null}

      <div className="sectionhead"><h2>Workspace</h2></div>
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="grid cols-2">
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="ws-name">Workspace name</label>
            <input
              id="ws-name" value={v.name} disabled={disabled} maxLength={120}
              onChange={(e) => setV({ ...v, name: e.target.value })}
            />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="ws-tz">Timezone</label>
            <select
              id="ws-tz" value={v.timezone} disabled={disabled}
              onChange={(e) => setV({ ...v, timezone: e.target.value })}
            >
              {TIMEZONES.includes(v.timezone) ? null : <option value={v.timezone}>{v.timezone}</option>}
              {TIMEZONES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <div className="hint">Used for publish scheduling and report periods.</div>
          </div>
        </div>
      </div>

      <div className="sectionhead">
        <h2>Publishing policy</h2>
        <span className="note">Enforced on every approval and publish</span>
      </div>
      <div className="card" style={{ marginBottom: 20 }}>
        <Toggle
          id="p-approve"
          checked={v.requireApprovalBeforePublish}
          disabled={disabled}
          onChange={(c) => setV({ ...v, requireApprovalBeforePublish: c })}
          title="Require human approval before publishing"
          desc="Drafts that pass every gate wait for a person. Turning this off lets approved content publish automatically."
        />
        <Toggle
          id="p-sensitive"
          checked={v.requireHumanReviewForSensitive}
          disabled={disabled}
          onChange={(c) => setV({ ...v, requireHumanReviewForSensitive: c })}
          title="Flag sensitive topics for human review"
          desc="Medical, legal, financial and safety content is held for review rather than passing the risk gate silently."
        />
        <Toggle
          id="p-auto"
          checked={v.autoPublishEnabled}
          disabled={disabled}
          onChange={(c) => setV({ ...v, autoPublishEnabled: c })}
          title="Allow scheduled auto-publishing"
          desc="Approved articles with a publish date go out without a second confirmation."
          caution={v.autoPublishEnabled && !v.requireApprovalBeforePublish}
          cautionText="With approval also switched off, generated content can reach your site with no human check at all."
        />
      </div>

      <div className="sectionhead">
        <h2>Quality thresholds</h2>
        <span className="note">Below these, publishing is blocked</span>
      </div>
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="grid cols-2">
          <Slider
            id="p-seo" label="Minimum SEO score" value={v.minSeoScoreToPublish} disabled={disabled}
            onChange={(n) => setV({ ...v, minSeoScoreToPublish: n })}
            hint="The weighted score from spec §7.1. 70 is the default."
          />
          <Slider
            id="p-voice" label="Minimum brand voice score" value={v.minVoiceScoreToPublish} disabled={disabled}
            onChange={(n) => setV({ ...v, minVoiceScoreToPublish: n })}
            hint="How closely a draft matches the approved voice. Only applies when a voice is active."
          />
        </div>
      </div>

      <div className="sectionhead">
        <h2>AI budget</h2>
        <span className="note">Checked before every model call</span>
      </div>
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="field" style={{ margin: 0, maxWidth: 260 }}>
          <label htmlFor="p-budget">Monthly ceiling (USD)</label>
          <input
            id="p-budget" type="number" min={0} max={100000} step={5}
            value={v.aiBudgetUsd} disabled={disabled}
            onChange={(e) => setV({ ...v, aiBudgetUsd: Number(e.target.value) })}
          />
          <div className="hint">
            {v.aiBudgetUsd === 0
              ? "Zero means no ceiling — generation will never be blocked on cost."
              : "Generation stops once this month's spend reaches the ceiling."}
          </div>
        </div>
      </div>

      <div className="row">
        <button className="btn primary" type="submit" disabled={disabled || !dirty}>
          {busy || pending ? "Saving…" : "Save changes"}
        </button>
        {dirty && canEdit ? <span className="small muted">Unsaved changes</span> : null}
        {saved && !dirty ? <span className="badge ok">Saved</span> : null}
        {error ? <span className="error">{error}</span> : null}
      </div>
    </form>
  );
}

function Toggle({
  id, checked, disabled, onChange, title, desc, caution, cautionText,
}: {
  id: string; checked: boolean; disabled: boolean; onChange: (c: boolean) => void;
  title: string; desc: string; caution?: boolean; cautionText?: string;
}) {
  return (
    <div className="toggle">
      <input id={id} type="checkbox" checked={checked} disabled={disabled}
             onChange={(e) => onChange(e.target.checked)} />
      <label htmlFor={id}>
        <strong>{title}</strong>
        <span>{desc}</span>
        {caution ? <span className="cautionline">⚠ {cautionText}</span> : null}
      </label>
    </div>
  );
}

function Slider({
  id, label, value, disabled, onChange, hint,
}: {
  id: string; label: string; value: number; disabled: boolean;
  onChange: (n: number) => void; hint: string;
}) {
  return (
    <div className="field" style={{ margin: 0 }}>
      <label htmlFor={id}>
        {label} <strong style={{ color: "var(--text)" }}>{value}</strong>
      </label>
      <input
        id={id} type="range" min={0} max={100} step={5} value={value} disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: "100%", padding: 0, border: "none", background: "transparent" }}
      />
      <div className="hint">{hint}</div>
    </div>
  );
}
