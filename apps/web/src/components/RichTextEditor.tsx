"use client";

import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import { Markdown } from "tiptap-markdown";
import { useEffect } from "react";

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
function readMarkdown(editor: Editor): string {
  const storage = (editor.storage as unknown as Record<string, unknown>)["markdown"] as
    | { getMarkdown?: () => string }
    | undefined;
  return storage?.getMarkdown?.() ?? editor.getText();
}

export function RichTextEditor({
  markdown,
  onChange,
  editable = true,
}: {
  markdown: string;
  onChange: (markdown: string) => void;
  editable?: boolean;
}) {
  const editor = useEditor({
    editable,
    extensions: [
      StarterKit.configure({
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

function Toolbar({ editor }: { editor: Editor }) {
  const btn = (
    label: string,
    title: string,
    isActive: boolean,
    run: () => void,
    disabled = false,
  ) => (
    <button
      type="button"
      className="tbtn"
      title={title}
      aria-label={title}
      aria-pressed={isActive}
      disabled={disabled}
      // `onMouseDown` with preventDefault, not onClick: clicking a toolbar
      // button would otherwise blur the editor and drop the selection the
      // command is meant to act on.
      onMouseDown={(e) => {
        e.preventDefault();
        run();
      }}
    >
      {label}
    </button>
  );

  return (
    <div className="editortoolbar" role="toolbar" aria-label="Formatting">
      {btn("H2", "Heading 2", editor.isActive("heading", { level: 2 }), () =>
        editor.chain().focus().toggleHeading({ level: 2 }).run())}
      {btn("H3", "Heading 3", editor.isActive("heading", { level: 3 }), () =>
        editor.chain().focus().toggleHeading({ level: 3 }).run())}

      <span className="tsep" />

      {btn("B", "Bold", editor.isActive("bold"), () =>
        editor.chain().focus().toggleBold().run())}
      {btn("I", "Italic", editor.isActive("italic"), () =>
        editor.chain().focus().toggleItalic().run())}

      <span className="tsep" />

      {btn("• List", "Bulleted list", editor.isActive("bulletList"), () =>
        editor.chain().focus().toggleBulletList().run())}
      {btn("1. List", "Numbered list", editor.isActive("orderedList"), () =>
        editor.chain().focus().toggleOrderedList().run())}
      {btn("❝", "Quote", editor.isActive("blockquote"), () =>
        editor.chain().focus().toggleBlockquote().run())}

      <span className="tsep" />

      {btn("Link", "Add or edit a link", editor.isActive("link"), () => {
        const previous = (editor.getAttributes("link")["href"] as string) ?? "";
        const href = window.prompt("Link address", previous);
        if (href === null) return;
        if (href.trim() === "") {
          editor.chain().focus().unsetLink().run();
          return;
        }
        // Refuse anything that is not a web address. A javascript: href in a
        // draft would otherwise become a live link in the published post.
        if (!/^https?:\/\//i.test(href) && !href.startsWith("/")) {
          window.alert("Links must start with https:// or / for an internal page.");
          return;
        }
        editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
      })}
      {btn("Unlink", "Remove link", false, () =>
        editor.chain().focus().unsetLink().run(), !editor.isActive("link"))}

      <span className="tspacer" />

      {btn("↶", "Undo", false, () => editor.chain().focus().undo().run(),
        !editor.can().undo())}
      {btn("↷", "Redo", false, () => editor.chain().focus().redo().run(),
        !editor.can().redo())}
    </div>
  );
}
