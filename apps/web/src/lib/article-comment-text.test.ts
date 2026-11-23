import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ArticleMarkdown, CommentHighlightedText } from "@/components/ArticleMarkdown";
import { createCommentAnchor, findCommentAnchor, getArticleBodySource, getArticleBodyText, getArticleCommentText } from "./article-comment-text";

const visibleText = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'");
const source = "# Sample article\r\n\r\nA **bold** passage and *gentle* words.\r\n\r\n## Details\r\nUse `care` and [our guide](https://example.com/guide).\r\n\r\n- First item\r\n- Second item\r\n\r\n1. Number one\r\n2. Number two\r\n\r\n> A quote.";

describe("article comment text", () => {
  it("uses exactly the displayed title and body text, including inline formatting and lists", () => {
    const bodySource = getArticleBodySource("Sample article", source);
    const body = renderToStaticMarkup(createElement(ArticleMarkdown, { source: bodySource }));
    expect(bodySource).not.toMatch(/^# Sample/);
    expect(getArticleBodyText(bodySource)).toBe(visibleText(body));
    expect(getArticleCommentText("Sample article", source)).toBe("Sample article" + visibleText(body));
    expect(getArticleBodyText(bodySource)).toBe("A bold passage and gentle words.DetailsUse care and our guide.First itemSecond itemNumber oneNumber twoA quote.");
  });

  it("does not remove a different body heading", () => {
    expect(getArticleBodySource("Title", "# Introduction\n\nBody")).toBe("# Introduction\n\nBody");
    expect(getArticleBodySource("Title", "# Title")).toBe("");
  });

  it("preserves the renderer's safe links and literal HTML escaping", () => {
    const markdown = "[Unsafe](javascript:alert) and [Safe](/guide). <script>test</script> & done.";
    const html = renderToStaticMarkup(createElement(ArticleMarkdown, { source: markdown }));
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain("<script>");
    expect(html).toContain('href="/guide"');
    expect(getArticleBodyText(markdown)).toBe(visibleText(html));
  });

  it("keeps highlight offsets correct across strong text, links, and headings", () => {
    const bodySource = getArticleBodySource("Sample article", source);
    const text = getArticleBodyText(bodySource);
    const start = text.indexOf("bold");
    const end = text.indexOf("gentle") + "gentle".length;
    const html = renderToStaticMarkup(createElement(ArticleMarkdown, {
      source: bodySource, highlights: [{ id: "thread-1", start, end }], onHighlightClick: () => undefined,
    }));
    expect(visibleText(html)).toBe(text);
    expect(html).toContain('data-comment-id="thread-1"');
    expect(html).toContain('<strong><mark');
    expect(html).toContain('role="button"');
    expect(html).toContain('tabindex="0"');
  });

  it("can highlight the title with the same offsets without duplicating overlapping text", () => {
    const html = renderToStaticMarkup(createElement(CommentHighlightedText, {
      text: "A helpful title", highlights: [{ id: "first", start: 2, end: 9 }, { id: "second", start: 5, end: 15 }],
      activeCommentId: "second", onHighlightClick: () => undefined,
    }));
    expect(visibleText(html)).toBe("A helpful title");
    expect(html).toContain('data-comment-id="second"');
    expect(html).toContain('data-active="true"');
    expect(html).toContain('data-comment-ids="second first"');
  });

  it("matches Unicode offsets to DOM string offsets", () => {
    const text = getArticleCommentText("Care 🧡", "Friendly **support** for అందరూ.");
    const start = text.indexOf("support");
    const anchor = createCommentAnchor(text, start, start + 7);
    expect(anchor.quote).toBe("support");
    expect(findCommentAnchor(text, anchor)).toEqual({ start, end: start + 7 });
  });
});

describe("comment anchor recovery", () => {
  it("retains a passage at its original location", () => {
    const text = "The reader needs practical, helpful advice about care.";
    const anchor = createCommentAnchor(text, 17, 41);
    expect(findCommentAnchor(text, anchor)).toEqual({ start: 17, end: 41 });
  });

  it("follows an intact passage when content is inserted before it", () => {
    const text = "Opening sentence. The highlighted advice appears here. Closing sentence.";
    const start = text.indexOf("highlighted advice");
    const anchor = createCommentAnchor(text, start, start + 18);
    const updated = "New opening. " + text;
    expect(findCommentAnchor(updated, anchor)).toEqual({ start: start + 13, end: start + 31 });
  });

  it("uses nearby context to choose between repeated phrases", () => {
    const text = "First context: ask for help. " + "x".repeat(100) + "Second context: ask for help. This is the selected one.";
    const start = text.lastIndexOf("ask for help");
    const anchor = createCommentAnchor(text, start, start + 12);
    expect(findCommentAnchor("A new paragraph. " + text, anchor)).toEqual({ start: start + 17, end: start + 29 });
  });

  it("does not attach a removed passage to another occurrence with different context", () => {
    const text = "This selected paragraph says check details before paying. " + "x".repeat(100) + "Another paragraph says check details when calling.";
    const start = text.indexOf("check details");
    const anchor = createCommentAnchor(text, start, start + 13);
    expect(findCommentAnchor("Another paragraph says check details when calling.", anchor)).toBeNull();
  });

  it("leaves equally plausible duplicates detached", () => {
    const context = "a".repeat(64) + "selected" + "b".repeat(64);
    const anchor = createCommentAnchor(context, 64, 72);
    expect(findCommentAnchor(context + context, anchor)).toBeNull();
  });

  it("rejects removed text and invalid original ranges", () => {
    expect(findCommentAnchor("New paragraph", createCommentAnchor("Old paragraph", 0, 3))).toBeNull();
    expect(findCommentAnchor("text", { quote: "", start: 0, end: 0, prefix: "", suffix: "" })).toBeNull();
    expect(findCommentAnchor("text", { quote: "text", start: -1, end: 3, prefix: "", suffix: "" })).toBeNull();
    expect(findCommentAnchor("text", { quote: "text", start: 0, end: 2, prefix: "", suffix: "" })).toBeNull();
  });

  it("bounds saved context to 64 characters on each side", () => {
    const anchor = createCommentAnchor("x".repeat(200), 90, 100);
    expect(anchor.prefix).toHaveLength(64);
    expect(anchor.suffix).toHaveLength(64);
  });

  it("keeps context valid UTF-8 when its boundary falls inside an emoji", () => {
    const text = "🧡" + "a".repeat(63) + "selected" + "b".repeat(63) + "🧡";
    const anchor = createCommentAnchor(text, 65, 73);
    expect(anchor.prefix).toBe("a".repeat(63));
    expect(anchor.suffix).toBe("b".repeat(63));
    expect(Buffer.from(anchor.prefix).toString("utf8")).toBe(anchor.prefix);
    expect(Buffer.from(anchor.suffix).toString("utf8")).toBe(anchor.suffix);
    expect(findCommentAnchor(text, anchor)).toEqual({ start: 65, end: 73 });
  });

  it("handles a long article with repeated characters without spreading every candidate onto the stack", () => {
    expect(findCommentAnchor("a".repeat(150_000), { quote: "a", start: 1, end: 2, prefix: "b", suffix: "c" })).toBeNull();
  });
});
