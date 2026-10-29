"use client";

import { useState } from "react";
import Link from "next/link";
import { IconArticles, IconArrow, IconKeywords } from "./Icons";
import { BlogHeaderActions } from "./BlogHeaderActions";
import type { BlogPrompts } from "./BlogPromptSettings";
import styles from "./BlogQueue.module.css";

type QueueArticle = {
  id: string; title: string; status: string; version: number;
  seoScore: number | null; voiceScore: number | null; wordCount: number; updatedAt: Date | string;
};
type QueueFilter = "all" | "attention" | "progress" | "review" | "approved" | "scheduled" | "published";
interface BlogQueueProps {
  articles: QueueArticle[]; allArticles: QueueArticle[]; activeStatus: string;
  businessId: string | null; businessName: string; canEdit: boolean; blockedReason: string | null;
  prompts: BlogPrompts; connected: boolean;
}
const FILTERS: { id: QueueFilter; label: string }[] = [
  { id: "all", label: "All articles" }, { id: "attention", label: "Needs attention" },
  { id: "progress", label: "In progress" }, { id: "review", label: "Ready to review" },
];
const MORE_FILTERS: { id: QueueFilter; label: string }[] = [
  { id: "approved", label: "Approved" }, { id: "scheduled", label: "Scheduled" }, { id: "published", label: "Published" },
];
const STATUS_LABELS: Record<string, string> = {
  draft: "Draft", generating: "Writing", qa: "Checking quality", awaiting_approval: "Ready to review",
  needs_changes: "Needs changes", failed: "Needs attention", approved: "Approved", scheduled: "Scheduled", published: "Published",
};
function matchesFilter(status: string, filter: QueueFilter) {
  if (filter === "all") return true;
  if (filter === "attention") return status === "failed" || status === "needs_changes";
  if (filter === "progress") return ["draft", "generating", "qa"].includes(status);
  return status === (filter === "review" ? "awaiting_approval" : filter);
}
function initialFilter(status: string): QueueFilter {
  if (status === "failed" || status === "needs_changes") return "attention";
  if (["draft", "generating", "qa"].includes(status)) return "progress";
  if (status === "awaiting_approval") return "review";
  return ["approved", "scheduled", "published"].includes(status) ? status as QueueFilter : "all";
}
function nextAction(status: string, canEdit: boolean) {
  if (status === "generating" || status === "qa") return "View progress";
  if (!canEdit) return "View article";
  if (status === "awaiting_approval") return "Review article";
  if (status === "needs_changes") return "Improve draft";
  if (status === "failed") return "Resolve issue";
  if (status === "draft") return "Open draft";
  return "Open article";
}

/** Server-scoped articles are searched and grouped locally without extra requests. */
export function BlogQueue(props: BlogQueueProps) {
  return <QueueWorkspace key={`${props.businessId ?? "no-business"}:${props.activeStatus}`} {...props} />;
}

function QueueWorkspace({ articles, allArticles, activeStatus, businessId, businessName, canEdit, blockedReason, prompts, connected }: BlogQueueProps) {
  const [filter, setFilter] = useState<QueueFilter>(initialFilter(activeStatus));
  const [query, setQuery] = useState("");
  const source = allArticles.length ? allArticles : articles;
  const search = query.trim().toLocaleLowerCase();
  const visible = source.filter(article => matchesFilter(article.status, filter) && (!search || article.title.toLocaleLowerCase().includes(search)));
  const filtered = filter !== "all" || Boolean(search);
  const count = (value: QueueFilter) => source.filter(article => matchesFilter(article.status, value)).length;
  const reset = () => { setFilter("all"); setQuery(""); };

  return <div className={styles.workspace}>
    <BlogHeaderActions businessId={businessId} businessName={businessName} canEdit={canEdit} blockedReason={blockedReason} prompts={prompts} />
    <section className={styles.frame} aria-label="Article library">
      <div className={styles.listToolbar}>
        <div className={styles.filters} role="group" aria-label="Filter articles">
          {FILTERS.map(item => <button key={item.id} type="button" aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>
            {item.label}<span>{count(item.id)}</span>
          </button>)}
        </div>
        <div className={styles.listTools}>
          <select className={styles.moreFilters} aria-label="More article statuses" value={MORE_FILTERS.some(item => item.id === filter) ? filter : ""}
            data-active={MORE_FILTERS.some(item => item.id === filter)} onChange={event => { if (event.target.value) setFilter(event.target.value as QueueFilter); }}>
            <option value="" disabled>More statuses</option>
            {MORE_FILTERS.map(item => <option key={item.id} value={item.id}>{item.label} ({count(item.id)})</option>)}
          </select>
          <label className={styles.search}><IconKeywords size={16} /><input type="search" aria-label="Search article titles" placeholder="Search articles" value={query} onChange={event => setQuery(event.target.value)} /></label>
        </div>
      </div>
      <div className={styles.listContext}>
        <span role="status">{visible.length} {visible.length === 1 ? "article" : "articles"}{filtered ? ` of ${source.length}` : ""}</span>
        {filtered && <button type="button" className={styles.textButton} onClick={reset}>Clear filters</button>}
        <span className={styles.sortNote}>Recently updated</span>
      </div>
      {visible.length ? <div className={styles.tableWrap}><table className={styles.table}>
        <thead><tr><th scope="col">Article</th><th scope="col">Status</th><th scope="col">SEO score</th><th scope="col">Updated</th><th scope="col"><span className={styles.srOnly}>Next action</span></th></tr></thead>
        <tbody>{visible.map(article => {
          const updated = article.updatedAt instanceof Date ? article.updatedAt : new Date(article.updatedAt);
          const validDate = Number.isFinite(updated.getTime());
          const updatedLabel = validDate ? updated.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "Asia/Kolkata" }) : "—";
          return <tr key={article.id}>
            <td className={styles.titleCell}><Link className={styles.articleTitle} href={`/articles/${article.id}`}>{article.title}</Link>
              <span className={styles.articleMeta}>v{article.version}{article.wordCount > 0 ? ` · ${article.wordCount.toLocaleString()} words` : ""}<span className={styles.inlineUpdated}> · Updated {updatedLabel}</span></span></td>
            <td className={styles.statusCell}><span className={styles.status} data-status={article.status}>{STATUS_LABELS[article.status] ?? article.status.replace(/_/g, " ")}</span></td>
            <td className={styles.scoreCell}>{article.seoScore === null ? <span className={styles.unchecked}>Not checked</span>
              : <span className={styles.score}>{article.seoScore.toLocaleString("en-US", { maximumFractionDigits: 1 })}<span className={styles.scoreMax}> / 100</span></span>}</td>
            <td className={styles.updatedCell}><time dateTime={validDate ? updated.toISOString() : undefined}>{updatedLabel}</time></td>
            <td className={styles.actionCell}><Link className={`${styles.openArticle} ${article.status === "awaiting_approval" && canEdit ? styles.reviewAction : ""}`} href={`/articles/${article.id}`}>
              {nextAction(article.status, canEdit)}<IconArrow size={15} />
            </Link></td>
          </tr>;
        })}</tbody>
      </table></div> : <div className={styles.empty}>
        <span className={styles.emptyIcon}><IconArticles size={25} /></span>
        <h2>{search ? "No articles match your search" : filtered ? "Nothing in this stage" : "Create your first blog"}</h2>
        <p>{search ? "Try a different title or clear the filters to see your other articles."
          : filtered ? "Choose another stage to find the article you want to work on."
            : canEdit ? "Use Create blog to choose a topic, review its brief, and write your first draft."
              : "Articles will appear here when an editor creates a draft."}</p>
        {filtered && <button type="button" className={styles.button} onClick={reset}>Show all articles</button>}
      </div>}
      <footer className={styles.queueFooter}><span><i className={styles.connectionDot} data-connected={connected} aria-hidden />{connected ? "WordPress connected" : "WordPress not connected"}</span><span>{businessName || "Your workspace"}</span></footer>
    </section>
  </div>;
}
