"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArticleMarkdown, DraftEditor, type DraftArticle } from "./DraftEditor";
import { ApprovalActions } from "./ApprovalActions";
import { ArticleHistory } from "./ArticleHistory";
import { BlogCompanion, type CompanionSection } from "./BlogCompanion";
import { ArticleScoreImprovements } from "./ArticleScoreImprovements";
import { IconArticles, IconEdit, IconSpark } from "./Icons";
import { LoadingIndicator } from "./LoadingIndicator";
import { articleReviewState } from "@/lib/article-review";
import styles from "./ArticleReviewWorkspace.module.css";

export interface ArticleReviewWorkspaceProps {
  article: DraftArticle & { slug: string; seoScore: number | null; createdAt: string; publishedUrl: string | null };
  keyword: { term: string; volume: number | null; intent: string | null } | null;
  sources: { title: string; url: string }[];
  sections: CompanionSection[];
  gates: { gate: string; verdict: string; findings: { severity: "info" | "warn" | "error"; message: string; suggestion?: string }[] }[];
  canEdit: boolean;
  canReview: boolean;
  canPublish?: boolean;
  publishTarget: string | null;
  nextArticleId?: string | null;
  /** Isolated visual previews can turn off live status requests. */
  pollingEnabled?: boolean;
}

const STATUS: Record<string, string> = {
  draft: "Draft", generating: "In writing", qa: "Checking quality", needs_changes: "Needs changes",
  awaiting_approval: "In review", approved: "Approved", scheduled: "Scheduled", published: "Published", failed: "Needs attention",
};
const EDITABLE = ["draft", "qa", "needs_changes", "awaiting_approval"];

export function ArticleReviewWorkspace({ article, keyword, sources, sections, gates, canEdit, canReview, canPublish = false,
  publishTarget, nextArticleId, pollingEnabled = true }: ArticleReviewWorkspaceProps) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [reviewTab, setReviewTab] = useState<"checks" | "ai" | "details">("checks");
  const [aiMode, setAiMode] = useState<"score" | "rewrite">("score");
  const [mobileReviewOpen, setMobileReviewOpen] = useState(false);
  const [isNarrow, setIsNarrow] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [scoreApplying, setScoreApplying] = useState(false);
  const [rewriteApplying, setRewriteApplying] = useState(false);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [workerOnline, setWorkerOnline] = useState<boolean | null>(null);
  const [pollError, setPollError] = useState("");
  const [retryBusy, setRetryBusy] = useState(false);
  const [retryQueued, setRetryQueued] = useState(false);
  const [retryJobId, setRetryJobId] = useState<string | null>(null);
  const [retryError, setRetryError] = useState("");
  const workspaceRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const reviewPanelRef = useRef<HTMLElement>(null);
  const mobileReviewButton = useRef<HTMLButtonElement>(null);
  const hasContent = Boolean(article.bodyMarkdown.trim());
  const generating = retryQueued || article.status === "generating" || (article.status === "draft" && !hasContent);
  const checking = article.status === "qa";
  const inProgress = generating || checking;
  const showProgress = generating || (checking && !hasContent);
  const aiApplying = scoreApplying || rewriteApplying;
  const mutating = aiApplying || reviewBusy || restoring;
  const failedEmpty = !retryQueued && article.status === "failed" && !article.bodyMarkdown.trim();
  const editable = canEdit && EDITABLE.includes(article.status) && !checking;
  const blockers = gates.filter((gate) => gate.verdict === "fail");
  const findings = gates.flatMap((gate) => gate.findings.map((finding) => ({ ...finding, gate: gate.gate })));
  const questions = findings.filter((finding) => finding.severity !== "info");
  const status = STATUS[article.status] ?? article.status.replace(/_/g, " ");
  const wordCount = article.bodyMarkdown.trim() ? article.bodyMarkdown.trim().split(/\s+/).length : 0;
  const review = articleReviewState({ status: article.status, editing: editing || aiApplying || restoring, canEdit, canReview,
    hasContent: Boolean(article.bodyMarkdown.trim()), verdicts: gates.map(gate => gate.verdict) });
  const gateSnapshot = JSON.stringify(gates);
  const reviewExplanation = mutating ? "Updating this article. Review the result before continuing." : review.explanation;
  const scoreLabel = article.seoScore === null ? "Not checked" : article.seoScore.toLocaleString("en-US", { maximumFractionDigits: 1 });

  useEffect(() => {
    const media = window.matchMedia("(max-width: 1000px)");
    const update = () => {
      setIsNarrow(media.matches);
      if (media.matches && reviewPanelRef.current?.contains(document.activeElement)) setMobileReviewOpen(true);
    };
    update(); media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement as HTMLElement | null;
    document.body.style.overflow = "hidden";
    workspaceRef.current?.querySelector<HTMLElement>("a[href]")?.focus();
    return () => { document.body.style.overflow = previousOverflow; previousFocus?.focus(); };
  }, []);

  useEffect(() => {
    if (!pollingEnabled || (!inProgress && (!editable || editing || mutating))) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let continuePolling = true;
    const poll = async () => {
      try {
        const response = await fetch(`/api/articles/${article.id}`, { signal: controller.signal, cache: "no-store" });
        if ([401, 403, 404].includes(response.status)) {
          continuePolling = false;
          throw new Error(response.status === 401 ? "Your session ended. Sign in again to see progress." : "This article is no longer available to your account.");
        }
        if (!response.ok) throw new Error("Unable to check progress. We will try again shortly.");
        const data = await response.json() as { article: { status: string; version: number; seoScore: number | null }; gates: ArticleReviewWorkspaceProps["gates"] };
        if (!controller.signal.aborted) {
          setPollError("");
          const nextGates = JSON.stringify(data.gates.map(gate => ({ gate: gate.gate, verdict: gate.verdict, findings: gate.findings })));
          if (data.article.status !== article.status || data.article.version !== article.version || data.article.seoScore !== article.seoScore || nextGates !== gateSnapshot) router.refresh();
        }
        if (retryJobId && data.article.status === "failed") {
          const job = await fetch(`/api/articles/${article.id}/generate?jobId=${encodeURIComponent(retryJobId)}`, { signal: controller.signal, cache: "no-store" });
          if (job.ok) {
            const result = await job.json() as { state: string; error?: string | null };
            if (!controller.signal.aborted && result.state === "failed") {
              continuePolling = false;
              setRetryQueued(false);
              setRetryError(result.error || "Writing did not finish. Please retry or ask your workspace administrator to check background processing.");
            }
          }
        }
        if (inProgress) {
          const health = await fetch("/api/jobs/status", { signal: controller.signal, cache: "no-store" });
          if (health.ok) {
            const body = await health.json() as { worker?: { online: boolean } };
            if (!controller.signal.aborted && body.worker) setWorkerOnline(body.worker.online);
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) setPollError(error instanceof Error ? error.message : "Progress is temporarily unavailable.");
      } finally {
        if (!controller.signal.aborted && continuePolling) timer = setTimeout(() => void poll(), 5000);
      }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [article.id, article.status, article.version, article.seoScore, inProgress, editable, editing, mutating, gateSnapshot, pollingEnabled, retryJobId, router]);

  function edit() {
    setEditing(true);
    if (!isNarrow) contentRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    requestAnimationFrame(() => {
      const title = workspaceRef.current?.querySelector<HTMLInputElement>("#draft-title");
      title?.focus({ preventScroll: true }); title?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }
  function mayLeave() { return !hasUnsavedChanges || window.confirm("Leave this article and discard your unsaved edits?"); }
  function openReview(tab: typeof reviewTab = reviewTab) {
    setReviewTab(tab); setMobileReviewOpen(true);
    if (isNarrow) requestAnimationFrame(() => reviewPanelRef.current?.querySelector<HTMLElement>("button")?.focus());
  }
  function closeReview() {
    setMobileReviewOpen(false);
    requestAnimationFrame(() => mobileReviewButton.current?.focus());
  }
  async function retryGeneration() {
    setRetryBusy(true); setRetryError("");
    try {
      const response = await fetch(`/api/articles/${article.id}/generate`, { method: "POST" });
      const result = await response.json() as { jobId?: string; error?: { message?: string } };
      if (!response.ok) throw new Error(result.error?.message || "Could not queue this article. Please try again.");
      setRetryJobId(result.jobId ?? null); setRetryQueued(true);
      router.refresh();
    } catch (error) {
      setRetryError(error instanceof Error ? error.message : "Could not queue this article. Please try again.");
    } finally { setRetryBusy(false); }
  }
  function exportArticle(format: "md" | "txt") {
    const body = `# ${article.title}\n\n${article.bodyMarkdown}`;
    const blob = new Blob([body], { type: format === "md" ? "text/markdown;charset=utf-8" : "text/plain;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href; link.download = `${article.slug || "article"}.${format}`;
    link.click(); setTimeout(() => URL.revokeObjectURL(href), 1000);
  }

  return <div className={styles.workspace} ref={workspaceRef} role="dialog" aria-modal="true" aria-label="Blog article workspace" tabIndex={-1}
    onKeyDown={(event) => {
      if (event.key === "Escape" && isNarrow && mobileReviewOpen) { event.preventDefault(); closeReview(); return; }
      if (event.key !== "Tab") return;
      const scope = isNarrow && mobileReviewOpen ? reviewPanelRef.current : workspaceRef.current;
      const controls = [...(scope?.querySelectorAll<HTMLElement>("a[href],button:not([disabled]):not([tabindex='-1']),summary,input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex='0'],[contenteditable='true']") ?? [])]
        .filter(control => control.getClientRects().length > 0 && !control.closest("[inert]"));
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === workspaceRef.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
    <section className={styles.frame} aria-label="Blog workspace">
      <header className={styles.header} inert={isNarrow && mobileReviewOpen}>
        <div className={styles.headerContext}>
          <Link className={styles.backLink} href="/articles" onClick={(event) => {
            if (!mayLeave()) event.preventDefault();
          }}><span aria-hidden>←</span> All blogs</Link>
          <span className={styles.headerDivider} aria-hidden />
          <span className={styles.headerLabel}>{showProgress || failedEmpty ? "Writing workspace" : "Article workspace"}</span>
        </div>
        <div className={styles.headerActions}>
          <span className={styles.statusBadge} data-status={article.status}>{status}</span>
          {hasContent && !generating && <details className={styles.menu}>
            <summary className={styles.button}>Export <span aria-hidden>⌄</span></summary>
            <div className={styles.popover}>
              <strong>Export saved version {article.version}</strong>
              <button type="button" onClick={() => exportArticle("md")}>Markdown (.md)</button>
              <button type="button" onClick={() => exportArticle("txt")}>Text file (.txt)</button>
            </div>
          </details>}
        </div>
      </header>

      {showProgress || failedEmpty ? <div className={styles.progress} role="status" aria-live="polite">
        <span className={styles.spark}><IconSpark size={28} /></span>
        <span className={styles.eyebrow}>YOUR BLOG</span>
        <h1>{article.title}</h1>
        <h2>{failedEmpty ? "Writing needs your attention" : workerOnline === false ? "Waiting for background processing" : checking ? "Checking your draft" : retryQueued || article.status === "draft" ? "Your draft is queued" : "Writing your draft"}</h2>
        <p>{failedEmpty ? canEdit ? "Writing did not finish. Retry generation to continue with this article." : "Writing did not finish. An editor can retry this article."
          : workerOnline === false ? "Your task is saved. Processing will continue when the worker reconnects."
          : "You can leave this page and review other content. Your draft will appear here when it is ready."}</p>
        {!failedEmpty && workerOnline !== false && <div className={styles.progressLoader}><LoadingIndicator label={checking ? "Checking your draft…" : retryQueued || article.status === "draft" ? "Waiting for your draft…" : "Writing your draft…"} size="large" /></div>}
        {pollError && <p className={styles.progressError}>{pollError}</p>}
        {retryError && <p className={styles.progressError} role="alert">{retryError}</p>}
        <div className={styles.progressLinks}>
          {failedEmpty && canEdit && <button type="button" className={styles.primaryButton} disabled={retryBusy} onClick={() => void retryGeneration()}>{retryBusy ? <LoadingIndicator label="Queueing…" /> : "Retry generation"}</button>}
          {nextArticleId && <Link className={styles.button} href={`/articles/${nextArticleId}`}>Review next article</Link>}
          <Link className={styles.button} href="/articles">Back to all blogs</Link>
        </div>
      </div> : <>
        <div className={styles.mobileReviewBar} inert={isNarrow && mobileReviewOpen}>
          <span>SEO <strong>{scoreLabel}</strong>{questions.length ? ` · ${questions.length} items to review` : ""}</span>
          <button type="button" ref={mobileReviewButton} className={styles.button} aria-expanded={mobileReviewOpen} aria-controls="article-review-panel" onClick={() => openReview()}>Review & improve</button>
        </div>
        <div className={styles.workspaceBody}>
          <div className={styles.canvasColumn} inert={isNarrow && mobileReviewOpen}>
            <div className={styles.readerToolbar}>
              <span><IconArticles size={17} /> {editing ? "Editing draft" : "Article preview"}</span>
              {editable && <button type="button" className={styles.button} disabled={editing || mutating} onClick={edit}><IconEdit size={15} />{editing ? "Editing…" : "Edit article"}</button>}
              {checking && <span className={styles.checkingLabel}>{workerOnline === false ? "Quality checks queued" : <LoadingIndicator label="Checking quality…" />}</span>}
            </div>
            <div className={styles.scroll} ref={contentRef}>
              <article className={styles.document}>
                <div className={styles.documentHeading}>
                  <span className={styles.eyebrow}>BLOG ARTICLE</span>
                  <h1>{article.title}</h1>
                  <div className={styles.documentMeta}><span>Version {article.version}</span><span>{wordCount.toLocaleString()} words</span><span>Created {new Date(article.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}</span></div>
                  {keyword && <div className={styles.keywordRow}><span className={styles.keyword}>{keyword.term}</span>{keyword.volume !== null && <span>{keyword.volume.toLocaleString()} searches/mo</span>}{keyword.intent && <span>{keyword.intent} intent</span>}</div>}
                </div>
                {checking && <p className={styles.jobBanner} role="status">{workerOnline === false ? "Quality checks are waiting for background processing to reconnect." : "Quality checks are running. You can keep reading while the results are prepared."}</p>}
                {pollError && <p className={styles.jobBanner} role="status">{pollError}</p>}
                <div className={styles.proseArea}>{editing ? <DraftEditor key={`${article.id}:${article.version}`} article={article} canEdit={canEdit} initialMode="edit"
                  onDirtyChange={setHasUnsavedChanges} onDone={(saved) => { if (!saved) setEditing(false); setHasUnsavedChanges(false); }} />
                  : <ArticleMarkdown source={article.bodyMarkdown.replace(/^#\s+[^\n]+\n+/, heading => heading.replace(/^#\s+/, "").trim() === article.title.trim() ? "" : heading)} />}</div>
              </article>
            </div>
          </div>
          {mobileReviewOpen && <button type="button" className={styles.reviewBackdrop} aria-label="Close review tools" tabIndex={-1} onClick={closeReview} />}
          <aside id="article-review-panel" ref={reviewPanelRef} className={`${styles.reviewPanel} ${mobileReviewOpen ? styles.reviewOpen : ""}`}
            role={isNarrow ? "dialog" : undefined} aria-modal={isNarrow && mobileReviewOpen ? true : undefined} aria-labelledby="article-review-tools-title">
            <div className={styles.sideHeader}><div><h2 id="article-review-tools-title">Review & improve</h2><p>Everything you need for the next step.</p></div><button type="button" className={styles.closeReview} aria-label="Close review tools" onClick={closeReview}>×</button></div>
            <div className={styles.sideTabs} role="tablist" aria-label="Article review tools">
              {([['checks', 'Checks'], ['ai', 'AI help'], ['details', 'Details']] as const).map(([tab, label]) => <button key={tab} id={`review-tab-${tab}`} type="button" role="tab"
                aria-selected={reviewTab === tab} aria-controls={`review-content-${tab}`} tabIndex={reviewTab === tab ? 0 : -1} data-review-tab={tab}
                onClick={() => setReviewTab(tab)} onKeyDown={(event) => {
                  const tabs = ["checks", "ai", "details"] as const;
                  const index = tabs.indexOf(tab);
                  const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
                  if (next < 0) return; event.preventDefault(); const nextTab = tabs[next]!; setReviewTab(nextTab);
                  event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-review-tab="${nextTab}"]`)?.focus();
                }}>{label}{tab === "checks" && blockers.length > 0 && <span>{blockers.length}</span>}</button>)}
            </div>
            <div className={styles.sideScroll}>
              <section id="review-content-checks" role="tabpanel" aria-labelledby="review-tab-checks" hidden={reviewTab !== "checks"}>
                <div className={styles.scoreCard}><div><span className={styles.eyebrow}>SEO SCORE</span><strong>{scoreLabel}</strong><span>{article.seoScore === null ? "Run checks to get a score" : "Measured for this version"}</span></div><IconArticles size={27} /></div>
                {(editable || article.status === "failed") && <div className={styles.nextStep}><span className={styles.eyebrow}>{article.status === "failed" ? "DRAFT RECOVERY" : "AI ASSISTANCE"}</span><p>{article.status === "failed" ? "Retry writing to continue with this draft." : "Get suggested edits for the findings below, with a preview before you apply them."}</p>
                  {editable && !editing && <button type="button" className={styles.aiAction} disabled={mutating} onClick={() => { setAiMode("score"); setReviewTab("ai"); }}><IconSpark size={16} /> Improve score with AI <span aria-hidden>→</span></button>}
                  {article.status === "failed" && canEdit && <button type="button" className={styles.button} disabled={retryBusy} onClick={() => void retryGeneration()}>{retryBusy ? <LoadingIndicator label="Queueing…" /> : "Retry generation"}</button>}
                  {retryError && <p className={styles.actionError} role="alert">{retryError}</p>}
                </div>}
                <div className={styles.sectionLabel}><h3>Quality checks</h3><span>{gates.length ? `${gates.length} checks` : "Not run yet"}</span></div>
                {gates.length ? <div className={styles.gateList}>{gates.map(gate => <details key={gate.gate} className={styles.gate} open={gate.verdict === "fail"}>
                  <summary><span className={styles.gateDot} data-verdict={gate.verdict} /><strong>{gate.gate.replace(/_/g, " ")}</strong><span className={styles.gateVerdict} data-verdict={gate.verdict}>{gate.verdict === "fail" ? "Needs work" : gate.verdict === "warn" ? "Review" : "Passed"}</span></summary>
                  <div className={styles.gateFindings}>{gate.findings.length ? gate.findings.map((finding, index) => <div key={index} data-severity={finding.severity}><p>{finding.message}</p>{finding.suggestion && <span>{finding.suggestion}</span>}</div>) : <p>{gate.verdict === "fail" ? "Review this draft and run quality checks again." : "No issues were reported for this check."}</p>}</div>
                </details>)}</div> : <p className={styles.muted}>Run quality checks to review factual accuracy, SEO, and publishing requirements.</p>}
              </section>
              <section id="review-content-ai" role="tabpanel" aria-labelledby="review-tab-ai" hidden={reviewTab !== "ai"}>
                <div className={styles.aiModes} aria-label="AI assistance type"><button type="button" aria-pressed={aiMode === "score"} onClick={() => setAiMode("score")}>Improve SEO</button><button type="button" aria-pressed={aiMode === "rewrite"} onClick={() => setAiMode("rewrite")}>Rewrite a section</button></div>
                {!editable && <p className={styles.jobBanner}>Request changes before editing an approved article. AI assistance becomes available for editable drafts.</p>}
                {editable && <>
                  {editing && <p className={styles.jobBanner}>Save or discard your edits before asking AI to change the saved draft.</p>}
                  <div hidden={aiMode !== "score"}><fieldset className={styles.aiFieldset} disabled={editing || rewriteApplying || checking || reviewBusy || restoring}>
                    <ArticleScoreImprovements articleId={article.id} version={article.version} article={{ title: article.title, metaTitle: article.metaTitle, metaDescription: article.metaDescription }} onApplyingChange={setScoreApplying} />
                  </fieldset></div>
                  <div hidden={aiMode !== "rewrite"} className={styles.rewritePanel}><BlogCompanion articleId={article.id} version={article.version} sections={sections} canEdit={canEdit} editable={editable && !editing && !scoreApplying && !reviewBusy && !restoring} embedded onApplyingChange={setRewriteApplying} /></div>
                </>}
              </section>
              <section id="review-content-details" role="tabpanel" aria-labelledby="review-tab-details" hidden={reviewTab !== "details"}>
                <div className={styles.sectionLabel}><h3>Publishing details</h3>{editable && <button type="button" className={styles.textButton} disabled={editing || mutating} onClick={() => { if (isNarrow) closeReview(); edit(); }}>Edit</button>}</div>
                <dl className={styles.detailsList}><dt>URL slug</dt><dd>/{article.slug}</dd><dt>SEO title</dt><dd>{article.metaTitle || "Not set"}</dd><dt>Meta description</dt><dd>{article.metaDescription || "Not set"}</dd><dt>Destination</dt><dd>{publishTarget ? `Connected ${publishTarget} site` : <Link href="/integrations" onClick={event => { if (!mayLeave()) event.preventDefault(); }}>Connect a publishing site</Link>}</dd>
                  {article.publishedUrl && /^https?:\/\//i.test(article.publishedUrl) && <><dt>Published article</dt><dd><a href={article.publishedUrl} target="_blank" rel="noopener noreferrer">View live article ↗</a></dd></>}
                </dl>
                <details className={styles.sourceDetails}><summary>Sources used <span>{sources.length}</span></summary>{sources.length ? <ul>{sources.map(source => <li key={source.url}><a href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a></li>)}</ul> : <p className={styles.muted}>No source links are included in this draft.</p>}</details>
                <div className={styles.history}><ArticleHistory articleId={article.id} version={article.version} canRestore={editable && !editing && !mutating} onRestoringChange={setRestoring} /></div>
              </section>
            </div>
            <div className={styles.reviewDecision}>
              <p id="article-review-help" className={styles.reviewHint}>{reviewExplanation}</p>
              {canReview ? <ApprovalActions articleId={article.id} version={article.version} articleStatus={article.status}
                canApprove={review.canApprove} canRequestChanges={review.canRequestChanges && !checking}
                canPublish={!editing && !aiApplying && !restoring && canPublish && article.status === "approved" && Boolean(publishTarget)}
                canRunQa={review.canRunQa} approveDisabledReason={reviewExplanation} requestChangesDisabledReason={review.rejectReason}
                reviewHelpId="article-review-help" publishTarget={publishTarget} published={article.status === "published"} onBusyChange={setReviewBusy} compact />
                : <span className={styles.muted}>An editor or administrator can review this article.</span>}
            </div>
          </aside>
        </div>
      </>}
    </section>
  </div>;
}
