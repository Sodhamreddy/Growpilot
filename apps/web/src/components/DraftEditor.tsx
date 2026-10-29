"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RichTextEditor } from "./RichTextEditor";
import { LoadingIndicator } from "./LoadingIndicator";

/**
 * The draft, readable and editable.
 *
 * Two problems this replaces. The body was rendered as `{bodyMarkdown}` in a
 * div, so a reviewer read `## Introduction` rather than a heading — asking
 * someone to judge whether copy is publishable while showing them the raw
 * source is asking the wrong question. And there was no way to change a word
 * without regenerating the whole article, which threw away everything that was
 * already right.
 *
 * Preview is the default: reviewing is the common case, editing the exception.
 */

export interface DraftArticle {
  id: string;
  title: string;
  metaTitle: string | null;
  metaDescription: string | null;
  bodyMarkdown: string;
  status: string;
  version: number;
  wordCount: number;
}

const EDITABLE = ["draft", "qa", "needs_changes", "awaiting_approval"];

export function DraftEditor({ article, canEdit, initialMode = "preview", onDone, onDirtyChange }: {
  article: DraftArticle; canEdit: boolean; initialMode?: "preview" | "edit"; onDone?: (saved?: boolean) => void; onDirtyChange?: (dirty: boolean) => void;
}) {
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const [mode, setMode] = useState<"preview" | "edit">(initialMode);
  const [body, setBody] = useState(article.bodyMarkdown);
  const [title, setTitle] = useState(article.title);
  const [metaTitle, setMetaTitle] = useState(article.metaTitle ?? "");
  const [metaDescription, setMetaDescription] = useState(article.metaDescription ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const editable = canEdit && EDITABLE.includes(article.status);
  const dirty =
    body !== article.bodyMarkdown ||
    title !== article.title ||
    metaTitle !== (article.metaTitle ?? "") ||
    metaDescription !== (article.metaDescription ?? "");

  const words = body.trim() ? body.trim().split(/\s+/).length : 0;
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch(`/api/articles/${article.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedVersion: article.version,
          title,
          metaTitle: metaTitle.trim() || null,
          metaDescription: metaDescription.trim() || null,
          bodyMarkdown: body,
        }),
      });
      const parsed: unknown = await res.json();
      if (!res.ok) {
        setError(
          (parsed as { error?: { message?: string } }).error?.message ?? "Could not save.",
        );
        return;
      }
      setSaved(true);
      setMode("preview");
      onDone?.(true);
      startRefresh(() => router.refresh());
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  function discard() {
    setBody(article.bodyMarkdown);
    setTitle(article.title);
    setMetaTitle(article.metaTitle ?? "");
    setMetaDescription(article.metaDescription ?? "");
    setMode("preview");
    setError(null);
    onDone?.();
  }

  return (
    <div className="card">
      <div className="row draft-toolbar" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap" }}>
        <div className="segmented" role="tablist" aria-label="Preview or edit the draft">
          <button type="button" role="tab" aria-selected={mode === "preview"}
                  onClick={() => setMode("preview")}>
            Preview
          </button>
          <button type="button" role="tab" aria-selected={mode === "edit"}
                  disabled={!editable || refreshing} onClick={() => setMode("edit")}>
            Edit
          </button>
        </div>

        <span className="small muted">
          {words.toLocaleString()} words · v{article.version}
          {dirty ? " · unsaved changes" : ""}
        </span>
        {editable && (mode === "edit" || Boolean(onDone)) && <div className="row" style={{ gap: 8 }}>
          <button type="button" className="btn primary" disabled={busy || refreshing || !dirty} onClick={() => void save()}>{busy || refreshing ? <LoadingIndicator label="Saving…" /> : "Save changes"}</button>
          <button type="button" className="btn" disabled={busy || refreshing} onClick={discard}>{dirty ? "Discard edits" : "Done"}</button>
        </div>}
      </div>

      {!editable && canEdit ? (
        <p className="small muted" style={{ marginTop: 0 }}>
          {article.status === "published"
            ? "This article is published. Request changes on it before editing."
            : `An article being ${article.status.replace(/_/g, " ")} cannot be edited right now.`}
        </p>
      ) : null}

      {mode === "edit" ? (
        <>
          <div className="field">
            <label htmlFor="draft-title">Title</label>
            <input id="draft-title" type="text" value={title}
                   onChange={(e) => setTitle(e.target.value)} />
          </div>

          <div className="formgrid">
            <label className="field">
              <span className="fieldlabel">Meta title · {metaTitle.length}/60</span>
              <input type="text" value={metaTitle} maxLength={70}
                     onChange={(e) => setMetaTitle(e.target.value)} />
              {metaTitle.length > 60 ? (
                <span className="hint" style={{ color: "var(--warn)" }}>
                  Google truncates past about 60 characters.
                </span>
              ) : null}
            </label>

            <label className="field">
              <span className="fieldlabel">Meta description · {metaDescription.length}/155</span>
              <input type="text" value={metaDescription} maxLength={160}
                     onChange={(e) => setMetaDescription(e.target.value)} />
              {metaDescription.length > 155 ? (
                <span className="hint" style={{ color: "var(--warn)" }}>
                  Google truncates past about 155 characters.
                </span>
              ) : null}
            </label>
          </div>

          <div className="field">
            <span className="fieldlabel">Body</span>
            <RichTextEditor markdown={body} onChange={setBody} />
          </div>

          <p className="small muted" style={{ margin: "0 0 14px", maxWidth: "70ch" }}>
            Saving creates a new version and clears the SEO and voice scores — they describe
            the previous text, and an edited draft should not inherit a score it did not earn.
            Run the quality gates again afterwards.
          </p>

        </>
      ) : (
        <ArticleMarkdown source={body} />
      )}

      {error ? <p className="error" style={{ marginTop: 12 }}>{error}</p> : null}
      {saved && !error ? <p className="small muted" style={{ marginTop: 12 }}>Saved.</p> : null}
    </div>
  );
}

/**
 * Render the draft's markdown.
 *
 * Deliberately small and built from React elements rather than `innerHTML`:
 * this text comes from a model, and a renderer that sets raw HTML would let a
 * generated string put markup into the dashboard. Escaping is automatic when
 * everything is a React child.
 */
export function ArticleMarkdown({ source }: { source: string }) {
  if (!source.trim()) {
    return (
      <div className="empty">
        <strong>No draft yet</strong>
        <span>Generate one to see it here.</span>
      </div>
    );
  }

  const blocks: React.ReactNode[] = [];
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  let paragraph: string[] = [];
  let list: string[] = [];
  let listOrdered = false;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push(<p key={blocks.length}>{inline(paragraph.join(" "))}</p>);
    paragraph = [];
  };

  const flushList = () => {
    if (list.length === 0) return;
    const items = list.map((item, i) => <li key={i}>{inline(item)}</li>);
    blocks.push(listOrdered ? <ol key={blocks.length}>{items}</ol> : <ul key={blocks.length}>{items}</ul>);
    list = [];
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const level = Math.min(heading[1]!.length, 6);
      const Tag = `h${level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
      blocks.push(<Tag key={blocks.length}>{inline(heading[2]!.trim())}</Tag>);
      continue;
    }

    if (/^>\s?/.test(line)) {
      flushParagraph();
      flushList();
      blocks.push(<blockquote key={blocks.length}>{inline(line.replace(/^>\s?/, ""))}</blockquote>);
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      const wantsOrdered = Boolean(numbered);
      if (list.length > 0 && wantsOrdered !== listOrdered) flushList();
      listOrdered = wantsOrdered;
      list.push((bullet ?? numbered)![1]!.trim());
      continue;
    }

    paragraph.push(line.trim());
  }

  flushParagraph();
  flushList();

  return <div className="prose">{blocks}</div>;
}

/** Bold, italic, code and links, as React nodes. */
function inline(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  let key = 0;

  for (const match of text.matchAll(pattern)) {
    const at = match.index!;
    if (at > last) out.push(text.slice(last, at));
    const token = match[0];

    if (token.startsWith("**")) {
      out.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("`")) {
      out.push(<code key={key++}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("[")) {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token)!;
      const href = link[2]!;
      // Only http(s) and root-relative links become links. A javascript: href
      // in generated copy would otherwise be clickable in the dashboard.
      const safe = /^https?:\/\//i.test(href) || href.startsWith("/");
      out.push(
        safe
          ? <a key={key++} href={href} target="_blank" rel="noopener noreferrer">{link[1]}</a>
          : <span key={key++}>{link[1]}</span>,
      );
    } else {
      out.push(<em key={key++}>{token.slice(1, -1)}</em>);
    }
    last = at + token.length;
  }

  if (last < text.length) out.push(text.slice(last));
  return out;
}
