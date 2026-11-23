// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";
import { createCommentAnchor, getArticleCommentText } from "./article-comment-text";
import { editorCommentText, editorTextRange, findEditedPassage } from "./editor-comment-range";

const editors: Editor[] = [];
function open(markdown: string) {
  const editor = new Editor({ extensions: [StarterKit.configure({ heading: { levels: [2, 3, 4] } }), Markdown.configure({ html: false, breaks: false })], content: markdown });
  editors.push(editor);
  return editor;
}
afterEach(() => { editors.splice(0).forEach(editor => editor.destroy()); });

const title = "Signs Your Senior Needs Care";
const body = "## Why it matters\n\nA senior needs **24 hour** home care.\n\n- Falls at night\n- Missed meals";

describe("finding a comment's passage in the editor", () => {
  it("reads the same text the comment offsets count", () => {
    expect(editorCommentText(open(body).state.doc)).toBe(getArticleCommentText(title, body).slice(title.length));
  });

  it("selects the commented words, across bold text and list items", () => {
    const editor = open(body);
    const text = getArticleCommentText(title, body);
    for (const quote of ["senior needs 24 hour home", "Falls at night", "Missed"]) {
      const anchor = createCommentAnchor(text, text.indexOf(quote), text.indexOf(quote) + quote.length);
      const at = findEditedPassage(title + editorCommentText(editor.state.doc), anchor)!;
      const range = editorTextRange(editor.state.doc, at.start - title.length, at.end - title.length)!;
      expect(editor.state.doc.textBetween(range.from, range.to)).toBe(quote);
    }
  });

  it("still finds a passage after the text around it was edited", () => {
    const text = getArticleCommentText(title, body);
    const anchor = createCommentAnchor(text, text.indexOf("home care"), text.indexOf("home care") + 9);
    const edited = open(body.replace("A senior needs", "Your parent may need"));
    expect(findEditedPassage(title + editorCommentText(edited.state.doc), anchor)).not.toBeNull();
  });

  it("reports a passage the edits removed", () => {
    const text = getArticleCommentText(title, body);
    const anchor = createCommentAnchor(text, text.indexOf("Missed meals"), text.indexOf("Missed meals") + 12);
    const edited = open(body.replace("- Missed meals", "- Skipped lunch"));
    expect(findEditedPassage(title + editorCommentText(edited.state.doc), anchor)).toBeNull();
  });

  it("refuses offsets outside the document", () => {
    const doc = open(body).state.doc;
    expect(editorTextRange(doc, 5, 5)).toBeNull();
    expect(editorTextRange(doc, 0, 10_000)).toBeNull();
  });
});
