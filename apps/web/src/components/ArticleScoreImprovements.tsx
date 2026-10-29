"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { IconSpark } from "./Icons";
import { LoadingIndicator } from "./LoadingIndicator";
import styles from "./ArticleScoreImprovements.module.css";

type MetadataTarget = "title" | "metaTitle" | "metaDescription";
interface ImprovementSuggestion {
  id: string;
  title: string;
  reason: string;
  priority: "high" | "medium" | "low";
  target: MetadataTarget | "section";
  sectionId?: string;
  instruction?: string;
  value?: string;
}
interface ImprovementResult {
  expectedVersion: number;
  currentScore: number | null;
  minimumScore: number;
  summary: string;
  suggestions: ImprovementSuggestion[];
}
interface PreparedChange {
  suggestionId: string;
  target: ImprovementSuggestion["target"];
  sectionId?: string;
  before: string;
  after: string;
  changed: boolean;
}
interface ImprovementPatch {
  title?: string;
  metaTitle?: string | null;
  metaDescription?: string | null;
  bodyMarkdown?: string;
}
interface BatchPreview {
  expectedVersion: number;
  changes: PreparedChange[];
  patch: ImprovementPatch;
  allSuggestions: boolean;
}
interface BatchPreviewResponse {
  expectedVersion: number;
  changes: PreparedChange[];
  patch: ImprovementPatch;
}

export interface ArticleScoreImprovementsProps {
  articleId: string;
  version: number;
  article: { title: string; metaTitle: string | null; metaDescription: string | null };
  onApplied?: () => void;
  onClose?: () => void;
  onApplyingChange?: (applying: boolean) => void;
}

class ImprovementRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

const TARGET_LABELS = {
  title: "Article title", metaTitle: "SEO title", metaDescription: "Meta description", section: "Article content",
};
const scoreLabel = (score: number) => score.toLocaleString("en-US", { maximumFractionDigits: 1 });

/** A saved article version owns its selections and previews. */
export function ArticleScoreImprovements(props: ArticleScoreImprovementsProps) {
  return <ImprovementSession key={`${props.articleId}:${props.version}`} {...props} />;
}

function ImprovementSession({ articleId, version, onApplied, onClose, onApplyingChange }: ArticleScoreImprovementsProps) {
  const router = useRouter();
  const headingId = useId();
  const previewId = useId();
  const [result, setResult] = useState<ImprovementResult | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [preview, setPreview] = useState<BatchPreview | null>(null);
  const [busy, setBusy] = useState<"suggest" | "preview" | "apply" | null>(null);
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const [done, setDone] = useState("");
  const [qaWarning, setQaWarning] = useState("");
  const [appliedVersion, setAppliedVersion] = useState<number | null>(null);
  const mounted = useRef(true);
  const locked = useRef(false);
  const request = useRef<AbortController | null>(null);
  const previewHeading = useRef<HTMLHeadingElement>(null);
  const selectAllInput = useRef<HTMLInputElement>(null);
  const selected = result?.suggestions.filter(suggestion => selectedIds.includes(suggestion.id)) ?? [];
  const allSelected = Boolean(result?.suggestions.length) && selected.length === result?.suggestions.length;
  const changedCount = preview?.changes.filter(change => change.changed).length ?? 0;
  const aimScore = result ? Math.min(100, Math.max(85, result.minimumScore + 5)) : null;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; request.current?.abort(); };
  }, []);
  useEffect(() => { if (preview) previewHeading.current?.focus(); }, [preview]);
  useEffect(() => {
    if (selectAllInput.current) selectAllInput.current.indeterminate = selected.length > 0 && !allSelected;
  }, [selected.length, allSelected]);
  useEffect(() => { onApplyingChange?.(busy === "apply" || appliedVersion !== null); }, [busy, appliedVersion, onApplyingChange]);
  useEffect(() => () => onApplyingChange?.(false), [onApplyingChange]);

  function start(kind: NonNullable<typeof busy>) {
    if (locked.current || stale || appliedVersion !== null) return null;
    locked.current = true;
    const controller = new AbortController();
    request.current = controller;
    setBusy(kind); setError(""); setDone(""); setQaWarning("");
    return controller;
  }
  function finish(controller: AbortController) {
    if (request.current !== controller) return;
    request.current = null;
    locked.current = false;
    if (mounted.current) setBusy(null);
  }
  function showError(error: unknown, controller: AbortController) {
    if (!mounted.current || controller.signal.aborted) return;
    if (error instanceof ImprovementRequestError && error.status === 409) {
      setStale(true); setResult(null); setPreview(null); setSelectedIds([]);
    }
    setError(error instanceof Error ? error.message : "Could not reach the server. Please try again.");
  }
  async function send<T>(url: string, body: unknown, controller: AbortController, method = "POST"): Promise<T> {
    const response = await fetch(url, { method, headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: controller.signal });
    let data: unknown;
    try { data = await response.json(); }
    catch { throw new ImprovementRequestError("The server returned an unreadable response. Please try again.", response.status); }
    if (!response.ok) {
      const message = (data as { error?: { message?: string } }).error?.message;
      throw new ImprovementRequestError(message || (response.status === 401 ? "Your session ended. Sign in again to continue." : "That request did not finish. Please try again."), response.status);
    }
    return data as T;
  }

  function select(ids: string[] | ((current: string[]) => string[])) {
    if (locked.current || stale || appliedVersion !== null) return;
    setSelectedIds(ids); setPreview(null); setError(""); setDone("");
  }
  function toggle(suggestionId: string, checked: boolean) {
    select(current => checked ? [...current.filter(id => id !== suggestionId), suggestionId] : current.filter(id => id !== suggestionId));
  }
  function refreshArticle() {
    if (locked.current) return;
    // A QA rerun can change findings without changing the article version.
    // Permit a fresh plan after an explicit refresh, while discarding every old proposal.
    if (appliedVersion === null) {
      setStale(false); setResult(null); setPreview(null); setSelectedIds([]); setError("");
    }
    router.refresh();
  }

  async function suggest() {
    const controller = start("suggest");
    if (!controller) return;
    setResult(null); setPreview(null); setSelectedIds([]);
    try {
      const data = await send<ImprovementResult>(`/api/articles/${articleId}/improvements`, { expectedVersion: version }, controller);
      if (!mounted.current || controller.signal.aborted) return;
      if (data.expectedVersion !== version) throw new ImprovementRequestError("This draft changed. Refresh the article for current suggestions.", 409);
      if (!Array.isArray(data.suggestions) || (data.currentScore !== null && !Number.isFinite(data.currentScore)) || !Number.isFinite(data.minimumScore)) throw new Error("The suggestions could not be read. Please try again.");
      setResult(data); setSelectedIds(data.suggestions.map(suggestion => suggestion.id));
    } catch (error) { showError(error, controller); }
    finally { finish(controller); }
  }

  async function previewChanges(includeAll = false) {
    if (!result || result.expectedVersion !== version) return;
    const chosen = includeAll ? result.suggestions : selected;
    if (!chosen.length) return;
    const controller = start("preview");
    if (!controller) return;
    setPreview(null);
    if (includeAll) setSelectedIds(chosen.map(suggestion => suggestion.id));
    try {
      const data = await send<BatchPreviewResponse>(`/api/articles/${articleId}/improvements/preview`,
        { expectedVersion: version, suggestions: chosen }, controller);
      if (!mounted.current || controller.signal.aborted) return;
      if (data.expectedVersion !== version) throw new ImprovementRequestError("This draft changed. Refresh before reviewing these improvements.", 409);
      const requested = new Map(chosen.map(suggestion => [suggestion.id, suggestion]));
      const seen = new Set<string>();
      if (!Array.isArray(data.changes) || !data.changes.length || data.changes.length !== chosen.length ||
        data.changes.some(change => {
          if (!change || typeof change !== "object") return true;
          const original = requested.get(change.suggestionId);
          if (!original || seen.has(change.suggestionId) || change.target !== original.target ||
            change.sectionId !== original.sectionId || typeof change.before !== "string" || typeof change.after !== "string" || typeof change.changed !== "boolean") return true;
          seen.add(change.suggestionId);
          return false;
        })) throw new Error("The proposed changes could not be read. Please preview them again.");
      const patch = readPatch(data.patch);
      if (!patch || (data.changes.some(change => change.changed) && !Object.keys(patch).length)) throw new Error("The proposed changes could not be prepared. Please try again.");
      const reviewedFields = new Set(data.changes.map(change => change.target === "section" ? "bodyMarkdown" : change.target));
      if (Object.keys(patch).some(field => !reviewedFields.has(field as MetadataTarget | "bodyMarkdown"))) throw new Error("The preview included an unexpected change. Please request a fresh preview.");
      setPreview({ expectedVersion: data.expectedVersion, changes: data.changes, patch,
        allSuggestions: chosen.length === result.suggestions.length });
    } catch (error) { showError(error, controller); }
    finally { finish(controller); }
  }

  async function applyChanges() {
    if (!preview || !changedCount || preview.expectedVersion !== version) return;
    const controller = start("apply");
    if (!controller) return;
    try {
      const data = await send<{ version: number; rescoreNeeded?: boolean; qaQueued?: boolean; qaWarning?: string }>(
        `/api/articles/${articleId}`, { ...preview.patch, expectedVersion: preview.expectedVersion, runQualityChecks: true }, controller, "PATCH");
      if (!mounted.current || controller.signal.aborted) return;
      if (data.version === version) {
        setPreview(null); setDone("The selected changes already match this draft. You can review another selection.");
        return;
      }
      if (!Number.isInteger(data.version) || data.version <= version) throw new Error("The save result could not be confirmed. Refresh the article before continuing.");
      setAppliedVersion(data.version); setResult(null); setPreview(null); setSelectedIds([]);
      setDone(`Saved ${changedCount} ${changedCount === 1 ? "change" : "changes"} together as version ${data.version}. ${data.qaQueued ? "Quality checks are queued to measure the updated score." : "Run quality checks to measure the updated score."}`);
      if (data.qaWarning) setQaWarning(data.qaWarning);
      router.refresh();
      onApplied?.();
    } catch (error) { showError(error, controller); }
    finally { finish(controller); }
  }

  return <section className={styles.panel} aria-labelledby={headingId} aria-busy={Boolean(busy)}>
    <header className={styles.header}>
      <div><h3 id={headingId}><IconSpark size={18} /> Improve your score with AI</h3>
        <p>Choose improvements, preview them together, then apply the changes you want.</p></div>
      {onClose && <button type="button" className={styles.close} aria-label="Close score improvement suggestions" disabled={busy === "apply" || appliedVersion !== null} onClick={onClose}>×</button>}
    </header>
    {appliedVersion === null && !stale && <div className={styles.requestRow}>
      <button type="button" className={styles.primary} disabled={Boolean(busy)} onClick={() => void suggest()}>
        {busy === "suggest" ? <LoadingIndicator label="Reviewing your draft…" /> : result ? "Get fresh suggestions" : "Suggest improvements"}
      </button>
      <span className={styles.note}>AI suggestions and previews use your workspace AI budget.</span>
    </div>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    {done && <p className={styles.success} role="status">{done}</p>}
    {appliedVersion !== null && <p className={styles.note}><LoadingIndicator label="Loading updated article…" /></p>}
    {qaWarning && <p className={styles.warning} role="status">Your changes are saved. {qaWarning}</p>}
    {(stale || appliedVersion !== null) && <button type="button" className={styles.button} disabled={Boolean(busy)} onClick={refreshArticle}>Refresh article</button>}
    {result && <>
      <div className={styles.scoreRow}>
        <span>Current score <strong>{result.currentScore === null ? "Not checked" : scoreLabel(result.currentScore)}</strong></span>
        <span>Publishing minimum <strong>{scoreLabel(result.minimumScore)}</strong></span>
        {result.currentScore !== null && aimScore !== null && result.currentScore >= aimScore
          ? <span>Focus <strong>Further refinement</strong></span>
          : <span>Writing aim <strong>{aimScore === 100 ? "100" : `${aimScore}+`}</strong></span>}
      </div>
      <p className={styles.goalNote}>AI can suggest further improvements above the publishing minimum. The new score is measured after the changes are saved.</p>
      <p className={styles.summary}>{result.summary}</p>
      {result.suggestions.length ? <>
        <div className={styles.selectionBar} role="group" aria-label="Choose improvements">
          <label className={styles.selectAll}><input type="checkbox" ref={selectAllInput} checked={allSelected} disabled={Boolean(busy)} onChange={event => select(event.target.checked ? result.suggestions.map(suggestion => suggestion.id) : [])} /> Select all</label>
          <span className={styles.selectionCount} role="status">{selected.length} of {result.suggestions.length} selected</span>
          <div className={styles.batchActions}>
            <button type="button" className={styles.primary} disabled={Boolean(busy) || !selected.length} aria-controls={previewId} aria-expanded={Boolean(preview)} onClick={() => void previewChanges()}>
              {busy === "preview" ? <LoadingIndicator label="Preparing changes…" /> : allSelected ? `Preview all (${selected.length})` : `Preview selected (${selected.length})`}
            </button>
            {!allSelected && <button type="button" className={styles.button} disabled={Boolean(busy)} onClick={() => void previewChanges(true)}>Preview all</button>}
          </div>
        </div>
        {busy === "preview" && <p className={styles.note} role="status">Preparing a combined preview of {selected.length} {selected.length === 1 ? "improvement" : "improvements"}…</p>}
        <ol className={styles.suggestions} aria-label="Suggested improvements">{result.suggestions.map(suggestion => <li key={suggestion.id} className={styles.suggestion} data-selected={selectedIds.includes(suggestion.id)}>
          <label className={styles.suggestionChoice}><input type="checkbox" checked={selectedIds.includes(suggestion.id)} disabled={Boolean(busy)} aria-label={`Select improvement: ${suggestion.title}`} onChange={event => toggle(suggestion.id, event.target.checked)} />
            <span><span className={styles.priority} data-priority={suggestion.priority}>{suggestion.priority} priority</span><span className={styles.target}>{TARGET_LABELS[suggestion.target]}</span><strong>{suggestion.title}</strong></span>
          </label>
          <p className={styles.reason}>{suggestion.reason}</p>
        </li>)}</ol>
      </> : <p className={styles.note}>No supported changes were suggested. Review the quality findings or ask again after updating the draft.</p>}
      {preview && <div id={previewId} className={styles.preview}>
        <h4 tabIndex={-1} ref={previewHeading}>Review {preview.allSuggestions ? "all" : "your selected"} improvements</h4>
        <p className={styles.note}>These changes will be saved together in one new version. Nothing has been saved yet.</p>
        <div className={styles.preparedChanges}>{preview.changes.map(change => {
          const suggestion = result.suggestions.find(item => item.id === change.suggestionId);
          return <section className={styles.preparedChange} key={change.suggestionId} aria-label={suggestion?.title ?? TARGET_LABELS[change.target]}>
            <h5>{suggestion?.title ?? TARGET_LABELS[change.target]}{!change.changed && <span className={styles.unchanged}>No change</span>}</h5>
            <div className={styles.comparison}>
              <div><h6>Current</h6><div className={styles.changeText}>{change.before || "Not set"}</div></div>
              <div><h6>Proposed</h6><div className={`${styles.changeText} ${styles.proposed}`}>{change.after || "Not set"}</div></div>
            </div>
          </section>;
        })}</div>
        {!changedCount && <p className={styles.note}>The selected items already match the draft. Choose other suggestions or edit the draft directly.</p>}
        <div className={styles.previewActions}>
          <button type="button" className={styles.primary} disabled={Boolean(busy) || !changedCount} onClick={() => void applyChanges()}>
            {busy === "apply" ? <LoadingIndicator label="Saving changes…" /> : preview.allSuggestions ? `Apply all (${changedCount})` : `Apply selected (${changedCount})`}
          </button>
          <button type="button" className={styles.button} disabled={Boolean(busy)} onClick={() => setPreview(null)}>Back to suggestions</button>
        </div>
        <p className={styles.note}>Quality checks run again after applying. Review their result before approving the article.</p>
      </div>}
      <p className={styles.note}>Suggestions are based on saved version {result.expectedVersion}. You can improve the draft further after reviewing the new score.</p>
    </>}
  </section>;
}

/** Only the fields shown in the combined preview can be submitted to the normal editor. */
function readPatch(value: unknown): ImprovementPatch | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const patch: ImprovementPatch = {};
  if (raw["title"] !== undefined) {
    if (typeof raw["title"] !== "string") return null;
    patch.title = raw["title"];
  }
  if (raw["metaTitle"] !== undefined) {
    if (raw["metaTitle"] !== null && typeof raw["metaTitle"] !== "string") return null;
    patch.metaTitle = raw["metaTitle"] as string | null;
  }
  if (raw["metaDescription"] !== undefined) {
    if (raw["metaDescription"] !== null && typeof raw["metaDescription"] !== "string") return null;
    patch.metaDescription = raw["metaDescription"] as string | null;
  }
  if (raw["bodyMarkdown"] !== undefined) {
    if (typeof raw["bodyMarkdown"] !== "string") return null;
    patch.bodyMarkdown = raw["bodyMarkdown"];
  }
  return patch;
}
