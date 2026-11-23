"use client";

import React, { type ReactNode } from "react";
import { parseArticleMarkdown, type ArticleInlineToken, type CommentHighlight } from "@/lib/article-comment-text";
import styles from "./ArticleMarkdown.module.css";

interface HighlightProps {
  highlights?: CommentHighlight[];
  activeCommentId?: string | null;
  onHighlightClick?: (id: string) => void;
}

export function CommentHighlightedText({ text, offset = 0, highlights = [], activeCommentId, onHighlightClick, insideLink = false }: HighlightProps & {
  text: string; offset?: number; insideLink?: boolean;
}) {
  const ranges = highlights.filter(range => range.start < offset + text.length && range.end > offset && range.end > range.start);
  if (!ranges.length) return <>{text}</>;
  const boundaries = [...new Set([0, text.length, ...ranges.flatMap(range => [
    Math.max(0, range.start - offset), Math.min(text.length, range.end - offset),
  ])])].sort((a, b) => a - b);
  return <>{boundaries.slice(0, -1).map((start, index) => {
    const end = boundaries[index + 1]!;
    const covering = ranges.filter(range => range.start < offset + end && range.end > offset + start)
      .sort((a, b) => Number(b.id === activeCommentId) - Number(a.id === activeCommentId) || a.id.localeCompare(b.id));
    const range = covering[0];
    if (!range) return text.slice(start, end);
    const interactive = Boolean(onHighlightClick) && !insideLink;
    return <mark key={start} className={styles.highlight} data-comment-id={range.id} data-comment-ids={covering.map(item => item.id).join(" ")}
      data-active={range.id === activeCommentId ? "true" : undefined} role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined} aria-label={interactive ? `Open comment on: ${text.slice(start, end)}` : undefined}
      onClick={onHighlightClick ? event => {
        if (window.getSelection()?.isCollapsed === false) return;
        event.preventDefault(); event.stopPropagation(); onHighlightClick(range.id);
      } : undefined}
      onKeyDown={interactive ? event => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); onHighlightClick?.(range.id); }
      } : undefined}>{text.slice(start, end)}</mark>;
  })}</>;
}

/** Escaped React elements preserve the existing Markdown viewer's safe rendering. */
export function ArticleMarkdown({ source, ...highlightProps }: { source: string } & HighlightProps) {
  if (!source.trim()) return <div className="empty"><strong>No draft yet</strong><span>Generate one to see it here.</span></div>;
  const inline = (tokens: ArticleInlineToken[]): ReactNode[] => tokens.map((token, index) => {
    const contents = <CommentHighlightedText text={token.text} offset={token.start} {...highlightProps} insideLink={token.kind === "link"} />;
    switch (token.kind) {
      case "strong": return <strong key={index}>{contents}</strong>;
      case "code": return <code key={index}>{contents}</code>;
      case "em": return <em key={index}>{contents}</em>;
      case "link": {
        const href = token.href ?? "";
        const safe = /^https?:\/\//i.test(href) || href.startsWith("/");
        return safe ? <a key={index} href={href} target="_blank" rel="noopener noreferrer">{contents}</a> : <span key={index}>{contents}</span>;
      }
      default: return <CommentHighlightedText key={index} text={token.text} offset={token.start} {...highlightProps} />;
    }
  });
  return <div className="prose">{parseArticleMarkdown(source).map((block, index) => {
    if (block.kind === "list") {
      const children = block.items.map((tokens, item) => <li key={item}>{inline(tokens)}</li>);
      return block.ordered ? <ol key={index}>{children}</ol> : <ul key={index}>{children}</ul>;
    }
    if (block.kind === "heading") {
      const Tag = `h${block.level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
      return <Tag key={index}>{inline(block.tokens)}</Tag>;
    }
    if (block.kind === "blockquote") return <blockquote key={index}>{inline(block.tokens)}</blockquote>;
    return <p key={index}>{inline(block.tokens)}</p>;
  })}</div>;
}
