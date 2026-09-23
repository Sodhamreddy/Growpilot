import { describe, it, expect } from "vitest";
import { renderMarkdown } from "./markdown.js";

/**
 * The renderer's job is to turn our generator's markdown into post HTML without
 * letting anything through that could become live markup on the customer's own
 * website. Escaping happens before tags are introduced, and these pin that
 * ordering — it is the property that makes the whole thing safe.
 */

describe("renderMarkdown — structure", () => {
  it("renders headings at their level", () => {
    expect(renderMarkdown("## Why it matters").html).toBe("<h2>Why it matters</h2>");
    expect(renderMarkdown("#### Deep").html).toBe("<h4>Deep</h4>");
  });

  it("joins wrapped lines into one paragraph", () => {
    const { html } = renderMarkdown("First line\nsecond line\n\nNew paragraph");
    expect(html).toBe("<p>First line second line</p>\n<p>New paragraph</p>");
  });

  it("renders bullet and numbered lists", () => {
    expect(renderMarkdown("- one\n- two").html).toBe("<ul>\n<li>one</li>\n<li>two</li>\n</ul>");
    expect(renderMarkdown("1. one\n2. two").html).toBe("<ol>\n<li>one</li>\n<li>two</li>\n</ol>");
  });

  it("closes a list when the list type changes", () => {
    const { html } = renderMarkdown("- bullet\n1. numbered");
    expect(html).toContain("</ul>");
    expect(html).toContain("<ol>");
  });

  it("renders bold, italic, code and links", () => {
    expect(renderMarkdown("**bold**").html).toBe("<p><strong>bold</strong></p>");
    expect(renderMarkdown("*soft*").html).toBe("<p><em>soft</em></p>");
    expect(renderMarkdown("`code`").html).toBe("<p><code>code</code></p>");
    expect(renderMarkdown("[a](https://x.com)").html).toBe('<p><a href="https://x.com">a</a></p>');
  });

  it("renders blockquotes and horizontal rules", () => {
    expect(renderMarkdown("> quoted").html).toBe("<blockquote><p>quoted</p></blockquote>");
    expect(renderMarkdown("---").html).toBe("<hr />");
  });

  it("renders fenced code without interpreting its contents", () => {
    const { html } = renderMarkdown("```\n**not bold**\n```");
    expect(html).toBe("<pre><code>**not bold**</code></pre>");
  });

  it("takes the excerpt from the first paragraph, not a heading", () => {
    const { excerpt } = renderMarkdown("# Title\n\nThe opening line.\n\nLater text.");
    expect(excerpt).toBe("The opening line.");
  });
});

describe("renderMarkdown — nothing becomes live markup", () => {
  it("escapes HTML in body text", () => {
    const { html } = renderMarkdown("A <script>alert(1)</script> tag");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("escapes HTML inside headings and list items", () => {
    expect(renderMarkdown("## <img onerror=x>").html).toContain("&lt;img");
    expect(renderMarkdown("- <b>x</b>").html).toContain("&lt;b&gt;");
  });

  it("drops a javascript: link but keeps its text", () => {
    const { html } = renderMarkdown("[click](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("click");
  });

  it("drops a data: link but keeps its text", () => {
    const { html } = renderMarkdown("[x](data:text/html;base64,PHNjcmlwdD4=)");
    expect(html).not.toContain("data:");
    expect(html).toContain("x");
  });

  it("keeps root-relative links, which are internal links we generate", () => {
    expect(renderMarkdown("[svc](/services/seo)").html).toContain('href="/services/seo"');
  });

  it("escapes quotes so text cannot break out of an attribute", () => {
    expect(renderMarkdown('He said "hello"').html).toContain("&quot;");
  });

  it("escapes markup inside fenced code too", () => {
    const { html } = renderMarkdown("```\n<script>x</script>\n```");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>x");
  });
});

describe("renderMarkdown — edge cases", () => {
  it("returns empty html for empty input", () => {
    expect(renderMarkdown("").html).toBe("");
    expect(renderMarkdown("   \n  \n").html).toBe("");
  });

  it("handles CRLF line endings", () => {
    expect(renderMarkdown("# Title\r\n\r\nBody").html).toBe("<h1>Title</h1>\n<p>Body</p>");
  });

  it("closes an unterminated code fence rather than losing the content", () => {
    expect(renderMarkdown("```\nkept").html).toBe("<pre><code>kept</code></pre>");
  });

  it("caps the excerpt length", () => {
    expect(renderMarkdown("x".repeat(500)).excerpt).toHaveLength(300);
  });
});
