"use client";

import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";
import { useEffect, useRef, useState } from "react";
import { readMarkdown } from "./RichTextEditor";

/**
 * Rich editing for post copy: the caption, and the text on the post image.
 *
 * The article editor's sibling, with the formatting a post can use and none
 * it cannot: no headings or links, which no network renders in a caption.
 * Stored as markdown like the article body, so a plain caption stays plain
 * text and Copy can hand a network exactly what it accepts.
 *
 * A− and A+ change how large the text is while editing. Networks have no
 * font sizes, so it is a reading aid for the person, not part of the post.
 */

const SIZES = [12, 13, 14, 15, 16, 18, 20];

export function SocialRichText({
  markdown,
  onChange,
  editable = true,
  variant = "caption",
  label,
}: {
  markdown: string;
  onChange: (markdown: string) => void;
  editable?: boolean;
  /** "image" sets the first line as the headline, the way it sits on the image. */
  variant?: "caption" | "image";
  /** Accessible name for the editing area. */
  label: string;
}) {
  const [size, setSize] = useState(variant === "image" ? 3 : 2);

  /*
   * Only a person's edit counts as a change.
   *
   * Loading text into the editor and reading it back does not always return
   * the same string: the markdown writer normalises spacing and escapes. If
   * that difference were reported, merely opening a post would look like an
   * edit, save itself, and on an approved post take the approval back. So the
   * editor's own reading of what it was given is kept as a baseline, and
   * matching it again reports the original text, unchanged.
   */
  const baseline = useRef<{ read: string; given: string } | null>(null);
  const settle = (e: Editor) => { baseline.current = { read: readMarkdown(e), given: markdown }; };

  const editor = useEditor({
    editable,
    extensions: [
      StarterKit.configure({
        heading: false, blockquote: false, code: false, codeBlock: false, horizontalRule: false, link: false,
      }),
      // html: true so underline survives the round trip as <u>, which plain
      // markdown has no syntax for. Only the schema's own marks are parsed
      // back in, so nothing else in a stored caption can become markup.
      Markdown.configure({ html: true, breaks: false, transformPastedText: true }),
    ],
    content: markdown,
    immediatelyRender: false,
    onCreate: ({ editor: e }) => settle(e),
    onUpdate: ({ editor: e }) => {
      const read = readMarkdown(e);
      onChange(baseline.current && read === baseline.current.read ? baseline.current.given : read);
    },
    editorProps: {
      attributes: { class: `tiptap spack-rte-body ${variant}`, spellcheck: "true", "aria-label": label },
    },
  });

  // A new version from the server (a rewrite, a discard) replaces what is shown.
  useEffect(() => {
    if (!editor) return;
    if (baseline.current?.given === markdown) return;
    if (readMarkdown(editor) !== markdown) {
      editor.commands.setContent(markdown, { emitUpdate: false });
      settle(editor);
    }
  }, [markdown, editor]);

  useEffect(() => { editor?.setEditable(editable); }, [editor, editable]);

  if (!editor) return <div className="editor-loading small muted">Loading the editor…</div>;

  return (
    <div className="spack-rte" style={{ ["--rte-size" as string]: `${SIZES[size]}px` }}>
      {editable ? (
        <Toolbar
          editor={editor}
          canShrink={size > 0}
          canGrow={size < SIZES.length - 1}
          onSize={(d) => setSize((s) => Math.min(SIZES.length - 1, Math.max(0, s + d)))}
        />
      ) : null}
      <EditorContent editor={editor} />
    </div>
  );
}

function Toolbar({ editor, canShrink, canGrow, onSize }: {
  editor: Editor;
  canShrink: boolean;
  canGrow: boolean;
  onSize: (delta: number) => void;
}) {
  const btn = (label: string, title: string, active: boolean, run: () => void, disabled = false, cls = "") => (
    <button
      type="button"
      className={`tbtn ${cls}`}
      title={title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      // mousedown, not click: a click would blur the editor and lose the selection.
      onMouseDown={(e) => { e.preventDefault(); run(); }}
    >
      {label}
    </button>
  );

  return (
    <div className="spack-rte-toolbar" role="toolbar" aria-label="Formatting">
      {btn("B", "Bold", editor.isActive("bold"), () => editor.chain().focus().toggleBold().run(), false, "b")}
      {btn("I", "Italic", editor.isActive("italic"), () => editor.chain().focus().toggleItalic().run(), false, "i")}
      {btn("U", "Underline", editor.isActive("underline"), () => editor.chain().focus().toggleUnderline().run(), false, "u")}
      {btn("• List", "Bulleted list", editor.isActive("bulletList"), () => editor.chain().focus().toggleBulletList().run())}
      {btn("1. List", "Numbered list", editor.isActive("orderedList"), () => editor.chain().focus().toggleOrderedList().run())}
      <span className="tsep" />
      {btn("A−", "Smaller text while editing", false, () => onSize(-1), !canShrink)}
      {btn("A+", "Larger text while editing", false, () => onSize(1), !canGrow)}
    </div>
  );
}
