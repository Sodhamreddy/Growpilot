/**
 * Deterministic SEO checks — spec §7 "Use deterministic rules for measurable
 * checks."
 *
 * These run without a model and produce the findings the SEO quality gate
 * (spec §15.1) turns into a pass/warn/fail verdict. Every finding carries a
 * suggestion so the UI can offer a fix action (spec §10.3).
 */

export interface CheckFinding {
  severity: "info" | "warn" | "error";
  message: string;
  suggestion?: string;
  location?: string;
}

export interface SeoCheckInput {
  title: string | null;
  metaDescription: string | null;
  slug: string;
  bodyMarkdown: string;
  primaryKeyword: string;
  headings: { level: number; text: string }[];
  images: { src: string; alt: string | null }[];
  internalLinks: { url: string; anchor: string }[];
}

const TITLE_MIN = 30;
const TITLE_MAX = 60;
const META_MIN = 120;
const META_MAX = 160;

export function runSeoChecks(input: SeoCheckInput): CheckFinding[] {
  const findings: CheckFinding[] = [];
  const kw = input.primaryKeyword.trim().toLowerCase();

  // ── Title ──
  if (!input.title?.trim()) {
    findings.push({
      severity: "error",
      message: "The article has no title.",
      suggestion: "Add a title containing the primary keyword.",
      location: "title",
    });
  } else {
    const len = input.title.length;
    if (len < TITLE_MIN) {
      findings.push({
        severity: "warn",
        message: `Title is ${len} characters — shorter than the ${TITLE_MIN}-character minimum.`,
        suggestion: `Expand the title to ${TITLE_MIN}–${TITLE_MAX} characters.`,
        location: "title",
      });
    } else if (len > TITLE_MAX) {
      findings.push({
        severity: "warn",
        message: `Title is ${len} characters and will be truncated in search results.`,
        suggestion: `Trim the title to ${TITLE_MAX} characters or fewer.`,
        location: "title",
      });
    }
    if (kw && !input.title.toLowerCase().includes(kw)) {
      findings.push({
        severity: "warn",
        message: `Title does not contain the primary keyword "${input.primaryKeyword}".`,
        suggestion: "Work the primary keyword into the title, ideally near the start.",
        location: "title",
      });
    }
  }

  // ── Meta description ──
  if (!input.metaDescription?.trim()) {
    findings.push({
      severity: "error",
      message: "The article has no meta description.",
      suggestion: `Write a ${META_MIN}–${META_MAX} character summary that includes the primary keyword.`,
      location: "metaDescription",
    });
  } else {
    const len = input.metaDescription.length;
    if (len < META_MIN || len > META_MAX) {
      findings.push({
        severity: "warn",
        message: `Meta description is ${len} characters (recommended ${META_MIN}–${META_MAX}).`,
        suggestion: len < META_MIN ? "Expand the description." : "Trim the description.",
        location: "metaDescription",
      });
    }
  }

  // ── Headings ──
  const h1s = input.headings.filter((h) => h.level === 1);
  if (h1s.length === 0) {
    findings.push({
      severity: "error",
      message: "The article has no H1 heading.",
      suggestion: "Add a single H1 that states the article's subject.",
      location: "headings",
    });
  } else if (h1s.length > 1) {
    findings.push({
      severity: "warn",
      message: `The article has ${h1s.length} H1 headings.`,
      suggestion: "Keep exactly one H1 and demote the rest to H2.",
      location: "headings",
    });
  }

  if (input.headings.filter((h) => h.level === 2).length === 0) {
    findings.push({
      severity: "warn",
      message: "The article has no H2 sections.",
      suggestion: "Break the body into scannable H2 sections.",
      location: "headings",
    });
  }

  for (const skip of findHeadingLevelSkips(input.headings)) {
    findings.push({
      severity: "info",
      message: `Heading level jumps from H${skip.from} to H${skip.to} at "${skip.text}".`,
      suggestion: "Use sequential heading levels so the document outline is valid.",
      location: "headings",
    });
  }

  // ── Slug ──
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.slug)) {
    findings.push({
      severity: "warn",
      message: `Slug "${input.slug}" is not lowercase-hyphenated.`,
      suggestion: "Use lowercase words separated by single hyphens.",
      location: "slug",
    });
  }
  if (input.slug.length > 75) {
    findings.push({
      severity: "info",
      message: `Slug is ${input.slug.length} characters.`,
      suggestion: "Shorten the slug to roughly 3–5 meaningful words.",
      location: "slug",
    });
  }
  if (kw) {
    const kwSlug = kw.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (kwSlug && !input.slug.includes(kwSlug.split("-")[0]!)) {
      findings.push({
        severity: "info",
        message: "Slug does not reflect the primary keyword.",
        suggestion: `Consider a slug based on "${kwSlug}".`,
        location: "slug",
      });
    }
  }

  // ── Images ──
  const missingAlt = input.images.filter((i) => !i.alt?.trim());
  if (missingAlt.length > 0) {
    findings.push({
      severity: "warn",
      message: `${missingAlt.length} of ${input.images.length} images have no alt text.`,
      suggestion: "Describe each image for screen readers and image search.",
      location: "images",
    });
  }

  // ── Links ──
  if (input.internalLinks.length === 0) {
    findings.push({
      severity: "warn",
      message: "The article has no internal links.",
      suggestion: "Link to 3–5 related pages so the article joins the site graph.",
      location: "links",
    });
  }
  const generic = input.internalLinks.filter((l) =>
    /^(click here|here|read more|learn more|this|link)$/i.test(l.anchor.trim()),
  );
  if (generic.length > 0) {
    findings.push({
      severity: "info",
      message: `${generic.length} internal link(s) use generic anchor text.`,
      suggestion: 'Replace anchors like "click here" with the target page\'s topic.',
      location: "links",
    });
  }

  // ── Keyword stuffing ──
  const words = input.bodyMarkdown.toLowerCase().match(/[a-z0-9']+/g) ?? [];
  if (kw && words.length > 0) {
    const kwWordCount = kw.split(/\s+/).length;
    const occurrences = countPhrase(words, kw.split(/\s+/));
    const density = (occurrences * kwWordCount) / words.length;
    if (density > 0.03) {
      findings.push({
        severity: "error",
        message: `Keyword density is ${(density * 100).toFixed(1)}% — this reads as keyword stuffing.`,
        suggestion: "Reduce repetition and use natural variations instead.",
        location: "body",
      });
    } else if (occurrences === 0) {
      findings.push({
        severity: "warn",
        message: `The primary keyword "${input.primaryKeyword}" does not appear in the body.`,
        suggestion: "Use the keyword naturally in the opening and at least one section.",
        location: "body",
      });
    }
  }

  return findings;
}

/** Verdict mapping used by the SEO quality gate. */
export function verdictFor(findings: CheckFinding[]): "pass" | "warn" | "fail" {
  if (findings.some((f) => f.severity === "error")) return "fail";
  if (findings.some((f) => f.severity === "warn")) return "warn";
  return "pass";
}

function findHeadingLevelSkips(
  headings: { level: number; text: string }[],
): { from: number; to: number; text: string }[] {
  const skips: { from: number; to: number; text: string }[] = [];
  for (let i = 1; i < headings.length; i++) {
    const prev = headings[i - 1]!;
    const curr = headings[i]!;
    if (curr.level > prev.level + 1) {
      skips.push({ from: prev.level, to: curr.level, text: curr.text });
    }
  }
  return skips;
}

function countPhrase(words: string[], phrase: string[]): number {
  if (phrase.length === 0) return 0;
  let count = 0;
  for (let i = 0; i + phrase.length <= words.length; i++) {
    let match = true;
    for (let j = 0; j < phrase.length; j++) {
      if (words[i + j] !== phrase[j]) {
        match = false;
        break;
      }
    }
    if (match) count++;
  }
  return count;
}
