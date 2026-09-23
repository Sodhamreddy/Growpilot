import { countWords } from "./parse/html.js";

/**
 * Explainable weighted SEO score — spec §7.1.
 *
 * The weights below are exactly the spec's table and sum to 100. Every
 * component returns its sub-score together with the reasons that produced it,
 * so the UI can always answer "why is this 72?" — spec §7 requires
 * deterministic rules for measurable checks and reserves the LLM for semantic
 * judgement, which enters here as a pre-computed `semantic` input rather than
 * being called from inside the scorer. That keeps this function pure and
 * unit-testable.
 */

export const SCORE_WEIGHTS = {
  technical: 20,
  contentQuality: 25,
  onPage: 15,
  internalLinking: 10,
  schema: 10,
  authority: 10,
  conversion: 10,
} as const;

export type ScoreKey = keyof typeof SCORE_WEIGHTS;

export interface ScoreComponent {
  key: ScoreKey;
  label: string;
  weight: number;
  /** 0–100 for this component alone. */
  score: number;
  reasons: string[];
}

export interface ScoreResult {
  /** 0–100 weighted total. */
  total: number;
  components: ScoreComponent[];
}

/** Everything the scorer needs. No I/O happens inside the scorer. */
export interface ScoreInput {
  title: string | null;
  metaDescription: string | null;
  bodyMarkdown: string;
  primaryKeyword: string;
  secondaryKeywords: string[];
  headings: { level: number; text: string }[];
  internalLinks: { url: string; anchor: string }[];
  externalLinks: { url: string; anchor: string }[];
  schemaJsonLd: unknown;
  images: { src: string; alt: string | null }[];
  hasCta: boolean;
  ctaText?: string | null;
  /** LLM-produced semantic judgement, 0–100 each (spec §7 "LLM for semantic quality"). */
  semantic?: {
    intentAlignment?: number;
    topicalDepth?: number;
    originality?: number;
  };
  /** Deterministic technical facts supplied by the audit/publish target. */
  technical?: {
    https?: boolean;
    canonicalPresent?: boolean;
    indexable?: boolean;
    slugClean?: boolean;
  };
  /** Evidence-backed claims ratio from the grounding gate, 0–1. */
  groundedClaimRatio?: number;
}

const LABELS: Record<ScoreKey, string> = {
  technical: "Technical health",
  contentQuality: "Intent & content quality",
  onPage: "On-page SEO",
  internalLinking: "Internal linking",
  schema: "Schema",
  authority: "Authority & source signals",
  conversion: "Conversion & CTA",
};

export function scoreArticle(input: ScoreInput): ScoreResult {
  const components: ScoreComponent[] = [
    scoreTechnical(input),
    scoreContentQuality(input),
    scoreOnPage(input),
    scoreInternalLinking(input),
    scoreSchema(input),
    scoreAuthority(input),
    scoreConversion(input),
  ];

  const total = components.reduce((sum, c) => sum + (c.score * c.weight) / 100, 0);
  return { total: round1(total), components };
}

// ─── Components ─────────────────────────────────────────────────────────────

function scoreTechnical(input: ScoreInput): ScoreComponent {
  const reasons: string[] = [];
  const t = input.technical ?? {};
  let score = 100;

  if (t.https === false) {
    score -= 40;
    reasons.push("Target URL is not served over HTTPS.");
  }
  if (t.indexable === false) {
    score -= 40;
    reasons.push("Page is marked noindex and cannot rank.");
  }
  if (t.canonicalPresent === false) {
    score -= 15;
    reasons.push("No canonical URL is set.");
  }
  if (t.slugClean === false) {
    score -= 10;
    reasons.push("Slug contains stop words, dates or query parameters.");
  }
  if (reasons.length === 0) reasons.push("No technical blockers detected.");

  return component("technical", clamp(score), reasons);
}

function scoreContentQuality(input: ScoreInput): ScoreComponent {
  const reasons: string[] = [];
  const words = countWords(input.bodyMarkdown);
  let score = 0;

  // Depth (35 points). Thin content is the single biggest quality signal.
  if (words >= 1200) { score += 35; reasons.push(`Substantial depth (${words} words).`); }
  else if (words >= 800) { score += 28; reasons.push(`Reasonable depth (${words} words).`); }
  else if (words >= 500) { score += 18; reasons.push(`Moderate depth (${words} words); consider expanding.`); }
  else { score += 6; reasons.push(`Thin content (${words} words) — likely to underperform.`); }

  // Structure (15 points).
  const h2Count = input.headings.filter((h) => h.level === 2).length;
  if (h2Count >= 3) { score += 15; reasons.push(`Well sectioned (${h2Count} H2s).`); }
  else if (h2Count >= 1) { score += 8; reasons.push(`Only ${h2Count} H2 section(s).`); }
  else { reasons.push("No H2 sections — the article has no scannable structure."); }

  // Semantic judgement (50 points), supplied by the LLM pass.
  const sem = input.semantic;
  if (sem) {
    const intent = clamp(sem.intentAlignment ?? 0);
    const depth = clamp(sem.topicalDepth ?? 0);
    const originality = clamp(sem.originality ?? 0);
    score += (intent * 0.25 + depth * 0.15 + originality * 0.1);
    reasons.push(
      `Semantic review — intent ${intent}/100, topical depth ${depth}/100, originality ${originality}/100.`,
    );
  } else {
    // Without the semantic pass the component is capped, and says so, rather
    // than silently scoring as if the check had passed.
    reasons.push("Semantic quality review has not run; this component is capped at 50.");
  }

  return component("contentQuality", clamp(score), reasons);
}

function scoreOnPage(input: ScoreInput): ScoreComponent {
  const reasons: string[] = [];
  let score = 0;
  const kw = input.primaryKeyword.toLowerCase().trim();
  const title = (input.title ?? "").toLowerCase();
  const meta = input.metaDescription ?? "";

  // Title (35).
  if (!input.title) {
    reasons.push("No title set.");
  } else {
    const len = input.title.length;
    if (kw && title.includes(kw)) { score += 20; reasons.push("Primary keyword appears in the title."); }
    else if (kw) { reasons.push("Primary keyword is missing from the title."); }
    if (len >= 30 && len <= 60) { score += 15; reasons.push(`Title length is ${len} characters (ideal 30–60).`); }
    else { score += 5; reasons.push(`Title is ${len} characters; aim for 30–60 to avoid truncation.`); }
  }

  // Meta description (25).
  if (!meta) {
    reasons.push("No meta description set.");
  } else {
    if (meta.length >= 120 && meta.length <= 160) { score += 15; reasons.push(`Meta description is ${meta.length} characters (ideal 120–160).`); }
    else { score += 6; reasons.push(`Meta description is ${meta.length} characters; aim for 120–160.`); }
    if (kw && meta.toLowerCase().includes(kw)) { score += 10; reasons.push("Primary keyword appears in the meta description."); }
  }

  // H1 (15).
  const h1 = input.headings.find((h) => h.level === 1);
  if (!h1) reasons.push("No H1 heading.");
  else if (kw && h1.text.toLowerCase().includes(kw)) { score += 15; reasons.push("Primary keyword appears in the H1."); }
  else { score += 7; reasons.push("H1 present but does not contain the primary keyword."); }

  // Keyword usage in body (15) — rewards presence, penalises stuffing.
  const body = input.bodyMarkdown.toLowerCase();
  const words = Math.max(1, countWords(input.bodyMarkdown));
  const occurrences = kw ? countOccurrences(body, kw) : 0;
  const density = (occurrences * kw.split(/\s+/).length) / words;
  if (occurrences === 0 && kw) {
    reasons.push("Primary keyword does not appear in the body.");
  } else if (density > 0.03) {
    score += 4;
    reasons.push(`Keyword density is ${(density * 100).toFixed(1)}% — this reads as keyword stuffing.`);
  } else if (density >= 0.003) {
    score += 15;
    reasons.push(`Keyword density is ${(density * 100).toFixed(1)}% (healthy range).`);
  } else {
    score += 8;
    reasons.push(`Keyword density is ${(density * 100).toFixed(1)}% — slightly low.`);
  }

  // Secondary coverage (10).
  const covered = input.secondaryKeywords.filter((t) => body.includes(t.toLowerCase()));
  if (input.secondaryKeywords.length > 0) {
    const ratio = covered.length / input.secondaryKeywords.length;
    score += Math.round(ratio * 10);
    reasons.push(`${covered.length} of ${input.secondaryKeywords.length} secondary terms are covered.`);
  } else {
    score += 10;
  }

  return component("onPage", clamp(score), reasons);
}

function scoreInternalLinking(input: ScoreInput): ScoreComponent {
  const reasons: string[] = [];
  const count = input.internalLinks.length;
  let score: number;

  if (count === 0) { score = 0; reasons.push("No internal links — this page is orphaned from the site graph."); }
  else if (count < 3) { score = 45; reasons.push(`Only ${count} internal link(s); 3–8 is typical for an article.`); }
  else if (count <= 10) { score = 100; reasons.push(`${count} internal links.`); }
  else { score = 70; reasons.push(`${count} internal links may dilute relevance.`); }

  const generic = input.internalLinks.filter((l) =>
    /^(click here|here|read more|learn more|this|link)$/i.test(l.anchor.trim()),
  );
  if (generic.length > 0) {
    score -= Math.min(25, generic.length * 10);
    reasons.push(`${generic.length} link(s) use non-descriptive anchor text.`);
  }

  return component("internalLinking", clamp(score), reasons);
}

function scoreSchema(input: ScoreInput): ScoreComponent {
  const reasons: string[] = [];
  const schema = input.schemaJsonLd;

  if (!schema || (Array.isArray(schema) && schema.length === 0)) {
    return component("schema", 0, ["No JSON-LD structured data is present."]);
  }

  const entities = (Array.isArray(schema) ? schema : [schema]).filter(
    (e): e is Record<string, unknown> => typeof e === "object" && e !== null,
  );
  let score = 40;
  reasons.push(`${entities.length} structured-data entit${entities.length === 1 ? "y" : "ies"} present.`);

  const types = entities.map((e) => String(e["@type"] ?? "")).filter(Boolean);
  if (types.length === 0) {
    reasons.push("Structured data has no @type — it will be ignored by search engines.");
    return component("schema", clamp(score - 25), reasons);
  }

  if (types.some((t) => /Article|BlogPosting|NewsArticle/i.test(t))) {
    score += 30;
    const article = entities.find((e) => /Article|BlogPosting|NewsArticle/i.test(String(e["@type"])))!;
    const required = ["headline", "datePublished", "author"];
    const missing = required.filter((k) => !(k in article));
    if (missing.length === 0) { score += 20; reasons.push("Article schema has all required properties."); }
    else { reasons.push(`Article schema is missing: ${missing.join(", ")}.`); }
  } else {
    reasons.push(`Present types (${types.join(", ")}) do not include an Article type.`);
  }

  if (types.some((t) => /BreadcrumbList/i.test(t))) {
    score += 10;
    reasons.push("BreadcrumbList present.");
  }

  return component("schema", clamp(score), reasons);
}

function scoreAuthority(input: ScoreInput): ScoreComponent {
  const reasons: string[] = [];
  let score = 0;

  const grounded = input.groundedClaimRatio;
  if (grounded === undefined) {
    reasons.push("Grounding check has not run; evidence backing is unverified.");
    score += 25;
  } else {
    score += Math.round(grounded * 60);
    reasons.push(`${Math.round(grounded * 100)}% of checkable claims map to evidence.`);
  }

  const external = input.externalLinks.length;
  if (external === 0) { reasons.push("No outbound citations."); }
  else if (external <= 6) { score += 40; reasons.push(`${external} outbound citation(s).`); }
  else { score += 25; reasons.push(`${external} outbound links — more than typical for an article.`); }

  return component("authority", clamp(score), reasons);
}

function scoreConversion(input: ScoreInput): ScoreComponent {
  const reasons: string[] = [];
  let score = 0;

  if (!input.hasCta) {
    return component("conversion", 0, ["No call to action — the page cannot convert."]);
  }
  score += 60;
  reasons.push("Call to action is present.");

  const cta = input.ctaText?.trim() ?? "";
  if (cta.length === 0) {
    reasons.push("CTA text is empty.");
  } else if (/^(click here|submit|go)$/i.test(cta)) {
    score += 10;
    reasons.push(`CTA text "${cta}" is generic.`);
  } else {
    score += 25;
    reasons.push(`CTA text is specific: "${cta}".`);
  }

  const withAlt = input.images.filter((i) => i.alt && i.alt.trim().length > 0).length;
  if (input.images.length > 0) {
    const ratio = withAlt / input.images.length;
    score += Math.round(ratio * 15);
    reasons.push(`${withAlt} of ${input.images.length} images have alt text.`);
  } else {
    score += 15;
  }

  return component("conversion", clamp(score), reasons);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function component(key: ScoreKey, score: number, reasons: string[]): ScoreComponent {
  return { key, label: LABELS[key], weight: SCORE_WEIGHTS[key], score: round1(score), reasons };
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, n));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}
