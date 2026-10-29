/** The same saved Markdown structure is used for generation, review, and SEO checks. */
export function extractStructure(markdown: string, title?: string, websiteUrl?: string | null): {
  headings: { level: number; text: string }[];
  internalLinks: { url: string; anchor: string }[];
  externalLinks: { url: string; anchor: string }[];
  images: { src: string; alt: string | null }[];
  hasCta: boolean;
  ctaText: string | null;
} {
  const headings: { level: number; text: string }[] = [];
  for (const match of markdown.matchAll(/^(#{1,6})\s+(.+)$/gm)) {
    headings.push({ level: match[1]!.length, text: match[2]!.trim() });
  }
  // The separately stored title is the rendered H1 unless the body already contains one.
  if (title?.trim() && !headings.some(heading => heading.level === 1)) {
    headings.unshift({ level: 1, text: title.trim() });
  }
  const images: { src: string; alt: string | null }[] = [];
  for (const match of markdown.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)) {
    images.push({ src: match[2]!.trim(), alt: match[1]!.trim() || null });
  }
  const internalLinks: { url: string; anchor: string }[] = [];
  const externalLinks: { url: string; anchor: string }[] = [];
  let siteHost: string | null = null;
  try { siteHost = websiteUrl ? new URL(websiteUrl).hostname.replace(/^www\./, "") : null; } catch { /* No site configured. */ }
  for (const match of markdown.matchAll(/(?<!!)\[([^\]]+)\]\(([^)]+)\)/g)) {
    const link = { anchor: match[1]!.trim(), url: match[2]!.trim() };
    if (/^(?:https?:)?\/\//i.test(link.url)) {
      try {
        const host = new URL(link.url, websiteUrl || "https://invalid.local").hostname.replace(/^www\./, "");
        (siteHost && host === siteHost ? internalLinks : externalLinks).push(link);
      } catch { externalLinks.push(link); }
    } else if (!/^[a-z][a-z0-9+.-]*:/i.test(link.url)) internalLinks.push(link);
  }
  const cta = /\b(book|schedule|arrange|request|contact|call|email|buy|order|get started|sign up|learn more)\b[^.!?\n]*/i.exec(markdown);
  return { headings, internalLinks, externalLinks, images, hasCta: cta !== null, ctaText: cta?.[0]?.trim().slice(0, 120) ?? null };
}
