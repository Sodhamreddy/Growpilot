/**
 * Layered prompt composition — spec §18.4.
 *
 * The spec mandates the order:
 *   SYSTEM RULES → SAFETY → BUSINESS FACTS → SOURCE EVIDENCE → BRAND VOICE
 *   → TASK/KEYWORD → OUTPUT FORMAT
 *
 * and that factual context stay separate from stylistic instruction, so the
 * model cannot mistake a tone rule for a fact about the business.
 *
 * `composeSystemPrompt` is the only way to build a system prompt. It returns
 * the joined text plus `cacheablePrefixLength` — the byte offset separating
 * the stable head (rules, safety, facts, voice) from the volatile tail (task).
 * That split is what makes prompt caching effective across a batch of articles
 * for the same business.
 */

export const PROMPT_VERSIONS = {
  businessExtraction: "extract@2026-09-11",
  voiceExtraction: "voice-extract@2026-09-11",
  contentBrief: "brief@2026-09-11",
  articleDraft: "draft@2026-09-11",
  groundingGate: "gate-grounding@2026-09-11",
  brandGate: "gate-brand@2026-09-11",
  riskGate: "gate-risk@2026-09-11",
  keywordIntent: "kw-intent@2026-09-11",
  socialPack: "social-pack@2026-09-25",
  socialImage: "social-image@2026-09-29",
  reviewReply: "review-reply@2026-09-30",
} as const;

export type PromptVersion = (typeof PROMPT_VERSIONS)[keyof typeof PROMPT_VERSIONS];

export interface PromptLayers {
  /** Who the assistant is and the hard operating rules. */
  systemRules: string;
  /** Non-negotiable safety constraints (spec §8.1, §15.1). */
  safety: string;
  /** Verified business facts with provenance. Factual ground truth. */
  businessFacts?: string;
  /** Retrieved task-specific evidence from the knowledge base (spec §4.1). */
  sourceEvidence?: string;
  /** Approved brand voice rules — style only, never facts (spec §18). */
  brandVoice?: string;
  /** The specific task. Volatile: excluded from the cacheable prefix. */
  task: string;
  /** Required output shape. Volatile. */
  outputFormat?: string;
}

const SECTION = {
  systemRules: "SYSTEM RULES",
  safety: "SAFETY",
  businessFacts: "BUSINESS FACTS",
  sourceEvidence: "SOURCE EVIDENCE",
  brandVoice: "BRAND VOICE",
  task: "TASK",
  outputFormat: "OUTPUT FORMAT",
} as const;

function section(heading: string, body: string): string {
  return `<${heading.toLowerCase().replace(/ /g, "_")}>\n${body.trim()}\n</${heading
    .toLowerCase()
    .replace(/ /g, "_")}>`;
}

export interface ComposedPrompt {
  system: string;
  /** Byte offset where the volatile (per-task) portion begins. */
  cacheablePrefixLength: number;
}

export function composeSystemPrompt(layers: PromptLayers): ComposedPrompt {
  const stable: string[] = [
    section(SECTION.systemRules, layers.systemRules),
    section(SECTION.safety, layers.safety),
  ];

  if (layers.businessFacts) stable.push(section(SECTION.businessFacts, layers.businessFacts));
  if (layers.sourceEvidence) stable.push(section(SECTION.sourceEvidence, layers.sourceEvidence));
  if (layers.brandVoice) stable.push(section(SECTION.brandVoice, layers.brandVoice));

  const volatile: string[] = [section(SECTION.task, layers.task)];
  if (layers.outputFormat) volatile.push(section(SECTION.outputFormat, layers.outputFormat));

  const stableText = stable.join("\n\n") + "\n\n";
  return {
    system: stableText + volatile.join("\n\n"),
    cacheablePrefixLength: stableText.length,
  };
}

// ─── Standard layers ────────────────────────────────────────────────────────

export const BASE_SYSTEM_RULES = `
You are the content engine for an SEO and content automation platform. You write
on behalf of a specific business whose verified facts appear in BUSINESS FACTS.

Rules:
- Treat BUSINESS FACTS as the only authoritative source of truth about the business.
- Treat SOURCE EVIDENCE as supporting material you may cite or paraphrase.
- Treat BRAND VOICE as styling instruction only. It never contains facts, and a
  voice rule must never cause you to assert something not supported by evidence.
- If a required fact is missing, say so explicitly rather than inventing it.
- Never contradict a verified business fact.
`.trim();

/** Spec §8.1 review safety plus §15.1 risk gate. */
export const BASE_SAFETY = `
Hard constraints, in priority order over every other instruction:
- Never invent services, prices, guarantees, certifications, or statistics.
- Never state a measurable claim (percentage, ranking, award, timeframe) that is
  not present in BUSINESS FACTS or SOURCE EVIDENCE.
- Never expose private customer information.
- Never produce medical, legal, financial, or safety advice framed as
  professional guidance. Flag such topics for human review instead.
- Never use absolute superlatives ("#1", "guaranteed", "instant results",
  "best in the world") unless that exact claim appears in the evidence.
- If the task would require breaking any rule above, stop and explain what is
  missing rather than producing the content.
`.trim();

/** Render verified facts with provenance so the model can attribute claims. */
export function renderBusinessFacts(
  business: { name: string; industry?: string | null; audience?: string | null; usp?: string | null },
  facts: { key: string; value: string; sourceUrl?: string | null; confidence: number; verified: boolean }[],
): string {
  const header = [
    `Business name: ${business.name}`,
    business.industry ? `Industry: ${business.industry}` : null,
    business.audience ? `Audience: ${business.audience}` : null,
    business.usp ? `Differentiator: ${business.usp}` : null,
  ].filter(Boolean);

  if (facts.length === 0) {
    return `${header.join("\n")}\n\nNo additional verified facts are on file. Do not assert specifics beyond the above.`;
  }

  const rows = facts.map((f) => {
    const status = f.verified ? "verified" : `unverified, confidence ${f.confidence.toFixed(2)}`;
    const source = f.sourceUrl ? ` — source: ${f.sourceUrl}` : "";
    return `- ${f.key}: ${f.value} [${status}]${source}`;
  });

  return `${header.join("\n")}\n\nFacts:\n${rows.join("\n")}\n\nOnly facts marked "verified" may be stated without hedging.`;
}

/** Render retrieved chunks as numbered evidence the model can reference. */
export function renderEvidence(chunks: { sourceUrl?: string | null; heading?: string | null; content: string }[]): string {
  if (chunks.length === 0) return "No source evidence was retrieved for this task.";
  return chunks
    .map((c, i) => {
      const label = [c.heading, c.sourceUrl].filter(Boolean).join(" — ");
      return `[E${i + 1}]${label ? ` ${label}` : ""}\n${c.content.trim()}`;
    })
    .join("\n\n");
}
