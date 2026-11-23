/** Offsets refer to displayed text, never Markdown syntax or HTML. */
export interface CommentAnchor {
  quote: string;
  prefix: string;
  suffix: string;
  start: number;
  end: number;
}

export interface CommentHighlight { id: string; start: number; end: number }
export interface ArticleInlineToken {
  kind: "text" | "strong" | "em" | "code" | "link";
  text: string;
  href?: string;
  start: number;
  end: number;
}
export type ArticleBlock =
  | { kind: "paragraph" | "blockquote"; tokens: ArticleInlineToken[] }
  | { kind: "heading"; level: number; tokens: ArticleInlineToken[] }
  | { kind: "list"; ordered: boolean; items: ArticleInlineToken[][] };

/** The viewer and API share this parser, so formatted text has identical offsets. */
export function parseArticleMarkdown(source: string): ArticleBlock[] {
  const blocks: ArticleBlock[] = [];
  let offset = 0;
  const inline = (text: string): ArticleInlineToken[] => {
    const tokens: ArticleInlineToken[] = [];
    const append = (kind: ArticleInlineToken["kind"], text: string, href?: string) => {
      tokens.push({ kind, text, ...(href === undefined ? {} : { href }), start: offset, end: offset + text.length });
      offset += text.length;
    };
    let last = 0;
    for (const match of text.matchAll(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g)) {
      const at = match.index!;
      if (at > last) append("text", text.slice(last, at));
      const token = match[0];
      if (token.startsWith("**")) append("strong", token.slice(2, -2));
      else if (token.startsWith("`")) append("code", token.slice(1, -1));
      else if (token.startsWith("[")) {
        const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token)!;
        append("link", link[1]!, link[2]!);
      } else append("em", token.slice(1, -1));
      last = at + token.length;
    }
    if (last < text.length) append("text", text.slice(last));
    return tokens;
  };
  let paragraph: string[] = [];
  let list: string[] = [];
  let ordered = false;
  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", tokens: inline(paragraph.join(" ")) });
    paragraph = [];
  };
  const flushList = () => {
    if (list.length) blocks.push({ kind: "list", ordered, items: list.map(inline) });
    list = [];
  };
  for (const raw of source.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) { flushParagraph(); flushList(); continue; }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph(); flushList();
      blocks.push({ kind: "heading", level: Math.min(heading[1]!.length, 6), tokens: inline(heading[2]!.trim()) });
      continue;
    }
    if (/^>\s?/.test(line)) {
      flushParagraph(); flushList();
      blocks.push({ kind: "blockquote", tokens: inline(line.replace(/^>\s?/, "")) });
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      const wantsOrdered = Boolean(numbered);
      if (list.length && wantsOrdered !== ordered) flushList();
      ordered = wantsOrdered;
      list.push((bullet ?? numbered)![1]!.trim());
      continue;
    }
    paragraph.push(line.trim());
  }
  flushParagraph(); flushList();
  return blocks;
}

export function getArticleBodySource(title: string, bodyMarkdown: string): string {
  return bodyMarkdown.replace(/\r\n/g, "\n").replace(/^#[ \t]+([^\n]+)(?:\n+|$)/, (heading, text: string) =>
    text.trim() === title.trim() ? "" : heading);
}

export function getArticleBodyText(bodySource: string): string {
  return parseArticleMarkdown(bodySource).flatMap(block => block.kind === "list" ? block.items.flat() : block.tokens)
    .map(token => token.text).join("");
}

/** No invented separators: this matches title + body DOM textContent exactly. */
export function getArticleCommentText(title: string, bodyMarkdown: string): string {
  return title + getArticleBodyText(getArticleBodySource(title, bodyMarkdown));
}

/**
 * Where the title, each heading, paragraph and list item begin in the comment text.
 *
 * The text has no separators between blocks ("…gums bleedPlaque is…"), so these
 * are the only way to tell that a word ends at a block's edge.
 */
export function getArticleBlockStarts(title: string, bodyMarkdown: string): Set<number> {
  const starts = new Set<number>([0, title.length]);
  for (const block of parseArticleMarkdown(getArticleBodySource(title, bodyMarkdown))) {
    for (const tokens of block.kind === "list" ? block.items : [block.tokens]) {
      if (tokens[0]) starts.add(title.length + tokens[0].start);
    }
  }
  return starts;
}

export function createCommentAnchor(text: string, start: number, end: number): CommentAnchor {
  // Do not split an emoji surrogate pair at the context boundary: PostgreSQL
  // stores UTF-8, so an isolated UTF-16 surrogate would not round-trip intact.
  const prefix = text.slice(Math.max(0, start - 64), start).replace(/^[\uDC00-\uDFFF]/, "");
  const suffix = text.slice(end, end + 64).replace(/[\uD800-\uDBFF]$/, "");
  return { quote: text.slice(start, end), prefix, suffix, start, end };
}

/**
 * Reattach only when the original passage and its context identify one place.
 * A removed or ambiguous passage stays visible in the discussion as detached.
 */
export function findCommentAnchor(text: string, anchor: CommentAnchor): { start: number; end: number } | null {
  if (!anchor.quote || !Number.isSafeInteger(anchor.start) || !Number.isSafeInteger(anchor.end)
    || anchor.start < 0 || anchor.end - anchor.start !== anchor.quote.length) return null;
  const candidates: { start: number; end: number; context: number }[] = [];
  let position = text.indexOf(anchor.quote);
  while (position !== -1) {
    const end = position + anchor.quote.length;
    const prefixMatches = anchor.prefix.length > 0 && text.slice(Math.max(0, position - anchor.prefix.length), position) === anchor.prefix;
    const suffixMatches = anchor.suffix.length > 0 && text.slice(end, end + anchor.suffix.length) === anchor.suffix;
    candidates.push({ start: position, end, context: Number(prefixMatches) + Number(suffixMatches) });
    position = text.indexOf(anchor.quote, position + 1);
  }
  const hasContext = Boolean(anchor.prefix || anchor.suffix);
  if (!hasContext) return candidates.length === 1 ? { start: candidates[0]!.start, end: candidates[0]!.end } : null;
  const strongest = candidates.reduce((best, candidate) => Math.max(best, candidate.context), 0);
  if (strongest === 0) return null;
  const matches = candidates.filter(candidate => candidate.context === strongest);
  if (matches.length !== 1) return null;
  return { start: matches[0]!.start, end: matches[0]!.end };
}
