import type { Editor } from "@tiptap/react";
import { findCommentAnchor, type CommentAnchor } from "./article-comment-text";

type EditorDoc = Editor["state"]["doc"];
type EditorView = Editor["view"];

/**
 * Text inside the editor, counted the way comment offsets count it.
 *
 * Comment text runs blocks together with no separators, and the Markdown
 * reader turns a line break into a space. The editor's document is read the
 * same way, so a passage keeps its offsets when the draft opens for editing.
 */
function eachRun(doc: EditorDoc, visit: (text: string, pos: number) => boolean | void) {
  let stop = false;
  doc.descendants((node, pos) => {
    if (stop) return false;
    const text = node.isText ? node.text ?? "" : node.type.name === "hardBreak" ? " " : "";
    if (text && visit(text, pos) === true) stop = true;
    return !stop;
  });
}

export function editorCommentText(doc: EditorDoc): string {
  let text = "";
  eachRun(doc, run => { text += run; });
  return text;
}

/** Editor positions for a passage given in editor text offsets. A line break is one character wide, like a space. */
export function editorTextRange(doc: EditorDoc, start: number, end: number): { from: number; to: number } | null {
  if (!(start >= 0 && end > start)) return null;
  let offset = 0;
  let from = -1;
  let to = -1;
  eachRun(doc, (run, pos) => {
    if (from === -1 && start < offset + run.length) from = pos + start - offset;
    if (from !== -1 && end <= offset + run.length) to = pos + end - offset;
    offset += run.length;
    return to !== -1;
  });
  return from !== -1 && to !== -1 ? { from, to } : null;
}

/**
 * Where a comment's passage is in a draft that may have been edited since.
 *
 * The context around it may have changed while the passage itself did not, so
 * a passage that appears exactly once is still found.
 */
export function findEditedPassage(text: string, anchor: CommentAnchor): { start: number; end: number } | null {
  const found = findCommentAnchor(text, anchor);
  if (found || !anchor.quote) return found;
  const first = text.indexOf(anchor.quote);
  return first !== -1 && text.indexOf(anchor.quote, first + 1) === -1 ? { start: first, end: first + anchor.quote.length } : null;
}

/**
 * Bring a position to the middle of every box that scrolls around it.
 *
 * The editor scrolls inside the page, which scrolls too. Each box moves at once
 * so the next one measures where the text really is; the outermost glides.
 */
export function centerPosition(view: EditorView, pos: number) {
  const steps: { box: () => { top: number; height: number }; by: (top: number, behavior: ScrollBehavior) => void }[] = [];
  for (let el: HTMLElement | null = view.dom; el && el !== document.body; el = el.parentElement) {
    const box = el;
    if (/(auto|scroll|overlay)/.test(getComputedStyle(box).overflowY) && box.scrollHeight > box.clientHeight) {
      steps.push({ box: () => ({ top: box.getBoundingClientRect().top + box.clientTop, height: box.clientHeight }), by: (top, behavior) => box.scrollBy({ top, behavior }) });
    }
  }
  const page = document.scrollingElement;
  if (page && page.scrollHeight > window.innerHeight) {
    steps.push({ box: () => ({ top: 0, height: window.innerHeight }), by: (top, behavior) => window.scrollBy({ top, behavior }) });
  }
  steps.forEach((step, index) => {
    const at = view.coordsAtPos(pos);
    const { top, height } = step.box();
    const delta = (at.top + at.bottom) / 2 - (top + height / 2);
    if (Math.abs(delta) > 1) step.by(delta, index === steps.length - 1 ? "smooth" : "auto");
  });
}
