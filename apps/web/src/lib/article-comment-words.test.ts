// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { wordEndShift, wordStartShift } from "./article-comment-selection";
import { createCommentAnchor, getArticleBlockStarts, getArticleCommentText } from "./article-comment-text";
import { quoteLabel } from "@/components/ArticleComments";

describe("comment selections snap to whole words", () => {
  const node = document.createTextNode("A senior needs 24 hour home care.");

  it("widens a selection that starts or ends inside a word", () => {
    const start = node.nodeValue!.indexOf("enior");
    expect(wordStartShift(node, start)).toBe(1); // back to "senior"
    const end = node.nodeValue!.indexOf("me care");
    expect(wordEndShift(node, end)).toBe(2); // on to "home"
  });

  it("leaves a selection that already sits on word edges alone", () => {
    expect(wordStartShift(node, node.nodeValue!.indexOf("senior"))).toBe(0);
    expect(wordEndShift(node, node.nodeValue!.indexOf(" needs"))).toBe(0);
    expect(wordEndShift(node, node.nodeValue!.length)).toBe(0);
  });
});

describe("quote shown on a comment card", () => {
  const text = "A senior needs 24 hour home care.";

  it("marks a passage that was cut inside a word", () => {
    const anchor = createCommentAnchor(text, text.indexOf("enior"), text.indexOf("me care"));
    expect(quoteLabel(anchor)).toBe("…enior needs 24 hour ho…");
  });

  it("does not mark a passage that starts a paragraph right after a heading", () => {
    const body = "## Why gums bleed\n\nPlaque is a sticky film.";
    const full = getArticleCommentText("Title", body);
    const start = full.indexOf("Plaque"), end = full.indexOf(" film");
    const anchor = createCommentAnchor(full, start, end);
    expect(quoteLabel(anchor)).toBe("…Plaque is a sticky"); // the joined text alone cannot tell
    expect(quoteLabel(anchor, { start, end, blockStarts: getArticleBlockStarts("Title", body) })).toBe("Plaque is a sticky");
  });

  it("shows whole-word passages as they are", () => {
    const anchor = createCommentAnchor(text, text.indexOf("senior"), text.indexOf(" care"));
    expect(quoteLabel(anchor)).toBe("senior needs 24 hour home");
  });
});
