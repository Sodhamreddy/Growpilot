"use client";

import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArticleMarkdown, CommentHighlightedText, DraftEditor, type DraftArticle, type DraftEditorHandle } from "./DraftEditor";
import { ArticleCommentsPanel, useArticleComments } from "./ArticleComments";
import { getArticleBodySource, getArticleBodyText, getArticleCommentText, type CommentAnchor } from "@/lib/article-comment-text";
import { readArticleSelection } from "@/lib/article-comment-selection";
import { ApprovalActions } from "./ApprovalActions";
import { ArticleHistory } from "./ArticleHistory";
import { BlogCompanion, type CompanionSection } from "./BlogCompanion";
import { ArticleScoreImprovements, recentImprovement } from "./ArticleScoreImprovements";
import { ActivityView, ScoreArc, SeoView, gateInfo, scoreGrade, type ActivityEntry, type KeywordUse, type ScoreBreakdownItem } from "./ArticleWorkspaceViews";
import {
  IconArrowLeft, IconBars, IconCalendarSmall, IconChecks, IconChevronDown, IconChevronRight, IconClose, IconCollapse, IconComment,
  IconCopy, IconDownload, IconExpand, IconExternal, IconEye, IconFile, IconHistory, IconInfo, IconLayers, IconMore, IconPencil,
  IconPulse, IconShare, IconShield, IconSparkles, IconSupport, IconTick,
} from "./ArticleWorkspaceIcons";
import { Logo } from "./Logo";
import { APP_NAV } from "./AppNav";
import { LoadingIndicator } from "./LoadingIndicator";
import { articleReviewState } from "@/lib/article-review";
import type { PublishStatus } from "@/lib/publish-status";
import { publishers, waitingFor, type TeamReviewView } from "@/lib/team-review-view";
import styles from "./ArticleReviewWorkspace.module.css";

export interface ArticleReviewWorkspaceProps {
  article: DraftArticle & { slug: string; seoScore: number | null; createdAt: string; publishedUrl: string | null };
  keyword: { term: string; volume: number | null; intent: string | null } | null;
  /** Where the target keyword is used, measured on the server exactly as the SEO score does. */
  keywordUse?: KeywordUse | null;
  /** Related terms from the article's topic, shown beside the target keyword. */
  secondaryKeywords?: string[];
  sources: { title: string; url: string }[];
  sections: CompanionSection[];
  gates: { gate: string; verdict: string; findings: { severity: "info" | "warn" | "error"; message: string; suggestion?: string }[] }[];
  /** What makes up this version's SEO score. Empty until quality checks have run. */
  scoreBreakdown?: ScoreBreakdownItem[];
  /** This article's audit trail, newest first. */
  activity?: ActivityEntry[];
  activityLimit?: number;
  canEdit: boolean;
  canReview: boolean;
  canPublish?: boolean;
  publishTarget: string | null;
  /** The latest WordPress delivery (publishing creates a draft there). */
  delivery?: PublishStatus | null;
  /** Present when the workspace uses the team review (Content → Manager → Publish). */
  teamReview?: TeamReviewView | null;
  /** A review team member who only works on blogs: the GrowPilot menu offers Blog Automation alone. */
  blogOnly?: boolean;
  /** "Content team", "Manager"…, shown in the GrowPilot menu. */
  teamRole?: string | null;
  nextArticleId?: string | null;
  /** Isolated visual previews can turn off live status requests. */
  pollingEnabled?: boolean;
}

const STATUS: Record<string, string> = {
  draft: "Draft", generating: "In writing", qa: "Checking quality", needs_changes: "Needs changes",
  awaiting_approval: "In review", approved: "Approved", scheduled: "Scheduled", published: "Published", failed: "Needs attention",
};
const EDITABLE = ["draft", "qa", "needs_changes", "awaiting_approval"];
const DECIDED = ["approved", "scheduled", "published"];
type View = "article" | "seo" | "history" | "activity";
type Tab = "checks" | "ai" | "comments" | "details";
const TAB_ORDER: readonly Tab[] = ["checks", "ai", "comments", "details"];
const TABS: [Tab, string, ReactNode][] = [
  ["checks", "Checks", <IconChecks key="checks" size={17} />], ["ai", "AI Help", <IconSparkles key="ai" size={17} />],
  ["comments", "Comments", <IconComment key="comments" size={17} />], ["details", "Details", <IconInfo key="details" size={17} />],
];
const GUIDE = [
  "Read the preview. Select any text to leave a comment.",
  "Open Checks to see what passed and what needs work.",
  "Use AI Help to fix findings. You approve every change.",
  "Approve the article, then publish it to your website.",
];

/** A title ending "in <Place>" shows the place in the accent colour on the cover. */
function splitPlace(title: string): [string, string] {
  const match = /^(.*\S)\s+in\s+([A-Z][^,:;|–—]{1,40})$/.exec(title.trim());
  return match && match[2]!.trim().split(/\s+/).length <= 4 ? [`${match[1]} in `, match[2]!] : [title, ""];
}

export function ArticleReviewWorkspace({ article, keyword, keywordUse = null, secondaryKeywords = [], sources, sections, gates, scoreBreakdown = [], activity = [],
  activityLimit = 50, canEdit, canReview, canPublish = false, publishTarget, delivery = null, teamReview = null, blogOnly = false, teamRole = null, nextArticleId, pollingEnabled = true }: ArticleReviewWorkspaceProps) {
  const router = useRouter();
  const [view, setView] = useState<View>("article");
  const [focusMode, setFocusMode] = useState(false);
  const [shareState, setShareState] = useState<"idle" | "copied">("idle");
  const [textCopied, setTextCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [reviewTab, setReviewTab] = useState<Tab>("checks");
  const [aiMode, setAiMode] = useState<"score" | "rewrite">("score");
  const [mobileReviewOpen, setMobileReviewOpen] = useState(false);
  const [isNarrow, setIsNarrow] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [scoreApplying, setScoreApplying] = useState(false);
  const [rewriteApplying, setRewriteApplying] = useState(false);
  // Saving "Improve with AI" rebuilds this area for the new version; land back on its confirmation.
  useEffect(() => {
    if (recentImprovement(article.id, article.version)) { setAiMode("score"); setReviewTab("ai"); }
  }, [article.id, article.version]);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [workerOnline, setWorkerOnline] = useState<boolean | null>(null);
  const [pollError, setPollError] = useState("");
  const [retryBusy, setRetryBusy] = useState(false);
  const [retryQueued, setRetryQueued] = useState(false);
  const [retryJobId, setRetryJobId] = useState<string | null>(null);
  const [retryError, setRetryError] = useState("");
  const [selection, setSelection] = useState<{ anchor: CommentAnchor; top: number; left: number } | null>(null);
  const [selectionError, setSelectionError] = useState("");
  const workspaceRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef<HTMLDivElement>(null);
  const articleRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const reviewPanelRef = useRef<HTMLElement>(null);
  const mobileReviewButton = useRef<HTMLButtonElement>(null);
  const draftEditor = useRef<DraftEditorHandle>(null);
  const hasContent = Boolean(article.bodyMarkdown.trim());
  const comments = useArticleComments({ articleId: article.id, version: article.version, title: article.title, bodyMarkdown: article.bodyMarkdown,
    enabled: hasContent && pollingEnabled, live: pollingEnabled && reviewTab === "comments" });
  const generating = retryQueued || article.status === "generating" || (article.status === "draft" && !hasContent);
  const checking = article.status === "qa";
  const inProgress = generating || checking;
  const showProgress = generating || (checking && !hasContent);
  const aiApplying = scoreApplying || rewriteApplying;
  const mutating = aiApplying || reviewBusy || restoring || Boolean(comments.busy);
  const failedEmpty = !retryQueued && article.status === "failed" && !article.bodyMarkdown.trim();
  const editable = canEdit && EDITABLE.includes(article.status) && !checking;
  const decided = DECIDED.includes(article.status);
  const blockers = gates.filter((gate) => gate.verdict === "fail");
  const findings = gates.flatMap((gate) => gate.findings.map((finding) => ({ ...finding, gate: gate.gate })));
  const questions = findings.filter((finding) => finding.severity !== "info");
  const status = STATUS[article.status] ?? article.status.replace(/_/g, " ");
  const wordCount = article.bodyMarkdown.trim() ? article.bodyMarkdown.trim().split(/\s+/).length : 0;
  const review = articleReviewState({ status: article.status, editing: editing || aiApplying || restoring || comments.hasDraft, canEdit, canReview,
    hasContent: Boolean(article.bodyMarkdown.trim()), verdicts: gates.map(gate => gate.verdict) });
  const gateSnapshot = JSON.stringify(gates);
  // In the team review each level belongs to its own people; the server enforces the same rule.
  const teamMayApprove = !teamReview || (teamReview.stage === "content" && teamReview.can.content) || (teamReview.stage === "manager" && teamReview.can.manager);
  const canApproveHere = review.canApprove && teamMayApprove;
  const canRequestChangesHere = review.canRequestChanges && !checking && (!teamReview || teamReview.can.requestChanges);
  const teamExplanation = !teamReview ? null
    : teamReview.stage === "content" ? (teamReview.can.content ? "Content review: check the draft, then approve it for a Manager." : `Content review: waiting for ${waitingFor(teamReview, "content")}.`)
    : teamReview.stage === "manager" ? (teamReview.can.manager ? "Manager approval: give the final approval, or send it back for changes." : `The Content team approved it. Waiting for ${waitingFor(teamReview, "manager")}.`)
    : teamReview.stage === "publish" ? (teamReview.can.publish ? "Approved. Send it to WordPress." : `Approved. Waiting for ${publishers(teamReview)} to send it to WordPress.`)
    : teamReview.stage === "revision" ? "Sent back for changes. The Content team edits the draft, then runs quality checks to start the review again."
    : null;
  const reviewExplanation = comments.hasDraft ? "Post or cancel your comment before changing the article." : mutating ? "Updating this article. Review the result before continuing."
    : teamExplanation && review.explanation !== "Save or discard your edits before reviewing this version." ? teamExplanation : review.explanation;
  const scoreLabel = article.seoScore === null ? "Not checked" : article.seoScore.toLocaleString("en-US", { maximumFractionDigits: 1 });
  const grade = scoreGrade(article.seoScore);
  const commentText = getArticleCommentText(article.title, article.bodyMarkdown);
  const bodySource = getArticleBodySource(article.title, article.bodyMarkdown);
  const commentDisabled = editing || mutating || !hasContent || generating;
  const highlights = comments.draft ? [...comments.highlights, { id: "new-comment", start: comments.draft.anchor.start, end: comments.draft.anchor.end }] : comments.highlights;
  const bodyHighlights = highlights.filter(range => range.end > article.title.length).map(range => ({ ...range, start: Math.max(0, range.start - article.title.length), end: range.end - article.title.length }));
  const activeCommentId = comments.draft ? "new-comment" : comments.activeId;
  // publishedUrl is also set for a WordPress draft, so it is only "live" once the article is published.
  const liveUrl = article.status === "published" && article.publishedUrl && /^https?:\/\//i.test(article.publishedUrl) ? article.publishedUrl : null;
  const draftUrl = !liveUrl && delivery?.status === "succeeded" ? delivery.editUrl ?? delivery.postUrl : null;
  const [coverLead, coverPlace] = splitPlace(article.title);
  const editHint = editable ? comments.hasDraft ? "Post or cancel your comment first." : mutating ? "Wait for the current update to finish." : "Edit the title, SEO details and text"
    : checking ? "Quality checks are running. You can edit when they finish." : decided ? "Request changes to edit this article." : "This article cannot be edited right now.";
  const navActive: View | "comments" = view !== "article" ? view : reviewTab === "comments" ? "comments" : "article";

  useEffect(() => {
    if (commentDisabled || comments.hasDraft) { setSelection(null); return; }
    let timer: ReturnType<typeof setTimeout>;
    const capture = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const result = articleRef.current && readArticleSelection(articleRef.current, commentText, window.getSelection());
        setSelectionError(result && "error" in result ? result.error : "");
        setSelection(result && "anchor" in result ? { anchor: result.anchor, top: Math.max(8, Math.min(window.innerHeight - 50, result.rect.bottom + 6)), left: Math.max(8, Math.min(window.innerWidth - 155, result.rect.right - 140)) } : null);
      }, 120);
    };
    const hide = () => setSelection(null);
    document.addEventListener("selectionchange", capture);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => { clearTimeout(timer); document.removeEventListener("selectionchange", capture); window.removeEventListener("scroll", hide, true); window.removeEventListener("resize", hide); };
  }, [commentDisabled, comments.hasDraft, commentText]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 1000px)");
    const update = () => {
      setIsNarrow(media.matches);
      if (media.matches) setFocusMode(false);
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

  // The open view lives in the address (#seo, #history, #activity), so it survives saves and can be shared.
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (hash === "seo" || hash === "history" || hash === "activity") setView(hash);
  }, []);

  // Top-bar menus close on an outside click or Escape, like any other menu.
  useEffect(() => {
    const close = (event: Event) => {
      const escape = event instanceof KeyboardEvent && event.key === "Escape";
      if (event instanceof KeyboardEvent && !escape) return;
      workspaceRef.current?.querySelectorAll<HTMLDetailsElement>("details[data-menu][open]").forEach((menu) => {
        if (!escape && menu.contains(event.target as Node)) return;
        const hadFocus = menu.contains(document.activeElement);
        menu.open = false;
        if (escape && hadFocus) menu.querySelector("summary")?.focus();
      });
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", close); };
  }, []);

  useEffect(() => {
    if (!pollingEnabled || comments.hasDraft || comments.busy || (!inProgress && (!editable || editing || mutating))) return;
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
  }, [article.id, article.status, article.version, article.seoScore, inProgress, editable, editing, mutating, gateSnapshot, pollingEnabled, retryJobId, router, comments.hasDraft, comments.busy]);

  function goTo(next: View) {
    setView(next);
    try { window.history.replaceState(window.history.state, "", next === "article" ? `${window.location.pathname}${window.location.search}` : `#${next}`); } catch { /* The view still changes. */ }
    contentRef.current?.scrollTo({ top: 0 });
    layoutRef.current?.scrollTo({ top: 0 });
    if (isNarrow) setMobileReviewOpen(false);
  }
  function closeMenu(element: HTMLElement) {
    const menu = element.closest("details");
    if (menu) menu.open = false;
  }
  function edit() {
    if (view !== "article") goTo("article");
    setEditing(true);
    if (!isNarrow) contentRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    requestAnimationFrame(() => {
      const title = workspaceRef.current?.querySelector<HTMLInputElement>("#draft-title");
      title?.focus({ preventScroll: true }); title?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }
  function showPreview() {
    if (view !== "article") goTo("article");
    if (!editing || (hasUnsavedChanges && !window.confirm("Discard your unsaved edits?"))) return;
    setEditing(false); setHasUnsavedChanges(false);
  }
  function mayLeave() { return !(hasUnsavedChanges || comments.hasDraft || comments.busy) || window.confirm("Leave this article and discard any unsaved edits or comments?"); }
  function leaveGuard(event: MouseEvent<HTMLAnchorElement>) { if (!mayLeave()) event.preventDefault(); }
  function openReview(tab: Tab = reviewTab) {
    setReviewTab(tab); setMobileReviewOpen(true); setFocusMode(false);
    if (isNarrow) requestAnimationFrame(() => {
      const commentControl = tab === "comments" ? reviewPanelRef.current?.querySelector<HTMLElement>('#review-content-comments textarea, #review-content-comments article[data-active="true"]') : null;
      (commentControl ?? reviewPanelRef.current?.querySelector<HTMLElement>("button"))?.focus();
    });
  }
  function closeReview() {
    setMobileReviewOpen(false);
    requestAnimationFrame(() => mobileReviewButton.current?.focus());
  }
  function beginComment(anchor: CommentAnchor) {
    comments.begin(anchor); setSelection(null); openReview("comments");
  }
  function openComment(id: string) {
    if (window.getSelection()?.toString()) return;
    if (id !== "new-comment") comments.select(id);
    openReview("comments");
  }
  function locateComment(id: string): boolean {
    if (isNarrow) setMobileReviewOpen(false);
    if (view !== "article") goTo("article");
    if (editing) {
      // The saved text is replaced by the editor, which may hold unsaved changes: find the passage there.
      const comment = comments.comments.find(item => item.id === id);
      return Boolean(comment && draftEditor.current?.reveal(comment.anchor));
    }
    requestAnimationFrame(() => {
      const mark = [...(articleRef.current?.querySelectorAll<HTMLElement>("[data-comment-ids]") ?? [])].find(element => element.dataset.commentIds?.split(" ").includes(id));
      mark?.scrollIntoView({ block: "center", behavior: "smooth" });
      mark?.focus({ preventScroll: true });
    });
    return true;
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
  async function share() {
    const url = `${window.location.origin}/articles/${article.id}`;
    try {
      await navigator.clipboard.writeText(url);
      setShareState("copied");
      setTimeout(() => setShareState("idle"), 2500);
    } catch { window.prompt("Copy this link to share the article with your team:", url); }
  }
  async function copyText() {
    try {
      await navigator.clipboard.writeText(`# ${article.title}\n\n${article.bodyMarkdown}`);
      setTextCopied(true);
      setTimeout(() => setTextCopied(false), 2500);
    } catch { exportArticle("txt"); }
  }

  const navItems: { id: View | "comments"; label: string; icon: ReactNode; badge?: number; onClick: () => void }[] = [
    { id: "article", label: "Article", icon: <IconPencil size={18} />, onClick: () => { goTo("article"); if (reviewTab === "comments") setReviewTab("checks"); } },
    { id: "seo", label: "SEO & Optimization", icon: <IconBars size={18} />, onClick: () => goTo("seo") },
    { id: "comments", label: "Comments", icon: <IconComment size={18} />, badge: comments.openCount, onClick: () => { goTo("article"); openReview("comments"); } },
    { id: "history", label: "Version History", icon: <IconHistory size={18} />, onClick: () => goTo("history") },
    { id: "activity", label: "Activity Log", icon: <IconPulse size={18} />, onClick: () => goTo("activity") },
  ];

  return <div className={styles.workspace} ref={workspaceRef} role="dialog" aria-modal="true" aria-label="Blog article workspace" tabIndex={-1}
    onKeyDown={(event) => {
      if ((event.ctrlKey || event.metaKey) && event.altKey && event.key.toLowerCase() === "m" && !commentDisabled && !comments.hasDraft) {
        const result = articleRef.current && readArticleSelection(articleRef.current, commentText, window.getSelection());
        if (result && "anchor" in result) { event.preventDefault(); beginComment(result.anchor); }
        return;
      }
      if (event.key === "Escape" && isNarrow && mobileReviewOpen) { event.preventDefault(); closeReview(); return; }
      if (event.key !== "Tab") return;
      const scope = isNarrow && mobileReviewOpen ? reviewPanelRef.current : workspaceRef.current;
      const controls = [...(scope?.querySelectorAll<HTMLElement>("a[href],button:not([disabled]):not([tabindex='-1']),summary,input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex='0'],[contenteditable='true']") ?? [])]
        .filter(control => control.getClientRects().length > 0 && !control.closest("[inert]"));
      const first = controls[0], last = controls.at(-1);
      if (!scope?.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first)?.focus(); }
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === workspaceRef.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
    <header className={styles.topbar} inert={isNarrow && mobileReviewOpen}>
      {/* The GrowPilot brand opens the app's sections, so this full-screen page is never a dead end. */}
      <details className={`${styles.menu} ${styles.appMenu}`} data-menu>
        <summary className={styles.brand} title="GrowPilot menu">
          <Logo size={30} /><span className={styles.brandName}>GrowPilot</span><IconChevronDown size={15} />
        </summary>
        <nav className={`${styles.popover} ${styles.appPopover}`} aria-label="GrowPilot">
          {teamRole && <p className={styles.popoverNote}>Your role: {teamRole}</p>}
          <p className={styles.popoverNote}>Go to</p>
          {(blogOnly ? APP_NAV.filter((item) => item.href === "/articles") : APP_NAV).map((item) => <Link key={item.href} href={item.href} aria-current={item.href === "/articles" ? "true" : undefined}
            onClick={(event) => { if (!mayLeave()) { event.preventDefault(); return; } closeMenu(event.currentTarget); }}>{item.icon}{item.label}</Link>)}
        </nav>
      </details>
      <nav className={styles.crumbs} aria-label="Breadcrumb">
        <Link className={styles.crumbLink} href="/articles" onClick={leaveGuard}><IconArrowLeft size={16} /><span className={styles.crumbText}>Blog Automation</span></Link>
        <span className={styles.crumbSep} aria-hidden="true"><IconChevronRight size={15} /></span>
        <span className={styles.crumbCurrent} aria-current="page" title={article.title}>{article.title}</span>
      </nav>
      <div className={styles.topActions}>
        <span className={styles.statusPill} data-status={article.status}>{decided && <IconTick size={14} />}{status}</span>
        {hasContent && !generating && <>
          <details className={`${styles.menu} ${styles.versionMenu}`} data-menu>
            <summary className={styles.button}>Version {article.version} <IconChevronDown /></summary>
            <div className={styles.popover}>
              <p className={styles.popoverNote}>You are viewing <strong>version {article.version}</strong>, the latest saved version.</p>
              <button type="button" onClick={(event) => { closeMenu(event.currentTarget); goTo("history"); }}><IconHistory size={16} /> See all versions</button>
            </div>
          </details>
          <button type="button" className={`${styles.button} ${styles.shareButton}`} onClick={() => void share()} title="Copy a link to this article. Only people in your workspace can open it.">
            <IconShare size={16} /><span aria-live="polite">{shareState === "copied" ? "Link copied" : "Share"}</span>
          </button>
          <details className={`${styles.menu} ${styles.exportMenu}`} data-menu>
            <summary className={styles.button}>Export <IconChevronDown /></summary>
            <div className={styles.popover}>
              <p className={styles.popoverNote}>Download version {article.version}</p>
              <button type="button" onClick={(event) => { closeMenu(event.currentTarget); exportArticle("md"); }}><IconDownload size={16} /> Markdown (.md)</button>
              <button type="button" onClick={(event) => { closeMenu(event.currentTarget); exportArticle("txt"); }}><IconDownload size={16} /> Text file (.txt)</button>
            </div>
          </details>
          <details className={styles.menu} data-menu>
            <summary className={`${styles.button} ${styles.iconButton}`} aria-label="More options" title="More options"><IconMore /></summary>
            <div className={styles.popover}>
              {!isNarrow && <button type="button" onClick={(event) => { closeMenu(event.currentTarget); setFocusMode((on) => !on); }}>
                {focusMode ? <IconCollapse size={16} /> : <IconExpand size={16} />} {focusMode ? "Exit focus mode" : "Focus mode"}</button>}
              <button type="button" onClick={() => void copyText()}><IconCopy size={16} /> <span aria-live="polite">{textCopied ? "Copied to clipboard" : "Copy article text"}</span></button>
              <button type="button" className={styles.smallScreenOnly} onClick={(event) => { closeMenu(event.currentTarget); exportArticle("md"); }}><IconDownload size={16} /> Download Markdown</button>
              {liveUrl && <a href={liveUrl} target="_blank" rel="noopener noreferrer" onClick={(event) => closeMenu(event.currentTarget)}><IconExternal size={16} /> View live article</a>}
              {draftUrl && <a href={draftUrl} target="_blank" rel="noopener noreferrer" onClick={(event) => closeMenu(event.currentTarget)}><IconExternal size={16} /> Open draft in WordPress</a>}
              <p className={styles.popoverHint}>Tip: select text and press Ctrl+Alt+M to comment.</p>
            </div>
          </details>
        </>}
      </div>
    </header>

    {showProgress || failedEmpty ? <div className={styles.progress} role="status" aria-live="polite">
      <span className={styles.spark}><IconSparkles size={28} /></span>
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
        <span>SEO <strong>{scoreLabel}</strong>{questions.length ? ` · ${questions.length} ${questions.length === 1 ? "item" : "items"} to review` : ""}</span>
        <button type="button" ref={mobileReviewButton} className={styles.button} aria-expanded={mobileReviewOpen} aria-controls="article-review-panel" onClick={() => openReview()}>Review &amp; Improve</button>
      </div>
      <div className={styles.layout} ref={layoutRef} data-focus={focusMode || undefined}>
        <nav className={styles.sideNav} aria-label="Article workspace" inert={isNarrow && mobileReviewOpen}>
          <Link className={styles.navBack} href="/articles" onClick={leaveGuard} title="All Blogs"><IconArrowLeft size={17} /><span className={styles.navLabel}>All Blogs</span></Link>
          <ul className={styles.navList}>
            {navItems.map((item) => <li key={item.id}>
              <button type="button" className={styles.navItem} aria-current={navActive === item.id ? "page" : undefined} title={item.label} onClick={item.onClick}>
                {item.icon}<span className={styles.navLabel}>{item.label}</span>
                {item.badge ? <span className={styles.navBadge}><span className={styles.srOnly}>, </span>{item.badge}<span className={styles.srOnly}> open</span></span> : null}
              </button>
            </li>)}
          </ul>
          <div className={styles.helpCard}>
            <span className={styles.helpIcon}><IconSupport /></span>
            <strong>Need help?</strong>
            <p>Get writing, SEO, or publishing support.</p>
            <details className={styles.guide}>
              <summary>View Guide <IconChevronDown size={14} /></summary>
              <ol>{GUIDE.map((step) => <li key={step}>{step}</li>)}</ol>
              <a href="mailto:support@kleza.io?subject=GrowPilot%20article%20help">Email support <IconExternal size={13} /></a>
            </details>
          </div>
        </nav>

        <div className={styles.main} inert={isNarrow && mobileReviewOpen}>
          <div className={styles.canvas}>
            <div className={styles.toolbar}>
              {view === "article" ? <div className={styles.modeTabs} role="group" aria-label="Article mode">
                <button type="button" aria-pressed={!editing} onClick={showPreview}><IconEye /><span><span className={styles.collapsible}>Article </span>Preview</span></button>
                {canEdit && <button type="button" aria-pressed={editing} disabled={!editing && (!editable || mutating || comments.hasDraft)} title={editing ? "Editing this draft" : editHint}
                  onClick={() => { if (!editing) edit(); }}><IconPencil /><span>Edit</span></button>}
                <button type="button" onClick={() => openReview("ai")} title="Open AI help in the review panel"><IconSparkles /><span>AI Help</span></button>
              </div> : <button type="button" className={styles.backToArticle} onClick={() => goTo("article")}><IconArrowLeft size={16} /> Back to article</button>}
              <div className={styles.toolbarActions}>
                {checking && <span className={styles.checkingLabel}>{workerOnline === false ? "Quality checks queued" : <LoadingIndicator label="Checking quality…" />}</span>}
                <button type="button" className={styles.button} onClick={() => openReview("comments")} title="Select text to add a comment (Ctrl+Alt+M)">
                  <IconComment size={17} /><span className={styles.collapsible}>Comments</span>{comments.openCount > 0 ? ` (${comments.openCount})` : ""}
                </button>
                {!isNarrow && <button type="button" className={`${styles.button} ${styles.iconButton} ${styles.focusButton}`} aria-pressed={focusMode} aria-label={focusMode ? "Exit focus mode" : "Focus mode"}
                  title={focusMode ? "Exit focus mode" : "Focus mode: hide the side panels"} onClick={() => setFocusMode((on) => !on)}>{focusMode ? <IconCollapse /> : <IconExpand />}</button>}
              </div>
            </div>
            <div className={styles.scroll} ref={contentRef}>
              <article className={styles.document} ref={articleRef} hidden={view !== "article"}>
                <div className={styles.documentHeading}>
                  <span className={styles.eyebrow}>BLOG ARTICLE</span>
                  <h1 data-comment-text="title"><CommentHighlightedText text={article.title} highlights={editing ? [] : highlights} activeCommentId={activeCommentId} onHighlightClick={openComment} /></h1>
                  <div className={styles.documentMeta}>
                    <span><IconLayers /> Version {article.version}</span>
                    <span><IconFile /> {wordCount.toLocaleString()} words</span>
                    <span><IconCalendarSmall /> Created {new Date(article.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}</span>
                  </div>
                  {(keyword || secondaryKeywords.length > 0) && <ul className={styles.chips} aria-label="Target keywords">
                    {keyword && <li className={styles.chipPrimary} title="Target keyword">{keyword.term}</li>}
                    {keyword?.intent && <li className={styles.chip}>{keyword.intent} intent</li>}
                    {secondaryKeywords.slice(0, 1).map((term) => <li key={term} className={styles.chipMuted}>{term}</li>)}
                  </ul>}
                </div>
                {!editing && hasContent && <div className={styles.cover} aria-hidden="true">
                  <p className={styles.coverTitle}>{coverLead}{coverPlace && <em>{coverPlace}</em>}</p>
                  <div className={styles.coverArt}>
                    <span className={styles.coverSheet}><i /><i /><i /><i /><i /></span>
                    <span className={styles.coverBadge}><IconSparkles size={14} /> {Math.max(1, Math.round(wordCount / 220))} min read</span>
                  </div>
                </div>}
                {checking && <p className={styles.jobBanner} role="status">{workerOnline === false ? "Quality checks are waiting for background processing to reconnect." : "Quality checks are running. You can keep reading while the results are prepared."}</p>}
                {pollError && <p className={styles.jobBanner} role="status">{pollError}</p>}
                {selectionError && <p className={styles.jobBanner} role="status">{selectionError}</p>}
                <div className={styles.proseArea}>{editing ? <DraftEditor key={`${article.id}:${article.version}`} article={article} canEdit={canEdit} initialMode="edit" revealRef={draftEditor}
                  onDirtyChange={setHasUnsavedChanges} onDone={(saved) => { if (!saved) setEditing(false); setHasUnsavedChanges(false); }} />
                  : <div data-comment-text={getArticleBodyText(bodySource) ? "body" : undefined}><ArticleMarkdown source={bodySource} highlights={bodyHighlights} activeCommentId={activeCommentId} onHighlightClick={openComment} /></div>}</div>
              </article>
              {view === "seo" && <SeoView article={article} keyword={keyword} keywordUse={keywordUse} secondaryKeywords={secondaryKeywords} breakdown={scoreBreakdown}
                editable={editable && !mutating && !comments.hasDraft} onEdit={edit} onImprove={() => { setAiMode("score"); openReview("ai"); }} />}
              {(view === "history" || restoring) && <div hidden={view !== "history"}>
                <ArticleHistory articleId={article.id} version={article.version} canRestore={editable && !editing && !mutating && !comments.hasDraft} onRestoringChange={setRestoring} />
              </div>}
              {view === "activity" && <ActivityView entries={activity} limit={activityLimit} />}
            </div>
          </div>
        </div>

        {mobileReviewOpen && <button type="button" className={styles.reviewBackdrop} aria-label="Close review tools" tabIndex={-1} onClick={closeReview} />}
        <aside id="article-review-panel" ref={reviewPanelRef} className={`${styles.reviewPanel} ${mobileReviewOpen ? styles.reviewOpen : ""}`}
          role={isNarrow ? "dialog" : undefined} aria-modal={isNarrow && mobileReviewOpen ? true : undefined} aria-labelledby="article-review-tools-title">
          <div className={styles.panelHead}>
            <span className={styles.panelMark}><IconSparkles size={24} /></span>
            <div className={styles.panelTitle}><h2 id="article-review-tools-title">Review &amp; Improve</h2><p>Everything you need for the next step.</p></div>
            <button type="button" className={styles.closeReview} aria-label="Close review tools" onClick={closeReview}><IconClose /></button>
          </div>
          <div className={styles.panelTabs} role="tablist" aria-label="Article review tools">
            {TABS.map(([tab, label, icon]) => <button key={tab} id={`review-tab-${tab}`} type="button" role="tab"
              aria-selected={reviewTab === tab} aria-controls={`review-content-${tab}`} tabIndex={reviewTab === tab ? 0 : -1} data-review-tab={tab}
              onClick={() => setReviewTab(tab)} onKeyDown={(event) => {
                const index = TAB_ORDER.indexOf(tab);
                const next = event.key === "ArrowRight" ? (index + 1) % TAB_ORDER.length : event.key === "ArrowLeft" ? (index + TAB_ORDER.length - 1) % TAB_ORDER.length : event.key === "Home" ? 0 : event.key === "End" ? TAB_ORDER.length - 1 : -1;
                if (next < 0) return; event.preventDefault(); const nextTab = TAB_ORDER[next]!; setReviewTab(nextTab);
                event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-review-tab="${nextTab}"]`)?.focus();
              }}>{icon}<span>{label}</span>
              {tab === "comments" && comments.openCount > 0 && <span className={styles.tabCount}>({comments.openCount})</span>}
              {tab === "checks" && blockers.length > 0 && <span className={styles.tabAlert} aria-label={`${blockers.length} failing`}>{blockers.length}</span>}
            </button>)}
          </div>
          <div className={styles.sideScroll}>
            <section id="review-content-checks" role="tabpanel" aria-labelledby="review-tab-checks" hidden={reviewTab !== "checks"}>
              <div className={styles.scoreCard}>
                <div className={styles.scoreGauge}>
                  <span className={styles.scoreLabel}>SEO SCORE <span className={styles.infoTip} title={`Measured by the quality checks for version ${article.version}.`}><IconInfo size={15} /></span></span>
                  <ScoreArc score={article.seoScore} width={140} />
                </div>
                <div className={styles.scoreVerdict}>
                  <span className={styles.grade} data-tone={grade.tone}><IconShield size={15} /> {grade.label}</span>
                  <p>{grade.text}</p>
                  {scoreBreakdown.length > 0 && <button type="button" className={styles.textButton} onClick={() => goTo("seo")}>See the breakdown <IconChevronRight size={14} /></button>}
                </div>
              </div>
              {(editable || article.status === "failed") && <div className={styles.nextStep}>
                <div><strong>{article.status === "failed" ? "Draft recovery" : "Improve with AI"}</strong>
                  <p>{article.status === "failed" ? "Retry writing to continue with this draft." : "Get suggested fixes for the findings below, and review every change before it is saved."}</p></div>
                {editable && !editing && <button type="button" className={styles.aiAction} disabled={mutating || comments.hasDraft} onClick={() => { setAiMode("score"); setReviewTab("ai"); }}><IconSparkles size={16} /> Improve article</button>}
                {article.status === "failed" && canEdit && <button type="button" className={styles.button} disabled={retryBusy} onClick={() => void retryGeneration()}>{retryBusy ? <LoadingIndicator label="Queueing…" /> : "Retry generation"}</button>}
                {retryError && <p className={styles.actionError} role="alert">{retryError}</p>}
              </div>}
              <div className={styles.sectionLabel}><h3>Quality Checks</h3><span>{gates.length ? `${gates.length} checks` : "Not run yet"}</span></div>
              {gates.length ? <div className={styles.gateList}>{gates.map((gate) => {
                const info = gateInfo(gate.gate);
                return <details key={gate.gate} className={styles.gate} open={gate.verdict === "fail"}>
                  <summary>
                    <span className={styles.gateDot} data-verdict={gate.verdict} />
                    <strong>{info.label}</strong>
                    <span className={styles.gateVerdict} data-verdict={gate.verdict}>{gate.verdict === "fail" ? "Needs work" : gate.verdict === "warn" ? "Review" : "Passed"}</span>
                    <span className={styles.gateChevron} aria-hidden="true"><IconChevronRight size={16} /></span>
                  </summary>
                  <div className={styles.gateFindings}>
                    {info.help && <p className={styles.gateHelp}>{info.help}</p>}
                    {gate.findings.length ? gate.findings.map((finding, index) => <div key={index} data-severity={finding.severity}><p>{finding.message}</p>{finding.suggestion && <span>{finding.suggestion}</span>}</div>)
                      : <p>{gate.verdict === "fail" ? "Review this draft and run quality checks again." : "No issues were reported for this check."}</p>}
                  </div>
                </details>;
              })}</div> : <p className={styles.muted}>Run quality checks to review factual accuracy, SEO, and publishing requirements.</p>}
            </section>
            <section id="review-content-ai" role="tabpanel" aria-labelledby="review-tab-ai" hidden={reviewTab !== "ai"}>
              <div className={styles.aiModes} aria-label="AI assistance type" hidden={!editable}><button type="button" aria-pressed={aiMode === "score"} onClick={() => setAiMode("score")}>Improve article</button><button type="button" aria-pressed={aiMode === "rewrite"} onClick={() => setAiMode("rewrite")}>Rewrite a section</button></div>
              {!editable && <div className={styles.lockedNote}>
                <strong>{decided ? `This article is ${article.status === "published" ? "published" : "approved"}, so it is locked` : checking ? "Quality checks are running" : "Editing is not available"}</strong>
                <p>{decided ? "Locking keeps what gets published exactly the same as what was reviewed."
                  : checking ? "AI Help opens again as soon as the checks finish."
                  : !canEdit ? "Only editors and admins can change this article." : "This article cannot be changed right now."}</p>
                {decided && canReview && <ol>
                  <li>Click <b>Request Changes</b> below. The article becomes editable again.</li>
                  <li>Use AI Help or Edit to make your changes.</li>
                  <li>Run quality checks and approve it again before publishing.</li>
                </ol>}
              </div>}
              {editable && <>
                {editing && <p className={styles.jobBanner}>Save or discard your edits before asking AI to change the saved draft.</p>}
                {comments.hasDraft && <p className={styles.jobBanner}>Post or cancel your comment before changing the article.</p>}
                <div hidden={aiMode !== "score"}><fieldset className={styles.aiFieldset} disabled={editing || rewriteApplying || checking || reviewBusy || restoring || comments.hasDraft || Boolean(comments.busy)}>
                  <ArticleScoreImprovements articleId={article.id} version={article.version} article={{ title: article.title, metaTitle: article.metaTitle, metaDescription: article.metaDescription }} onApplyingChange={setScoreApplying} />
                </fieldset></div>
                <div hidden={aiMode !== "rewrite"} className={styles.rewritePanel}><BlogCompanion articleId={article.id} version={article.version} sections={sections} canEdit={canEdit} editable={editable && !editing && !scoreApplying && !reviewBusy && !restoring && !comments.hasDraft && !comments.busy} embedded onApplyingChange={setRewriteApplying} /></div>
              </>}
            </section>
            <section id="review-content-comments" role="tabpanel" aria-labelledby="review-tab-comments" hidden={reviewTab !== "comments"}>
              <ArticleCommentsPanel controller={comments} visible={reviewTab === "comments" && (!isNarrow || mobileReviewOpen)} disabled={editing || aiApplying || restoring} locateDisabled={aiApplying || restoring} editing={editing} onLocate={locateComment} />
            </section>
            <section id="review-content-details" role="tabpanel" aria-labelledby="review-tab-details" hidden={reviewTab !== "details"}>
              <div className={styles.sectionLabel}><h3>Publishing Details</h3>{editable && <button type="button" className={styles.textButton} disabled={editing || mutating || comments.hasDraft} onClick={() => { if (isNarrow) closeReview(); edit(); }}>Edit</button>}</div>
              <dl className={styles.detailsList}><dt>URL slug</dt><dd>/{article.slug}</dd><dt>SEO title</dt><dd>{article.metaTitle || "Not set"}</dd><dt>Meta description</dt><dd>{article.metaDescription || "Not set"}</dd><dt>Destination</dt><dd>{publishTarget ? `Connected ${publishTarget === "wordpress" ? "WordPress" : publishTarget} site` : <Link href="/integrations" onClick={leaveGuard}>Connect a publishing site</Link>}</dd>
                {liveUrl && <><dt>Published article</dt><dd><a href={liveUrl} target="_blank" rel="noopener noreferrer">View live article ↗</a></dd></>}
                {draftUrl && <><dt>WordPress draft</dt><dd><a href={draftUrl} target="_blank" rel="noopener noreferrer">Open in WordPress ↗</a>{delivery?.version ? ` (version ${delivery.version})` : ""}</dd></>}
              </dl>
              <details className={styles.sourceDetails}><summary>Sources used <span>{sources.length}</span></summary>{sources.length ? <ul>{sources.map(source => <li key={source.url}><a href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a></li>)}</ul> : <p className={styles.muted}>No source links are included in this draft.</p>}</details>
              <button type="button" className={styles.linkRow} onClick={() => goTo("history")}><IconHistory size={17} /> Version history <span>v{article.version}</span><IconChevronRight size={15} /></button>
              <button type="button" className={styles.linkRow} onClick={() => goTo("activity")}><IconPulse size={17} /> Activity log <span>{activity.length}</span><IconChevronRight size={15} /></button>
            </section>
          </div>
          <div className={styles.reviewDecision}>
            <p id="article-review-help" className={decided && !teamExplanation ? styles.srOnly : styles.reviewHint}>{reviewExplanation}</p>
            {canReview ? <ApprovalActions articleId={article.id} version={article.version} articleStatus={article.status}
              canApprove={canApproveHere} canRequestChanges={canRequestChangesHere} team={teamReview}
              canPublish={!editing && !aiApplying && !restoring && !comments.hasDraft && !comments.busy && canPublish && article.status === "approved" && Boolean(publishTarget)}
              canRunQa={review.canRunQa} approveDisabledReason={reviewExplanation} requestChangesDisabledReason={review.rejectReason}
              reviewHelpId="article-review-help" publishTarget={publishTarget} published={article.status === "published"} delivery={delivery} onBusyChange={setReviewBusy} compact />
              : <span className={styles.muted}>An editor or administrator can review this article.</span>}
          </div>
        </aside>
      </div>
    </>}
    {selection && !commentDisabled && !comments.hasDraft && <button type="button" className={styles.selectionComment} style={{ top: selection.top, left: selection.left }}
      onMouseDown={event => event.preventDefault()} onClick={() => beginComment(selection.anchor)}>＋ Add comment</button>}
  </div>;
}
