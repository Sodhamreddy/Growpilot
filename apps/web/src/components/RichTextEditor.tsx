"use client";

import { useEditor, useEditorState, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import { Markdown } from "tiptap-markdown";
import { useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from "react";
import { centerPosition, editorCommentText, editorTextRange } from "@/lib/editor-comment-range";

/** Lets the comments panel find a passage in the open editor. Offsets count the editor's text only, as comment offsets do. */
export interface RichTextHandle {
  text(): string;
  /** Select the passage and scroll it to the middle of the screen. False when it is not in the document. */
  select(start: number, end: number): boolean;
}

/**
 * What-you-see editing for article drafts.
 *
 * Storage stays markdown — that is what the WordPress connector renders, what
 * the quality gates read, and what diffs cleanly between versions. The editor
 * converts on the way in and back out, so the format of record never becomes
 * HTML-in-a-database.
 *
 * Writers should not have to know markdown to fix a sentence. Asking someone to
 * judge whether copy is publishable while showing them `## Introduction` is
 * asking them to read source, not prose.
 */

/**
 * Read the document back as markdown.
 *
 * `tiptap-markdown` registers itself on `editor.storage.markdown` at runtime,
 * but its module augmentation targets TipTap 2's `Storage` type and this
 * project is on TipTap 3, so the key is invisible to the compiler. The cast is
 * kept to this one accessor rather than loosening the editor's types, and it
 * falls back to the existing text if the extension ever stops registering —
 * losing formatting on save would be bad; throwing inside `onUpdate`, which
 * fires on every keystroke, would be worse.
 */
export function readMarkdown(editor: Editor): string {
  const storage = (editor.storage as unknown as Record<string, unknown>)["markdown"] as
    | { getMarkdown?: () => string }
    | undefined;
  return storage?.getMarkdown?.() ?? editor.getText();
}

export function RichTextEditor({
  markdown,
  onChange,
  editable = true,
  handleRef,
}: {
  markdown: string;
  onChange: (markdown: string) => void;
  editable?: boolean;
  handleRef?: Ref<RichTextHandle>;
}) {
  const editor = useEditor({
    editable,
    extensions: [
      StarterKit.configure({
        // Use the explicitly configured link extension below only once.
        link: false,
        // Headings below h2 have no place in an article body: h1 is the title,
        // and h5/h6 signal a structure nobody reads.
        heading: { levels: [2, 3, 4] },
      }),
      Link.configure({
        openOnClick: false,
        autolink: false,
        // Generated copy can contain anything. Only http(s) becomes clickable.
        protocols: ["http", "https"],
        HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" },
      }),
      Markdown.configure({ html: false, breaks: false, transformPastedText: true }),
    ],
    content: markdown,
    // Next renders this on the server first; without the flag React warns about
    // the markup it produces differing from the client's.
    immediatelyRender: false,
    onUpdate: ({ editor: e }) => {
      onChange(readMarkdown(e));
    },
    editorProps: {
      attributes: { class: "prose tiptap", spellcheck: "true" },
    },
  });

  // Reset when the draft is discarded or a new version arrives.
  useEffect(() => {
    if (!editor) return;
    const current = readMarkdown(editor);
    if (current !== markdown) editor.commands.setContent(markdown, { emitUpdate: false });
  }, [markdown, editor]);

  useImperativeHandle(handleRef, () => ({
    text: () => (editor && !editor.isDestroyed ? editorCommentText(editor.state.doc) : ""),
    select(start, end) {
      if (!editor || editor.isDestroyed) return false;
      const range = editorTextRange(editor.state.doc, start, end);
      if (!range) return false;
      editor.commands.setTextSelection(range);
      // Next frame: the comments panel focuses the comment's card when it opens, and the passage should end up focused.
      requestAnimationFrame(() => {
        if (editor.isDestroyed) return;
        editor.view.focus();
        centerPosition(editor.view, range.from);
      });
      return true;
    },
  }), [editor]);

  if (!editor) {
    return <div className="editor-loading small muted">Loading the editor…</div>;
  }

  return (
    <div className="editorwrap">
      {editable ? <Toolbar editor={editor} /> : null}
      <EditorContent editor={editor} />
    </div>
  );
}

type HeadingLevel = 2 | 3 | 4;

/**
 * The paragraph styles, as Google Docs and Word name them.
 *
 * The article title is the page's Heading 1, set in its own field, so the body
 * starts at Heading 2. Each option is drawn in its own size so the menu shows
 * what it does.
 */
const TEXT_STYLES: { label: string; level: HeadingLevel | null; className: string }[] = [
  { label: "Normal text", level: null, className: "doctb-style-p" },
  { label: "Heading 2", level: 2, className: "doctb-style-h2" },
  { label: "Heading 3", level: 3, className: "doctb-style-h3" },
  { label: "Heading 4", level: 4, className: "doctb-style-h4" },
];

/** Material icon paths, drawn at 20px like the Docs toolbar. */
const ICON = {
  undo: "M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z",
  redo: "M18.4 10.6C16.55 8.99 14.15 8 11.5 8c-4.65 0-8.58 3.03-9.96 7.22L3.9 16c1.05-3.19 4.05-5.5 7.6-5.5 1.95 0 3.73.72 5.12 1.88L13 16h9V7l-3.6 3.6z",
  bold: "M15.6 10.79c.97-.67 1.65-1.77 1.65-2.79 0-2.26-1.75-4-4-4H7v14h7.04c2.09 0 3.71-1.7 3.71-3.79 0-1.52-.86-2.82-2.15-3.42zM10 6.5h3c.83 0 1.5.67 1.5 1.5s-.67 1.5-1.5 1.5h-3v-3zm3.5 9H10v-3h3.5c.83 0 1.5.67 1.5 1.5s-.67 1.5-1.5 1.5z",
  italic: "M10 4v3h2.21l-3.42 8H6v3h8v-3h-2.21l3.42-8H18V4z",
  link: "M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z",
  bullets: "M4 10.5c-.83 0-1.5.67-1.5 1.5s.67 1.5 1.5 1.5 1.5-.67 1.5-1.5-.67-1.5-1.5-1.5zm0-6c-.83 0-1.5.67-1.5 1.5S3.17 7.5 4 7.5 5.5 6.83 5.5 6 4.83 4.5 4 4.5zm0 12c-.83 0-1.5.68-1.5 1.5s.68 1.5 1.5 1.5 1.5-.68 1.5-1.5-.67-1.5-1.5-1.5zM7 19h14v-2H7v2zm0-6h14v-2H7v2zm0-8v2h14V5H7z",
  numbers: "M2 17h2v.5H3v1h1v.5H2v1h3v-4H2v1zm1-9h1V4H2v1h1v3zm-1 3h1.8L2 13.1v.9h3v-1H3.2L5 10.9V10H2v1zm5-6v2h14V5H7zm0 14h14v-2H7v2zm0-6h14v-2H7v2z",
  quote: "M6 17h3l2-4V7H5v6h3zm8 0h3l2-4V7h-6v6h3z",
  clear: "M3.27 5L2 6.27l6.97 6.97L6.5 19h3l1.57-3.66L16.73 21 18 19.73 3.55 5.27 3.27 5zM6 5v.18L8.82 8h2.4l-.72 1.68 2.1 2.1L14.21 8H20V5H6z",
  caret: "M7 10l5 5 5-5z",
} as const;

function Icon({ path, size = 20 }: { path: string; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d={path} fill="currentColor" /></svg>;
}

/** A link may be a web address or a page on the same site. Anything else (javascript:, data:) would go live in the published post. */
function linkProblem(href: string): string | null {
  if (/^https?:\/\/\S+$/i.test(href)) return null;
  if (href.startsWith("/") && !href.startsWith("//")) return null;
  return "Start the link with https:// (or / for a page on this website).";
}

/**
 * The formatting bar, laid out like Google Docs and Word: history, paragraph
 * style, text style, link, lists, then clear formatting.
 *
 * Only formats markdown can store are offered. Underline, colour and fonts
 * would look like they worked here and then vanish on save or in WordPress.
 */
function Toolbar({ editor }: { editor: Editor }) {
  /*
   * Read through useEditorState so the bar follows the cursor.
   *
   * TipTap 3 no longer re-renders on every transaction, so reading
   * `editor.isActive` during render showed the state of the last keystroke:
   * moving into a heading left "Normal text" showing until something was typed.
   */
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      level: ([2, 3, 4] as const).find((level) => e.isActive("heading", { level })) ?? null,
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      bullets: e.isActive("bulletList"),
      numbers: e.isActive("orderedList"),
      quote: e.isActive("blockquote"),
      link: e.isActive("link"),
      href: String(e.getAttributes("link")["href"] ?? ""),
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });
  const [open, setOpen] = useState<null | "style" | "link">(null);
  const [href, setHref] = useState("");
  const [linkError, setLinkError] = useState("");
  const bar = useRef<HTMLDivElement>(null);
  const linkInput = useRef<HTMLInputElement>(null);
  const [mod, setMod] = useState("Ctrl+");
  useEffect(() => { if (/Mac|iPhone|iPad/.test(navigator.platform)) setMod("⌘"); }, []);

  // A menu closes when you click elsewhere or press Escape, as in Docs.
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => { if (!bar.current?.contains(event.target as Node)) setOpen(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(null); editor.commands.focus(); } };
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", outside); document.removeEventListener("keydown", escape); };
  }, [open, editor]);

  const current = TEXT_STYLES.find((style) => style.level === state.level) ?? TEXT_STYLES[0]!;

  function setStyle(level: HeadingLevel | null) {
    const chain = editor.chain().focus();
    (level ? chain.setHeading({ level }) : chain.setParagraph()).run();
    setOpen(null);
  }

  function openLink() {
    if (open === "link") { setOpen(null); return; }
    setHref(state.href);
    setLinkError("");
    setOpen("link");
    requestAnimationFrame(() => linkInput.current?.select());
  }

  function applyLink() {
    const value = href.trim();
    if (!value) { removeLink(); return; }
    const problem = linkProblem(value);
    if (problem) { setLinkError(problem); return; }
    const chain = editor.chain().focus().extendMarkRange("link");
    // With nothing selected, Docs inserts the address itself as the link text.
    if (editor.state.selection.empty && !editor.isActive("link")) {
      chain.insertContent({ type: "text", text: value, marks: [{ type: "link", attrs: { href: value } }] }).run();
    } else {
      chain.setLink({ href: value }).run();
    }
    setOpen(null);
  }

  function removeLink() {
    editor.chain().focus().extendMarkRange("link").unsetLink().run();
    setOpen(null);
  }

  return (
    <div className="doctb" role="toolbar" aria-label="Formatting" ref={bar}>
      <ToolButton title="Undo" shortcut={`${mod}Z`} disabled={!state.canUndo} onRun={() => editor.chain().focus().undo().run()}><Icon path={ICON.undo} /></ToolButton>
      <ToolButton title="Redo" shortcut={`${mod}Y`} disabled={!state.canRedo} onRun={() => editor.chain().focus().redo().run()}><Icon path={ICON.redo} /></ToolButton>
      <span className="doctb-sep" aria-hidden="true" />

      <div className="doctb-anchor">
        <button type="button" className="doctb-select" title="Styles" aria-haspopup="menu" aria-expanded={open === "style"}
          onMouseDown={(event) => event.preventDefault()} onClick={() => setOpen(open === "style" ? null : "style")}>
          <span>{current.label}</span><Icon path={ICON.caret} size={18} />
        </button>
        {open === "style" && (
          <div className="doctb-menu" role="menu" aria-label="Styles">
            {TEXT_STYLES.map((style) => (
              <button key={style.label} type="button" role="menuitemradio" aria-checked={style.level === state.level}
                className={`doctb-menuitem ${style.className}`} onMouseDown={(event) => event.preventDefault()} onClick={() => setStyle(style.level)}>
                {style.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <span className="doctb-sep" aria-hidden="true" />

      <ToolButton title="Bold" shortcut={`${mod}B`} active={state.bold} onRun={() => editor.chain().focus().toggleBold().run()}><Icon path={ICON.bold} /></ToolButton>
      <ToolButton title="Italic" shortcut={`${mod}I`} active={state.italic} onRun={() => editor.chain().focus().toggleItalic().run()}><Icon path={ICON.italic} /></ToolButton>
      <span className="doctb-sep" aria-hidden="true" />

      {/* Not an anchor: the link box lines up with the toolbar's right edge so it is never cut off. */}
      <div className="doctb-linkwrap">
        <ToolButton title={state.link ? "Edit link" : "Insert link"} active={state.link || open === "link"} onRun={openLink}><Icon path={ICON.link} /></ToolButton>
        {open === "link" && (
          <form className="doctb-link" onSubmit={(event) => { event.preventDefault(); applyLink(); }}>
            <label htmlFor="doctb-link-input">Link</label>
            <input id="doctb-link-input" ref={linkInput} type="text" inputMode="url" placeholder="Paste a link, e.g. https://…" value={href}
              aria-invalid={Boolean(linkError)} aria-describedby={linkError ? "doctb-link-error" : undefined}
              onChange={(event) => { setHref(event.target.value); setLinkError(""); }} />
            {linkError && <p id="doctb-link-error" className="doctb-link-error" role="alert">{linkError}</p>}
            <div className="doctb-link-actions">
              {state.link && <button type="button" className="doctb-textbtn" onClick={removeLink}>Remove link</button>}
              <button type="submit" className="doctb-apply">Apply</button>
            </div>
          </form>
        )}
      </div>
      <span className="doctb-sep" aria-hidden="true" />

      <ToolButton title="Bulleted list" shortcut={`${mod}Shift+8`} active={state.bullets} onRun={() => editor.chain().focus().toggleBulletList().run()}><Icon path={ICON.bullets} /></ToolButton>
      <ToolButton title="Numbered list" shortcut={`${mod}Shift+7`} active={state.numbers} onRun={() => editor.chain().focus().toggleOrderedList().run()}><Icon path={ICON.numbers} /></ToolButton>
      <ToolButton title="Quote" shortcut={`${mod}Shift+B`} active={state.quote} onRun={() => editor.chain().focus().toggleBlockquote().run()}><Icon path={ICON.quote} /></ToolButton>
      <span className="doctb-sep" aria-hidden="true" />

      <ToolButton title="Clear formatting" onRun={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}><Icon path={ICON.clear} /></ToolButton>
    </div>
  );
}

function ToolButton({ title, shortcut, active, disabled = false, onRun, children }: {
  title: string; shortcut?: string; active?: boolean; disabled?: boolean; onRun: () => void; children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="doctb-btn"
      title={shortcut ? `${title} (${shortcut})` : title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      // `onMouseDown` with preventDefault, not onClick: clicking a toolbar
      // button would otherwise blur the editor and drop the selection the
      // command is meant to act on.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onRun}
    >
      {children}
    </button>
  );
}

