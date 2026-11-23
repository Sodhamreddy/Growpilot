"use client";

import { useEffect, useImperativeHandle, useRef, useState, useTransition, type Ref } from "react";
import { useRouter } from "next/navigation";
import type { CommentAnchor } from "@/lib/article-comment-text";
import { findEditedPassage } from "@/lib/editor-comment-range";
import { RichTextEditor, type RichTextHandle } from "./RichTextEditor";
import { LoadingIndicator } from "./LoadingIndicator";
import { ArticleMarkdown } from "./ArticleMarkdown";
export { ArticleMarkdown, CommentHighlightedText } from "./ArticleMarkdown";

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

export interface DraftEditorHandle {
  /** Select a comment's passage in the open editor and scroll to it. False when the edits changed or removed it. */
  reveal(anchor: CommentAnchor): boolean;
}

export function DraftEditor({ article, canEdit, initialMode = "preview", onDone, onDirtyChange, revealRef }: {
  article: DraftArticle; canEdit: boolean; initialMode?: "preview" | "edit"; onDone?: (saved?: boolean) => void; onDirtyChange?: (dirty: boolean) => void;
  revealRef?: Ref<DraftEditorHandle>;
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
  const richText = useRef<RichTextHandle>(null);
  const titleInput = useRef<HTMLInputElement>(null);

  // Comment offsets count the title, then the body, with nothing between them.
  useImperativeHandle(revealRef, () => ({
    reveal(anchor) {
      const editor = richText.current;
      if (mode !== "edit" || !editor) return false;
      const at = findEditedPassage(title + editor.text(), anchor);
      if (!at) return false;
      if (at.end > title.length) return editor.select(Math.max(at.start, title.length) - title.length, at.end - title.length);
      requestAnimationFrame(() => {
        const input = titleInput.current;
        if (!input) return;
        input.focus({ preventScroll: true });
        input.setSelectionRange(at.start, at.end);
        input.scrollIntoView({ block: "center", behavior: "smooth" });
      });
      return true;
    },
  }), [mode, title]);

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
            <input id="draft-title" ref={titleInput} type="text" value={title}
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
            <RichTextEditor markdown={body} onChange={setBody} handleRef={richText} />
          </div>
        </>
      ) : (
        <ArticleMarkdown source={body} />
      )}

      {error ? <p className="error" style={{ marginTop: 12 }}>{error}</p> : null}
      {saved && !error ? <p className="small muted" style={{ marginTop: 12 }}>Saved.</p> : null}
    </div>
  );
}
