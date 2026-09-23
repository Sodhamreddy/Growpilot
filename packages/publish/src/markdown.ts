/**
 * Markdown → HTML for CMS publishing.
 *
 * Articles are stored as markdown; WordPress wants HTML. This is a deliberately
 * small renderer rather than a dependency: the input is not arbitrary user
 * markdown, it is our own generator's output, which uses a known and narrow
 * subset. A full CommonMark implementation would carry a much larger attack
 * surface for no benefit here.
 *
 * Everything that is not recognised markup is HTML-escaped. That ordering
 * matters: escape first, then introduce tags, so generated content can never
 * inject markup into the published post.
 */

export interface RenderedPost {
  html: string;
  /** First paragraph, plain text — used as the excerpt when none is set. */
  excerpt: string;
}

const ESCAPES: [RegExp, string][] = [
  [/&/g, "&amp;"], [/</g, "&lt;"], [/>/g, "&gt;"], [/"/g, "&quot;"],
];

function escapeHtml(s: string): string {
  return ESCAPES.reduce((acc, [re, to]) => acc.replace(re, to), s);
}

/** Inline spans: links, bold, italic, code. Applied to already-escaped text. */
function inline(text: string): string {
  return text
    // Code first — its contents must not be re-processed for other markup.
    .replace(/`([^`]+)`/g, (_m, code: string) => `<code>${code}</code>`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, href: string) => {
      // Only http(s) and root-relative links survive. A `javascript:` href in
      // generated copy would otherwise become a live link in the published post.
      const safe = /^https?:\/\//i.test(href) || href.startsWith("/");
      return safe ? `<a href="${href}">${label}</a>` : label;
    })
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
}

export function renderMarkdown(markdown: string): RenderedPost {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let paragraph: string[] = [];
  let listType: "ul" | "ol" | null = null;
  let inCodeBlock = false;
  let codeLines: string[] = [];
  let firstParagraph = "";

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const text = paragraph.join(" ").trim();
    if (text) {
      if (!firstParagraph) firstParagraph = text;
      out.push(`<p>${inline(escapeHtml(text))}</p>`);
    }
    paragraph = [];
  };

  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (/^```/.test(line)) {
      if (inCodeBlock) {
        out.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
        codeLines = [];
        inCodeBlock = false;
      } else {
        flushParagraph();
        closeList();
        inCodeBlock = true;
      }
      continue;
    }
    if (inCodeBlock) {
      codeLines.push(raw);
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      closeList();
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      closeList();
      const level = heading[1]!.length;
      out.push(`<h${level}>${inline(escapeHtml(heading[2]!.trim()))}</h${level}>`);
      continue;
    }

    if (/^>\s?/.test(line)) {
      flushParagraph();
      closeList();
      out.push(`<blockquote><p>${inline(escapeHtml(line.replace(/^>\s?/, "")))}</p></blockquote>`);
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      flushParagraph();
      closeList();
      out.push("<hr />");
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      const wanted = bullet ? "ul" : "ol";
      if (listType !== wanted) {
        closeList();
        out.push(`<${wanted}>`);
        listType = wanted;
      }
      out.push(`<li>${inline(escapeHtml((bullet ?? numbered)![1]!.trim()))}</li>`);
      continue;
    }

    paragraph.push(line.trim());
  }

  if (inCodeBlock && codeLines.length > 0) {
    out.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
  }
  flushParagraph();
  closeList();

  return {
    html: out.join("\n"),
    excerpt: firstParagraph.slice(0, 300),
  };
}
