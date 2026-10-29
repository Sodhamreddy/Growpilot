"use client";

import { useEffect, useRef, useState } from "react";
import type { ContentBrief } from "@ob/db";
import type { Suggestion } from "./TopicSuggester";
import { IconEdit, IconSpark } from "./Icons";
import { LoadingIndicator } from "./LoadingIndicator";
import styles from "./BlogBriefWorkspace.module.css";

export interface BriefPreview {
  brief: ContentBrief;
  sources: { title: string; url: string }[];
  keyword: { term: string; volume: number | null; intent: string | null };
}

export function BlogBriefWorkspace({ businessId, suggestion, onClose, onReject, onGenerated, initialPreview }: {
  businessId: string;
  suggestion: Suggestion;
  onClose: () => void;
  onReject: () => void;
  onGenerated: (articleId: string) => void;
  initialPreview?: BriefPreview;
}) {
  const [title, setTitle] = useState(suggestion.title);
  const [keyword, setKeyword] = useState(suggestion.primaryKeyword);
  const [preview, setPreview] = useState<BriefPreview | null>(initialPreview ?? null);
  const [mustInclude, setMustInclude] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [lastInstruction, setLastInstruction] = useState("");
  const [editingAngle, setEditingAngle] = useState(false);
  const [loading, setLoading] = useState(!initialPreview);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const started = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const angle = useRef<HTMLTextAreaElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const busy = loading || generating;

  async function refreshBrief(instructions = "") {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/topics/brief", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, title: title.trim(), primaryKeyword: keyword.trim(),
          intent: suggestion.intent, rationale: suggestion.rationale,
          ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
          ...(preview ? { previousBrief: preview.brief } : {}) }),
      });
      const result = await response.json() as BriefPreview & { error?: { message?: string } };
      if (!response.ok) throw new Error(result.error?.message ?? "Could not prepare the brief. Please try again.");
      setPreview(result);
      if (instructions.trim()) { setLastInstruction(instructions.trim()); setMessage(""); }
    } catch (err) { setError(err instanceof Error ? err.message : "Could not reach the server."); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    if (started.current || initialPreview) return;
    started.current = true;
    void refreshBrief();
  }, []);

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    root.current?.focus();
    return () => { document.body.style.overflow = previousOverflow; previousFocus?.focus(); };
  }, []);

  function updateBrief(patch: Partial<ContentBrief>) {
    setPreview((current) => current ? { ...current, brief: { ...current.brief, ...patch } } : current);
  }

  async function generateArticle() {
    if (!preview || busy) return;
    setGenerating(true);
    setError("");
    try {
      const response = await fetch("/api/topics/suggest", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, title: title.trim(), primaryKeyword: keyword.trim(),
          intent: suggestion.intent, rationale: suggestion.rationale, brief: preview.brief,
          mustInclude: mustInclude.map((item) => item.trim()).filter(Boolean) }),
      });
      const result = await response.json() as { articleId?: string; error?: { message?: string } };
      if (!response.ok || !result.articleId) throw new Error(result.error?.message ?? "Could not start the article.");
      onGenerated(result.articleId);
    } catch (err) { setError(err instanceof Error ? err.message : "Could not reach the server."); setGenerating(false); }
  }

  const keywordMatches = preview?.keyword.term.trim().toLowerCase() === keyword.trim().toLowerCase();
  const ready = Boolean(preview?.brief.angle.trim()) && keywordMatches && title.trim().length >= 4 && keyword.trim().length >= 2;
  return <div className={styles.workspace} role="dialog" aria-modal="true" aria-labelledby="brief-workspace-title" ref={root} tabIndex={-1}
    onKeyDown={(event) => {
      if (event.key === "Escape" && !generating) onClose();
      if (event.key !== "Tab") return;
      const elements = [...(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], summary, input:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? [])]
        .filter((element) => element.offsetParent !== null);
      const first = elements[0], last = elements.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === root.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
    <header className={styles.header}>
      <button type="button" className={styles.button} disabled={generating} onClick={onClose}><span aria-hidden>←</span> Back</button>
      <ol className={styles.steps} aria-label="Blog creation progress"><li><span className={styles.stepNumber}>1</span> Idea</li><li aria-current="step"><span className={styles.stepNumber}>2</span> Brief</li><li><span className={styles.stepNumber}>3</span> Draft</li></ol>
      <button type="button" className={styles.textButton} disabled={busy} onClick={onReject}>Discard idea</button>
    </header>
    <div className={styles.frame}>
      <div className={styles.scroll}>
        <div className={styles.layout}>
          <section className={styles.document} aria-label="Blog brief" aria-busy={loading}>
            <div className={styles.intro}><h1 id="brief-workspace-title">Review your brief</h1><p>Check the direction and requirements before writing your draft.</p></div>
            <label className={styles.field}><span>Article title</span><textarea className={styles.titleInput} rows={title.length > 72 ? 2 : 1} value={title} maxLength={200} disabled={busy} onChange={(event) => setTitle(event.target.value)} /></label>
            <div className={styles.summaryGrid}>
              <div className={styles.keywordSummary}>
                <label className={styles.field}><span>Target keyword</span><input aria-describedby={preview && !keywordMatches ? "keyword-notice" : undefined} value={keyword} maxLength={120} disabled={busy} onChange={(event) => setKeyword(event.target.value)} /></label>
                <div className={styles.chips}>
                  {keywordMatches && preview?.keyword.volume != null ? <span className={styles.volume}>{preview.keyword.volume.toLocaleString()} searches/mo</span> : <span className={styles.unmeasured}>Volume unavailable</span>}
                  <span className={styles.intent}>{suggestion.intent} intent</span>
                </div>
              </div>
              <div className={styles.summaryItem}><span>Audience</span><p>{preview?.brief.audience || (loading ? "Preparing…" : "Set when the brief is ready")}</p></div>
              <div className={styles.summaryItem}><span>Target length</span><p>{preview ? <>{preview.brief.targetWordCount.toLocaleString()} <small>words</small></> : "—"}</p></div>
            </div>
            {preview && !keywordMatches ? <p className={styles.keywordNotice} id="keyword-notice">Keyword changed. Regenerate the brief before creating your draft.</p> : null}
            {loading && <div className={styles.loading}><LoadingIndicator label={preview ? "Updating your brief…" : "Preparing your outline and sources…"} /></div>}
            <section className={styles.copyGroup}>
              <div className={styles.sectionHeader}><h2>Article angle</h2><button type="button" className={styles.textButton} disabled={!preview || busy} onClick={() => { setEditingAngle(!editingAngle); if (!editingAngle) requestAnimationFrame(() => angle.current?.focus()); }}><IconEdit size={14} />{editingAngle ? "Done" : "Edit angle"}</button></div>
              {editingAngle && preview ? <textarea aria-label="Article angle" ref={angle} rows={4} value={preview.brief.angle} maxLength={3000} disabled={busy} onChange={(event) => updateBrief({ angle: event.target.value })} /> : <p>{preview?.brief.angle ?? suggestion.rationale}</p>}
            </section>
            <section className={styles.copyGroup}>
              <h2>Key points</h2>
              {preview?.brief.outline.length ? <ul className={styles.points}>{preview.brief.outline.map((item, index) => <li key={`${index}:${item.heading}`}>{item.heading}</li>)}</ul> : <p className={styles.muted}>{loading ? "The outline will appear here when it is ready." : "No outline is available yet. Regenerate the brief to prepare one."}</p>}
            </section>
            <section className={styles.requirements}>
              <div className={styles.sectionHeader}><h2>Writing requirements</h2><span className={styles.optional}>Optional</span></div>
              <p className={styles.muted}>Add a tone, a point to cover, or exact wording the writer should use.</p>
              {mustInclude.map((item, index) => <div className={styles.includeRow} key={index}>
                <textarea aria-label={`Must include ${index + 1}`} placeholder="For example: Use simple language and end with a clear next step." rows={2} maxLength={500} value={item} disabled={busy} onChange={(event) => setMustInclude((items) => items.map((text, i) => i === index ? event.target.value : text))} />
                <button type="button" className={styles.removeButton} aria-label={`Remove instruction ${index + 1}`} disabled={busy} onClick={() => setMustInclude((items) => items.filter((_, i) => i !== index))}>×</button>
              </div>)}
              <button type="button" className={styles.button} disabled={busy || mustInclude.length >= 12} onClick={() => setMustInclude((items) => [...items, ""])}><span aria-hidden>＋</span> Add requirement</button>
            </section>
            {preview && <details className={styles.sourceDetails}><summary>Sources <span>{preview.sources.length}</span><small>View supporting links</small></summary>
              {preview.sources.length ? <ul className={styles.sources}>{preview.sources.map((source) => <li key={source.url}><a href={source.url} target="_blank" rel="noopener noreferrer">{source.title || source.url}</a><span>{sourceHost(source.url)}</span></li>)}</ul> : <p className={styles.muted}>No linked sources were found. Review the business facts before generating.</p>}
            </details>}
          </section>
          <aside className={styles.assistant} aria-labelledby="brief-refine-title">
            <h2 id="brief-refine-title"><IconSpark size={18} /> Refine with AI</h2>
            <p>Describe what you would like to change in the angle, outline, or audience.</p>
            <div className={styles.promptList} aria-label="Example refinements">
              {[
                ["Make it more practical", "Make the brief more practical, with useful steps and examples."],
                ["Focus on beginners", "Adapt the angle and outline for beginners. Explain unfamiliar terms."],
                ["Use a local angle", "Focus the brief on the local audience using only the business facts and sources available."],
              ].map(([label, instruction]) => <button type="button" key={label} className={styles.promptButton} disabled={busy} onClick={() => { setMessage(instruction!); composer.current?.focus(); }}>{label}<span aria-hidden>↗</span></button>)}
            </div>
            <form className={styles.composer} onSubmit={(event) => { event.preventDefault(); if (message.trim() && !busy) void refreshBrief(message); }}>
              <label htmlFor="brief-refinement">Your changes</label>
              <textarea id="brief-refinement" ref={composer} placeholder="For example: Focus on first-time buyers and include a short checklist." value={message} maxLength={2000} disabled={busy} onChange={(event) => setMessage(event.target.value)} rows={5} />
              <button type="submit" className={`${styles.button} ${styles.refineButton}`} disabled={busy || !message.trim()}>{loading && message.trim() ? <LoadingIndicator label="Updating…" /> : <><IconSpark size={15} />Update brief</>}</button>
            </form>
            <p className={styles.aiNote}>Regenerating or refining uses your AI budget.</p>
            {lastInstruction && <div className={styles.refinement} role="status"><strong>Brief updated</strong><p>{lastInstruction}</p><span>Review the changes before generating.</span></div>}
          </aside>
        </div>
      </div>
      <footer className={styles.footer}>
        {error && <p className={styles.error} role="alert">{error}</p>}
        <div className={styles.footerRow}><p className={styles.footerNote}>{generating ? "Saving your brief and starting the draft…" : loading ? "Preparing your brief…" : "Creates a blog draft for your review."}</p>
          <div className={styles.actions}><button type="button" className={styles.button} disabled={busy || !title.trim() || !keyword.trim()} onClick={() => void refreshBrief()}>{loading ? <LoadingIndicator label="Preparing…" /> : "Regenerate"}</button><button type="button" className={`${styles.button} ${styles.primary}`} disabled={busy || !ready} onClick={() => void generateArticle()}>{generating ? <LoadingIndicator label="Starting draft…" /> : <>Generate draft<span aria-hidden>→</span></>}</button></div>
        </div>
      </footer>
    </div>
  </div>;
}

function sourceHost(url: string) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}
