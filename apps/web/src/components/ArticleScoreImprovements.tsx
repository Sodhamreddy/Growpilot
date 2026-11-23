"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { IconSpark } from "./Icons";
import { LoadingIndicator } from "./LoadingIndicator";
import styles from "./ArticleScoreImprovements.module.css";

/**
 * "Improve article with AI": one flow, one decision.
 *
 *   Find improvements → AI reviews the draft and writes the fixes (two requests,
 *   about a minute) → every change is listed with its before/after, ticked →
 *   Apply → saved as one new version, quality checks run again.
 *
 * Nothing is saved until Apply. Unticking a change composes the rest again on the
 * server from the text already written, without another AI request. Changes the AI
 * could not make safely, and work only a person can do, are listed apart, folded away.
 */

type MetadataTarget = "title" | "metaTitle" | "metaDescription";
type Target = MetadataTarget | "section" | "article";
type Area = "seo" | "brand" | "facts" | "readability" | "links" | "conversion" | "risk" | "publishing";
const AREA_LABELS: Record<Area, string> = {
  seo: "SEO", brand: "Brand voice", facts: "Facts", readability: "Readability", links: "Links & sources",
  conversion: "Call to action", risk: "Sensitive topics", publishing: "Publishing",
};
const TARGET_LABELS: Record<Target, string> = {
  title: "Article title", metaTitle: "SEO title", metaDescription: "Meta description", section: "Article text", article: "Whole article",
};

interface Suggestion {
  id: string; title: string; reason: string; priority: "high" | "medium" | "low"; target: Target;
  checks?: Area[]; sectionId?: string; instruction?: string; value?: string;
}
interface Plan {
  expectedVersion: number; currentScore: number | null; minimumScore: number; hasVoiceProfile?: boolean;
  summary: string; suggestions: Suggestion[]; followUps?: { area: Area; message: string; action: string }[];
}
interface Change { suggestionId: string; target: Target; sectionId?: string; before: string; after: string; changed: boolean; skipped?: string }
interface Patch { title?: string; metaTitle?: string | null; metaDescription?: string | null; bodyMarkdown?: string }
interface Prepared { changes: Change[]; patch: Patch }
interface Applied { version: number; count: number; qaQueued: boolean; warning?: string }

type Phase = "idle" | "reviewing" | "writing" | "ready" | "applying";

export interface ArticleScoreImprovementsProps {
  articleId: string;
  version: number;
  article: { title: string; metaTitle: string | null; metaDescription: string | null };
  onApplied?: () => void;
  onClose?: () => void;
  onApplyingChange?: (applying: boolean) => void;
}

class RequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/*
 * The note about the last save outlives the page.
 *
 * Saving makes a new version, and the article page rebuilds its whole review area
 * for a new version, so component state cannot carry "Applied 5 changes" across.
 * It is kept briefly in this tab's session instead, and the review area reopens
 * this panel when it finds one (see `recentImprovement`).
 */
const NOTE_KEY = (articleId: string) => `growpilot:improve-applied:${articleId}`;
const NOTE_TTL_MS = 10 * 60_000;

/** The last "Improve with AI" save for this article in this tab, if recent. */
export function recentImprovement(articleId: string, version?: number): Applied | null {
  try {
    const note = JSON.parse(sessionStorage.getItem(NOTE_KEY(articleId)) ?? "null") as (Applied & { at: number }) | null;
    if (!note || Date.now() - note.at > NOTE_TTL_MS || (version !== undefined && note.version !== version)) return null;
    return note;
  } catch { return null; }
}
function rememberImprovement(articleId: string, applied: Applied | null) {
  try {
    if (applied) sessionStorage.setItem(NOTE_KEY(articleId), JSON.stringify({ ...applied, at: Date.now() }));
    else sessionStorage.removeItem(NOTE_KEY(articleId));
  } catch { /* A private window may refuse storage; the save itself is unaffected. */ }
}

/** Each saved version gets a fresh session. */
export function ArticleScoreImprovements(props: ArticleScoreImprovementsProps) {
  const [applied, setApplied] = useState<Applied | null>(null);
  // Read after mount: the server render has no session storage.
  useEffect(() => { setApplied(recentImprovement(props.articleId, props.version)); }, [props.articleId, props.version]);
  return <Session key={`${props.articleId}:${props.version}`} {...props} applied={applied}
    onSaved={note => { rememberImprovement(props.articleId, note); setApplied(note); }}
    onDismiss={() => { rememberImprovement(props.articleId, null); setApplied(null); }} />;
}

function Session({ articleId, version, onApplied, onClose, onApplyingChange, applied, onSaved, onDismiss }: ArticleScoreImprovementsProps & {
  applied: Applied | null; onSaved: (applied: Applied) => void; onDismiss: () => void;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const [saved, setSaved] = useState(false);
  const request = useRef<AbortController | null>(null);

  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => { onApplyingChange?.(phase === "applying" || saved); }, [phase, saved, onApplyingChange]);
  useEffect(() => () => onApplyingChange?.(false), [onApplyingChange]);

  const suggestionFor = (id: string) => plan?.suggestions.find(suggestion => suggestion.id === id);
  const usable = prepared?.changes.filter(change => change.changed && !change.skipped) ?? [];
  const leftOut = prepared?.changes.filter(change => !change.changed || change.skipped) ?? [];
  const chosen = usable.filter(change => selected.includes(change.suggestionId));
  const busy = phase === "reviewing" || phase === "writing" || phase === "applying";

  async function send<T>(url: string, body: unknown, method = "POST"): Promise<T> {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
    const data = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    if (!response.ok) {
      throw new RequestError(data?.error?.message || (response.status === 401 ? "Your session ended. Sign in again to continue." : "That did not finish. Please try again."), response.status);
    }
    return data as T;
  }

  function fail(err: unknown) {
    if (err instanceof DOMException && err.name === "AbortError") return;
    if (err instanceof RequestError && err.status === 409) { setStale(true); setPlan(null); setPrepared(null); }
    setError(err instanceof Error ? err.message : "Could not reach the server. Please try again.");
    setPhase(prepared && !(err instanceof RequestError && err.status === 409) ? "ready" : "idle");
  }

  /** Step 1: what should change. Step 2: the changed text itself, for review. */
  async function findImprovements() {
    onDismiss();
    setError(""); setPlan(null); setPrepared(null); setSelected([]);
    try {
      setPhase("reviewing");
      const found = await send<Plan>(`/api/articles/${articleId}/improvements`, { expectedVersion: version });
      if (found.expectedVersion !== version) throw new RequestError("This draft changed. Refresh to start again.", 409);
      if (!Array.isArray(found.suggestions)) throw new Error("The suggestions could not be read. Please try again.");
      setPlan(found);
      if (!found.suggestions.length) { setPrepared({ changes: [], patch: {} }); setPhase("ready"); return; }
      setPhase("writing");
      const ready = await send<Prepared & { expectedVersion: number }>(`/api/articles/${articleId}/improvements/preview`,
        { expectedVersion: version, suggestions: found.suggestions });
      const changes = readChanges(ready.changes, found.suggestions);
      const patch = readPatch(ready.patch);
      if (!changes || !patch) throw new Error("The prepared changes could not be read. Please try again.");
      setPrepared({ changes, patch });
      setSelected(changes.filter(change => change.changed && !change.skipped).map(change => change.suggestionId));
      setPhase("ready");
    } catch (err) { fail(err); }
  }

  async function applyChanges() {
    if (!plan || !prepared || !chosen.length) return;
    setError("");
    try {
      setPhase("applying");
      let patch = prepared.patch;
      if (chosen.length !== usable.length) {
        // A narrower selection: compose it again from the text already written, without AI.
        const keep = new Set(chosen.map(change => change.suggestionId));
        const subset = await send<Prepared>(`/api/articles/${articleId}/improvements/preview`, {
          expectedVersion: version,
          suggestions: plan.suggestions.filter(suggestion => keep.has(suggestion.id)),
          prepared: chosen.filter(change => change.target === "section" || change.target === "article")
            .map(change => ({ sectionId: change.sectionId ?? "article", content: change.after })),
        });
        const subsetPatch = readPatch(subset.patch);
        if (!subsetPatch) throw new Error("The selected changes could not be prepared. Please try again.");
        patch = subsetPatch;
      }
      const result = await send<{ version: number; qaQueued?: boolean; qaWarning?: string }>(`/api/articles/${articleId}`,
        { ...patch, expectedVersion: version, runQualityChecks: true }, "PATCH");
      if (!Number.isInteger(result.version) || result.version <= version) {
        setPhase("ready"); setError("These changes already match the draft. Nothing new was saved.");
        return;
      }
      setSaved(true);
      onSaved({ version: result.version, count: chosen.length, qaQueued: Boolean(result.qaQueued), ...(result.qaWarning ? { warning: result.qaWarning } : {}) });
      router.refresh();
      onApplied?.();
    } catch (err) { fail(err); }
  }

  function startOver() {
    request.current?.abort();
    setPhase("idle"); setPlan(null); setPrepared(null); setSelected([]); setError("");
  }
  function toggle(id: string, on: boolean) {
    setSelected(current => on ? [...current.filter(item => item !== id), id] : current.filter(item => item !== id));
  }

  return <section className={styles.panel} aria-labelledby={`${articleId}-improve-title`} aria-busy={busy}>
    <header className={styles.header}>
      <h3 id={`${articleId}-improve-title`}><IconSpark size={18} /> Improve article with AI</h3>
      {onClose && <button type="button" className={styles.close} aria-label="Close" disabled={phase === "applying" || saved} onClick={onClose}>×</button>}
    </header>

    {applied && <p className={styles.success} role="status">
      Applied {applied.count} {applied.count === 1 ? "change" : "changes"} as version {applied.version}.{" "}
      {applied.qaQueued ? "Quality checks are running; the new score appears when they finish." : "Run quality checks to see the new score."}
      {applied.warning && <><br />{applied.warning}</>}
    </p>}
    {saved && <p className={styles.note}><LoadingIndicator label="Saved. Loading the updated article…" /></p>}
    {error && <p className={styles.error} role="alert">{error}</p>}

    {stale && !saved && <div className={styles.block}>
      <p className={styles.warning}>This draft changed while AI was working, so these changes no longer fit it.</p>
      <button type="button" className={styles.button} onClick={() => { setStale(false); setError(""); router.refresh(); }}>Refresh article</button>
    </div>}

    {!stale && !saved && phase === "idle" && <div className={styles.block}>
      <p className={styles.lead}>AI checks this draft against its quality findings and writes the fixes. You see every change before anything is saved.</p>
      <div className={styles.actions}>
        <button type="button" className={styles.primary} onClick={() => void findImprovements()}>Find improvements</button>
        <span className={styles.note}>Takes about a minute. Uses your AI budget.</span>
      </div>
    </div>}

    {(phase === "reviewing" || phase === "writing") && <div className={styles.progress} role="status" aria-live="polite">
      <ol>
        <li data-state={phase === "reviewing" ? "active" : "done"}>Reviewing the draft</li>
        <li data-state={phase === "writing" ? "active" : "waiting"}>Writing the changes</li>
      </ol>
      <LoadingIndicator label={phase === "reviewing" ? "Step 1 of 2: reviewing the draft…" : "Step 2 of 2: writing the changes…"} />
    </div>}

    {(phase === "ready" || phase === "applying") && plan && prepared && !saved && <div className={styles.block}>
      <p className={styles.score}>
        SEO score <strong>{plan.currentScore === null ? "not checked yet" : format(plan.currentScore)}</strong>
        <span aria-hidden>·</span> minimum <strong>{format(plan.minimumScore)}</strong>
        {plan.hasVoiceProfile === false && <><span aria-hidden>·</span> Brand voice <strong>not set up</strong></>}
      </p>
      {plan.summary && <p className={styles.summary}>{plan.summary}</p>}

      {usable.length ? <>
        <div className={styles.listHead}>
          <strong>{usable.length} {usable.length === 1 ? "change" : "changes"} ready</strong>
          {usable.length > 1 && <label className={styles.selectAll}>
            <input type="checkbox" checked={chosen.length === usable.length} disabled={busy}
              onChange={event => setSelected(event.target.checked ? usable.map(change => change.suggestionId) : [])} /> Select all
          </label>}
        </div>
        <ul className={styles.changes}>{usable.map(change => {
          const suggestion = suggestionFor(change.suggestionId);
          const on = selected.includes(change.suggestionId);
          const short = change.target !== "section" && change.target !== "article";
          return <li key={change.suggestionId} className={styles.change} data-selected={on}>
            <label className={styles.changeTitle}>
              <input type="checkbox" checked={on} disabled={busy} onChange={event => toggle(change.suggestionId, event.target.checked)} />
              <span><strong>{suggestion?.title ?? TARGET_LABELS[change.target]}</strong><span className={styles.tag}>{TARGET_LABELS[change.target]}</span></span>
            </label>
            {suggestion?.reason && <p className={styles.reason}>{suggestion.reason}</p>}
            {short
              ? <div className={styles.inline}><span className={styles.before}>{change.before || "Not set"}</span><span aria-hidden>→</span><span className={styles.after}>{change.after}</span></div>
              : <details className={styles.details}><summary>Show the rewritten text</summary>
                <div className={styles.compare}>
                  <div><h6>Now</h6><div className={styles.text}>{change.before}</div></div>
                  <div><h6>After</h6><div className={`${styles.text} ${styles.afterText}`}>{change.after}</div></div>
                </div>
              </details>}
          </li>;
        })}</ul>
      </> : <p className={styles.lead}>No text changes are needed right now.{plan.followUps?.length ? " The items below need a person." : ""}</p>}

      {leftOut.length > 0 && <details className={styles.fold}>
        <summary>{leftOut.length} {leftOut.length === 1 ? "suggestion" : "suggestions"} left out</summary>
        <ul>{leftOut.map(change => <li key={change.suggestionId}>
          <strong>{suggestionFor(change.suggestionId)?.title ?? TARGET_LABELS[change.target]}</strong>
          <span>{change.skipped ?? "No change was needed."}</span>
        </li>)}</ul>
      </details>}

      {Boolean(plan.followUps?.length) && <details className={`${styles.fold} ${styles.attention}`}>
        <summary>Needs your input ({plan.followUps!.length})</summary>
        <ul>{plan.followUps!.map((item, index) => <li key={`${item.area}:${index}`}>
          <strong>{AREA_LABELS[item.area] ?? item.area}</strong><span>{item.message}</span><span className={styles.action}>{item.action}</span>
        </li>)}</ul>
      </details>}

      <div className={styles.footer}>
        {usable.length > 0 && <button type="button" className={styles.primary} disabled={busy || !chosen.length} onClick={() => void applyChanges()}>
          {phase === "applying" ? <LoadingIndicator label="Saving…" /> : `Apply ${chosen.length} ${chosen.length === 1 ? "change" : "changes"}`}
        </button>}
        <button type="button" className={styles.button} disabled={busy} onClick={startOver}>Start over</button>
      </div>
      {usable.length > 0 && <p className={styles.note}>Saved as a new version of the draft. Quality checks run again automatically.</p>}
    </div>}
  </section>;
}

const format = (score: number) => score.toLocaleString("en-US", { maximumFractionDigits: 1 });

/** The prepared changes, if they are the ones asked for and well formed. */
function readChanges(value: unknown, suggestions: Suggestion[]): Change[] | null {
  if (!Array.isArray(value)) return null;
  const ids = new Set(suggestions.map(suggestion => suggestion.id));
  const seen = new Set<string>();
  for (const change of value as Change[]) {
    if (!change || typeof change !== "object" || !ids.has(change.suggestionId) || seen.has(change.suggestionId)
      || typeof change.before !== "string" || typeof change.after !== "string" || typeof change.changed !== "boolean") return null;
    seen.add(change.suggestionId);
  }
  return value as Change[];
}

/** Only the fields an article edit accepts. */
function readPatch(value: unknown): Patch | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const patch: Patch = {};
  for (const key of ["title", "bodyMarkdown"] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== "string") return null;
    patch[key] = raw[key] as string;
  }
  for (const key of ["metaTitle", "metaDescription"] as const) {
    if (raw[key] === undefined) continue;
    if (raw[key] !== null && typeof raw[key] !== "string") return null;
    patch[key] = raw[key] as string | null;
  }
  return patch;
}
