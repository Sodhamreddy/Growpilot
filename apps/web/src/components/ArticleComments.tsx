"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { findCommentAnchor, getArticleBlockStarts, getArticleCommentText, type CommentAnchor } from "@/lib/article-comment-text";
import { LoadingIndicator } from "./LoadingIndicator";
import styles from "./ArticleComments.module.css";

export interface ArticleComment {
  id: string;
  authorName: string;
  articleVersion: number;
  anchor: CommentAnchor;
  body: string;
  resolvedAt: string | null;
  createdAt: string;
  canResolve: boolean;
  replies: { id: string; authorName: string; body: string; createdAt: string }[];
}

export function useArticleComments({ articleId, version, title, bodyMarkdown, enabled, live = true }: {
  articleId: string; version: number; title: string; bodyMarkdown: string; enabled: boolean; live?: boolean;
}) {
  const [comments, setComments] = useState<ArticleComment[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [filter, setFilter] = useState<"open" | "resolved">("open");
  const [draft, setDraft] = useState<{ anchor: CommentAnchor; version: number } | null>(null);
  const [body, setBody] = useState("");
  const [replyId, setReplyId] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState("");
  const sequence = useRef(0);
  const writing = useRef(false);
  const alive = useRef(true);
  const text = useMemo(() => getArticleCommentText(title, bodyMarkdown), [title, bodyMarkdown]);
  const blockStarts = useMemo(() => getArticleBlockStarts(title, bodyMarkdown), [title, bodyMarkdown]);
  const located = useMemo(() => comments.map(comment => ({ ...comment, range: comment.articleVersion === version && text.slice(comment.anchor.start, comment.anchor.end) === comment.anchor.quote
    ? { start: comment.anchor.start, end: comment.anchor.end } : findCommentAnchor(text, comment.anchor) })), [comments, text, version]);
  const highlights = useMemo(() => located.filter(comment => comment.range && (!comment.resolvedAt || comment.id === activeId))
    .map(comment => ({ id: comment.id, ...comment.range! })), [located, activeId]);
  const hasDraft = draft !== null || replyBody.trim().length > 0;
  const openCount = comments.filter(comment => !comment.resolvedAt).length;

  useEffect(() => { alive.current = true; return () => { alive.current = false; sequence.current++; }; }, []);
  useEffect(() => {
    if (!hasDraft) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hasDraft]);

  const refresh = useCallback(async (signal?: AbortSignal, quiet = false) => {
    if (!enabled || writing.current) return;
    const request = ++sequence.current;
    if (!quiet) setLoading(true);
    try {
      const response = await fetch(`/api/articles/${articleId}/comments`, { signal, cache: "no-store" });
      const data = await response.json() as { comments?: ArticleComment[]; error?: { message?: string } };
      if (!response.ok) throw new Error(data.error?.message || "Could not load comments.");
      if (!signal?.aborted && alive.current && request === sequence.current) {
        setComments(data.comments ?? []); setLoaded(true); setLoadError("");
      }
    } catch (cause) {
      if (!signal?.aborted && alive.current && request === sequence.current) setLoadError(cause instanceof Error ? cause.message : "Could not load comments.");
    } finally {
      if (alive.current && request === sequence.current) setLoading(false);
    }
  }, [articleId, enabled]);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void refresh(controller.signal);
    const onFocus = () => { if (!document.hidden) void refresh(controller.signal, true); };
    // Only the open comments panel refreshes periodically. No worker is involved.
    const timer = live ? setInterval(onFocus, 20000) : undefined;
    window.addEventListener("focus", onFocus);
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener("focus", onFocus); };
  }, [enabled, live, refresh]);

  function begin(anchor: CommentAnchor) {
    if (hasDraft || writing.current) return;
    setDraft({ anchor, version }); setBody(""); setError(""); setActiveId(null); setFilter("open"); setReplyId(null);
    window.getSelection()?.removeAllRanges();
  }
  function cancel() { if (!writing.current) { setDraft(null); setBody(""); setError(""); } }
  function select(id: string) {
    setActiveId(id);
    if (!hasDraft) setFilter(comments.find(comment => comment.id === id)?.resolvedAt ? "resolved" : "open");
  }
  async function write(key: string, path: string, method: "POST" | "PATCH", payload: unknown, apply: (data: Record<string, unknown>) => void) {
    if (writing.current) return;
    writing.current = true; sequence.current++; setLoading(false); setBusy(key); setError("");
    try {
      const response = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await response.json() as Record<string, unknown> & { error?: { message?: string } };
      if (!response.ok) throw new Error(data.error?.message || "Could not save your comment. Please try again.");
      if (alive.current) apply(data);
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : "Could not reach the server. Your comment is still here.");
    } finally {
      writing.current = false;
      if (alive.current) { setBusy(null); void refresh(undefined, true); }
    }
  }
  function post() {
    if (!draft || !body.trim()) return;
    void write("new", `/api/articles/${articleId}/comments`, "POST", { expectedVersion: draft.version, anchor: draft.anchor, body: body.trim() }, data => {
      const comment = data.comment as ArticleComment;
      setComments(previous => [...previous, comment]); setActiveId(comment.id); setDraft(null); setBody(""); setFilter("open");
    });
  }
  function reply(id: string) {
    if (!replyBody.trim()) return;
    void write(`reply:${id}`, `/api/articles/${articleId}/comments`, "POST", { parentId: id, body: replyBody.trim() }, data => {
      setComments(previous => previous.map(comment => comment.id === id ? { ...comment, replies: [...comment.replies, data.reply as ArticleComment["replies"][number]] } : comment));
      setReplyBody(""); setReplyId(null);
    });
  }
  function resolve(comment: ArticleComment) {
    void write(comment.id, `/api/articles/${articleId}/comments/${comment.id}`, "PATCH", { resolved: !comment.resolvedAt }, data => {
      setComments(previous => previous.map(item => item.id === comment.id ? { ...item, resolvedAt: data.resolvedAt as string | null } : item));
      setActiveId(null);
    });
  }
  return { comments: located, highlights, blockStarts, loading, loaded, loadError, error, busy, activeId, filter, setFilter,
    draft, body, setBody, replyId, setReplyId, replyBody, setReplyBody, hasDraft, openCount, begin, cancel, select, post, reply, resolve, refresh };
}

export type ArticleCommentsController = ReturnType<typeof useArticleComments>;

function dateLabel(value: string) {
  return new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * The quoted passage as the card shows it.
 *
 * Comments made before selections snapped to whole words can start or end
 * inside one ("enior needs 24 hour ho"). An ellipsis says the passage goes on,
 * instead of looking like a typo.
 *
 * `at` is where the passage sits in the current text, when it was found: a
 * passage that starts a paragraph is not cut, even though the text runs
 * straight on from the heading before it.
 */
export function quoteLabel(anchor: CommentAnchor, at?: { start: number; end: number; blockStarts: ReadonlySet<number> }): string {
  const cutStart = !at?.blockStarts.has(at.start) && WORD_CHAR.test(anchor.prefix.slice(-1)) && WORD_CHAR.test(anchor.quote[0] ?? "");
  const cutEnd = !at?.blockStarts.has(at.end) && WORD_CHAR.test(anchor.suffix[0] ?? "") && WORD_CHAR.test(anchor.quote.slice(-1));
  return `${cutStart ? "…" : ""}${anchor.quote}${cutEnd ? "…" : ""}`;
}

function initials(name: string) {
  return name.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map(part => part[0]!.toUpperCase()).join("") || "?";
}

/** Avatar, name and time, laid out like a Docs comment. */
function Byline({ name, at }: { name: string; at: string }) {
  return <header className={styles.byline}>
    <span className={styles.avatar} aria-hidden="true">{initials(name)}</span>
    <span className={styles.who}><strong>{name}</strong><time dateTime={at}>{dateLabel(at)}</time></span>
  </header>;
}

/**
 * `disabled` stops new comments; `locateDisabled` stops jumping to a passage.
 * While editing, a comment still jumps to its passage, now in the editor.
 * `onLocate` returns false when it could not find the passage there.
 */
export function ArticleCommentsPanel({ controller: c, visible, disabled, locateDisabled = disabled, editing = false, onLocate }: {
  controller: ArticleCommentsController; visible: boolean; disabled: boolean; locateDisabled?: boolean; editing?: boolean; onLocate: (id: string) => boolean | void;
}) {
  const composer = useRef<HTMLTextAreaElement>(null);
  const [missingId, setMissingId] = useState<string | null>(null);
  useEffect(() => { setMissingId(null); }, [editing]);
  useEffect(() => { if (visible && c.draft) composer.current?.focus(); }, [visible, c.draft]);
  useEffect(() => {
    if (visible && c.activeId) {
      const thread = document.getElementById(`comment-thread-${c.activeId}`);
      thread?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      thread?.focus({ preventScroll: true });
    }
  }, [visible, c.activeId]);
  const shown = c.comments.filter(comment => (c.filter === "resolved" ? comment.resolvedAt : !comment.resolvedAt) || (comment.id === c.replyId && Boolean(c.replyBody)));
  return <div className={styles.panel}>
    <p className={styles.hint}>{disabled ? "Finish editing the article to add a comment on saved text." : "Select text in the article, then choose Add comment. Your workspace can read and reply."}</p>
    <div className={styles.filters} aria-label="Comment status">
      <button type="button" aria-pressed={c.filter === "open"} disabled={c.hasDraft} onClick={() => c.setFilter("open")}>Open ({c.openCount})</button>
      <button type="button" aria-pressed={c.filter === "resolved"} disabled={c.hasDraft} onClick={() => c.setFilter("resolved")}>Resolved ({c.comments.length - c.openCount})</button>
      <button type="button" className={styles.refresh} disabled={c.loading || Boolean(c.busy)} onClick={() => void c.refresh()} aria-label="Refresh comments">↻</button>
    </div>
    {c.loading && !c.loaded && <LoadingIndicator label="Loading comments…" />}
    {c.loadError && <p role="alert" className={styles.error}>{c.loadError} <button type="button" onClick={() => void c.refresh()} disabled={c.loading}>Retry</button></p>}
    {c.error && <p role="alert" className={styles.error}>{c.error}</p>}
    {c.draft && <form className={styles.composer} onSubmit={event => { event.preventDefault(); c.post(); }}>
      <strong>New comment</strong><blockquote>{quoteLabel(c.draft.anchor, { start: c.draft.anchor.start, end: c.draft.anchor.end, blockStarts: c.blockStarts })}</blockquote>
      <label htmlFor="article-new-comment">Your comment</label>
      <textarea ref={composer} id="article-new-comment" rows={4} maxLength={4000} value={c.body} disabled={Boolean(c.busy)} placeholder="What would you like to change or clarify?"
        onChange={event => c.setBody(event.target.value)} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); c.post(); } }} />
      <div className={styles.actions}><button type="button" disabled={Boolean(c.busy)} onClick={c.cancel}>Cancel</button><button type="submit" className={styles.primary} disabled={Boolean(c.busy) || !c.body.trim() || disabled}>{c.busy === "new" ? <LoadingIndicator label="Posting…" /> : "Post comment"}</button></div>
    </form>}
    {c.loaded && shown.length === 0 && !c.draft && <div className={styles.empty}><strong>{c.filter === "resolved" ? "No resolved comments" : "No open comments"}</strong><span>{c.filter === "resolved" ? "Resolved discussions will stay here for reference." : "Highlight a sentence or heading to start a discussion."}</span></div>}
    {shown.map(comment => <article key={comment.id} id={`comment-thread-${comment.id}`} tabIndex={-1} aria-label={`Comment by ${comment.authorName}`} className={styles.thread} data-active={c.activeId === comment.id}>
      <Byline name={comment.authorName} at={comment.createdAt} />
      <button type="button" className={styles.quote} disabled={!comment.range || locateDisabled}
        title={!comment.range ? "This passage has changed in the current article" : locateDisabled ? "Wait for the article to finish updating" : editing ? "Show this passage in the editor" : "Show this passage in the article"}
        onClick={() => { c.select(comment.id); setMissingId(onLocate(comment.id) === false ? comment.id : null); }}>{quoteLabel(comment.anchor, comment.range ? { ...comment.range, blockStarts: c.blockStarts } : undefined)}</button>
      {!comment.range && <p className={styles.detached}>Passage changed or removed · originally version {comment.articleVersion}</p>}
      {comment.range && missingId === comment.id && <p className={styles.detached} role="status">You changed or removed this passage in your edits, so it can’t be shown in the editor.</p>}
      <p className={styles.body}>{comment.body}</p>
      {comment.replies.map(reply => <div key={reply.id} className={styles.reply}><Byline name={reply.authorName} at={reply.createdAt} /><p className={styles.body}>{reply.body}</p></div>)}
      <div className={styles.actions}>
        {!comment.resolvedAt && c.replyId !== comment.id && <button type="button" disabled={Boolean(c.busy) || Boolean(c.draft) || Boolean(c.replyBody && c.replyId !== comment.id)} onClick={() => { c.setReplyId(comment.id); c.setReplyBody(""); }}>Reply</button>}
        {comment.canResolve && <button type="button" disabled={Boolean(c.busy) || c.hasDraft} onClick={() => c.resolve(comment)}>{c.busy === comment.id ? <LoadingIndicator label="Saving…" /> : comment.resolvedAt ? "Reopen" : "Resolve"}</button>}
      </div>
      {c.replyId === comment.id && <form className={styles.replyForm} onSubmit={event => { event.preventDefault(); if (!comment.resolvedAt) c.reply(comment.id); }}>
        {comment.resolvedAt && <p className={styles.detached}>This discussion was resolved. Your reply is kept here; cancel it to reopen the discussion.</p>}
        <label htmlFor={`reply-${comment.id}`}>Your reply</label>
        <textarea id={`reply-${comment.id}`} rows={3} maxLength={4000} value={c.replyBody} disabled={Boolean(c.busy)} onChange={event => c.setReplyBody(event.target.value)}
          onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); if (!comment.resolvedAt) c.reply(comment.id); } }} />
        <div className={styles.actions}><button type="button" disabled={Boolean(c.busy)} onClick={() => { c.setReplyId(null); c.setReplyBody(""); }}>Cancel</button><button type="submit" className={styles.primary} disabled={Boolean(c.busy) || !c.replyBody.trim() || Boolean(comment.resolvedAt)}>{c.busy === `reply:${comment.id}` ? <LoadingIndicator label="Posting…" /> : "Post reply"}</button></div>
      </form>}
    </article>)}
  </div>;
}
