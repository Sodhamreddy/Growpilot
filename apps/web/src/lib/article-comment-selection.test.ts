import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { ArticleMarkdown } from "@/components/ArticleMarkdown";
import { getArticleCommentText } from "./article-comment-text";
import { readArticleSelection } from "./article-comment-selection";

function fixture(body = "A **helpful** paragraph.\n\n## Details\n\nMore advice.") {
  const title = "Care advice";
  const dom = new JSDOM(`<article><h1 data-comment-text="title">${title}</h1><p>Version 3 · SEO 90</p><div data-comment-text="body">${renderToStaticMarkup(createElement(ArticleMarkdown, { source: body }))}</div></article>`);
  const root = dom.window.document.querySelector("article")!;
  const range = dom.window.document.createRange();
  Object.assign(range, { getClientRects: () => [{ bottom: 100, right: 200 }], getBoundingClientRect: () => ({ bottom: 100, right: 200 }) });
  function select(start: Node, startOffset: number, end: Node, endOffset: number) {
    range.setStart(start, startOffset); range.setEnd(end, endOffset);
    const selection = dom.window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    return readArticleSelection(root, getArticleCommentText(title, body), selection);
  }
  return { dom, root, select };
}

describe("article text selection", () => {
  it("captures a passage across formatting without Markdown syntax or metadata", () => {
    const { root, select } = fixture();
    const p = root.querySelector("[data-comment-text=body] p")!;
    expect(select(p.firstChild!, 0, p.lastChild!, 11)).toMatchObject({ anchor: { quote: "A helpful paragraph.", start: 11, end: 31 } });
  });
  it("handles text across paragraph and heading nodes with the same server offsets", () => {
    const { root, select } = fixture();
    expect(select(root.querySelector("strong")!.firstChild!, 0, root.querySelector("h2")!.firstChild!, 7)).toMatchObject({ anchor: { quote: "helpful paragraph.Details", start: 13, end: 38 } });
  });
  it("supports title comments and ignores document metadata selections", () => {
    const { root, select } = fixture();
    expect(select(root.querySelector("h1")!.firstChild!, 0, root.querySelector("h1")!.firstChild!, 4)).toMatchObject({ anchor: { quote: "Care", start: 0, end: 4 } });
    const metadata = root.querySelector("article > p")!.firstChild!;
    expect(select(metadata, 0, metadata, 7)).toBeNull();
  });
  it("does not mix metadata into a selection spanning title and body", () => {
    const { root, select } = fixture();
    expect(select(root.querySelector("h1")!.firstChild!, 0, root.querySelector("strong")!.firstChild!, 7)).toBeNull();
  });
  it("trims whitespace and explains overly large selections", () => {
    const { root, select } = fixture("start " + "x".repeat(3001));
    const text = root.querySelector("[data-comment-text=body] p")!.firstChild!;
    expect(select(text, 5, text, 9)).toMatchObject({ anchor: { quote: "xxx", start: 17, end: 20 } });
    expect(select(text, 6, text, 3007)).toEqual({ error: "Select a shorter passage (up to 3,000 characters) to add a comment." });
  });
});
