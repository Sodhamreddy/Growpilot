import { createCommentAnchor, type CommentAnchor } from "./article-comment-text";

/** Read only the title/body regions; toolbar labels and article metadata never enter an anchor. */
export function readArticleSelection(root: HTMLElement, text: string, selection: Selection | null): {
  anchor: CommentAnchor; rect: DOMRect;
} | { error: string } | null {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const range = selection.getRangeAt(0);
  const regions = [...root.querySelectorAll<HTMLElement>("[data-comment-text]")];
  const region = regions.find(element => element.contains(range.startContainer) && element.contains(range.endContainer));
  if (!region) return null;
  const renderedText = regions.map(element => element.textContent ?? "").join("");
  if (renderedText !== text) return null;
  const before = range.cloneRange();
  before.selectNodeContents(region);
  before.setEnd(range.startContainer, range.startOffset);
  let start = regions.slice(0, regions.indexOf(region)).reduce((length, element) => length + (element.textContent?.length ?? 0), 0) + before.toString().length;
  let end = start + range.toString().length;
  // A drag that stops inside a word quotes whole words ("senior", not "enior"), as Docs does.
  start -= wordStartShift(range.startContainer, range.startOffset);
  end += wordEndShift(range.endContainer, range.endOffset);
  while (start < end && /\s/.test(text[start]!)) start++;
  while (end > start && /\s/.test(text[end - 1]!)) end--;
  if (end <= start) return null;
  if (end - start > 3000) return { error: "Select a shorter passage (up to 3,000 characters) to add a comment." };
  const rects = range.getClientRects();
  return { anchor: createCommentAnchor(text, start, end), rect: rects[rects.length - 1] ?? range.getBoundingClientRect() };
}

const WORD_CHAR = /[\p{L}\p{N}]/u;
/** Longer runs are not words (a pasted code or id), so a selection inside one is left as it is. */
const MAX_WORD = 40;

/**
 * How far back a selection edge must move to reach the start of the word it cut.
 *
 * Measured inside one text node, so it never reaches into the previous
 * paragraph: the article text has no separators between blocks, and widening
 * there would join a heading's last word to the next paragraph's first.
 */
export function wordStartShift(node: Node, offset: number): number {
  const value = node.nodeType === 3 ? node.nodeValue ?? "" : "";
  if (!WORD_CHAR.test(value[offset] ?? "") || !WORD_CHAR.test(value[offset - 1] ?? "")) return 0;
  let at = offset;
  while (at > 0 && WORD_CHAR.test(value[at - 1]!)) at--;
  return offset - at <= MAX_WORD ? offset - at : 0;
}

/** How far forward a selection edge must move to finish the word it cut (same text node only). */
export function wordEndShift(node: Node, offset: number): number {
  const value = node.nodeType === 3 ? node.nodeValue ?? "" : "";
  if (!WORD_CHAR.test(value[offset - 1] ?? "") || !WORD_CHAR.test(value[offset] ?? "")) return 0;
  let at = offset;
  while (at < value.length && WORD_CHAR.test(value[at]!)) at++;
  return at - offset <= MAX_WORD ? at - offset : 0;
}
