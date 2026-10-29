import type { TenantContext } from "@ob/core";
import type { Gateway } from "@ob/ai";
import {
  composeSystemPrompt, BASE_SYSTEM_RULES, BASE_SAFETY,
  renderBusinessFacts, renderEvidence, PROMPT_VERSIONS,
} from "@ob/ai";
import type { ContentBrief } from "@ob/db";

/**
 * Content brief generation — spec §6.3 pipeline stage "brief".
 *
 * The brief is what the writer (model or human) works from. It is stored on the
 * topic so a draft can be regenerated later against the same brief and the
 * difference attributed to the model rather than to a moved target.
 */

const BRIEF_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["angle", "audience", "searchIntent", "outline", "mustCoverFacts", "targetWordCount", "ctaGuidance"],
  properties: {
    angle: { type: "string" },
    audience: { type: "string" },
    searchIntent: { type: "string" },
    outline: {
      type: "array",
      minItems: 3,
      maxItems: 14,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["heading", "level", "guidance"],
        properties: {
          heading: { type: "string" },
          level: { type: "integer", minimum: 2, maximum: 4 },
          guidance: { type: "string" },
        },
      },
    },
    mustCoverFacts: { type: "array", maxItems: 12, items: { type: "string" } },
    targetWordCount: { type: "integer", minimum: 400, maximum: 4000 },
    ctaGuidance: { type: "string" },
  },
} as const;

export interface GenerateBriefInput {
  business: { name: string; industry?: string | null; audience?: string | null; usp?: string | null };
  facts: { key: string; value: string; sourceUrl?: string | null; confidence: number; verified: boolean }[];
  evidence: { sourceUrl?: string | null; heading?: string | null; content: string }[];
  topicTitle: string;
  primaryKeyword: string;
  secondaryKeywords: string[];
  intent: string;
  /** Existing site pages this article should link to (spec §6.3 "internal links"). */
  internalLinkCandidates: { url: string; title: string }[];
  /** Editorial direction supplied by the user, never treated as source evidence. */
  instructions?: string;
  previousBrief?: ContentBrief;
}

export async function generateBrief(
  gateway: Gateway,
  ctx: TenantContext,
  input: GenerateBriefInput,
): Promise<ContentBrief> {
  const { system, cacheablePrefixLength } = composeSystemPrompt({
    systemRules: `${BASE_SYSTEM_RULES}

You are an SEO editor writing a brief for an article that has not been written
yet. The brief tells the writer what to cover and why, not what to say verbatim.

Rules:
- The outline must serve the stated search intent, not the business's sales goals.
- "mustCoverFacts" may only reference facts present in BUSINESS FACTS.
- Target word count should match what the intent needs, not a fixed house length.
- Do not write the article. Write the brief.`,
    safety: BASE_SAFETY,
    businessFacts: renderBusinessFacts(input.business, input.facts),
    sourceEvidence: renderEvidence(input.evidence),
    task: [
      `Write a content brief for: "${input.topicTitle}"`,
      `Primary keyword: ${input.primaryKeyword}`,
      input.secondaryKeywords.length ? `Secondary terms: ${input.secondaryKeywords.join(", ")}` : "",
      `Search intent: ${input.intent}`,
      input.previousBrief ? `Previous brief to refine (keep useful parts):\n${JSON.stringify(input.previousBrief)}` : "",
      input.instructions?.trim()
        ? `User's editorial direction:\n${input.instructions.trim()}\nTreat this as writing guidance, not proof of business claims. Keep facts grounded in the supplied evidence.`
        : "",
      "",
      input.internalLinkCandidates.length
        ? `Existing pages available to link to:\n${input.internalLinkCandidates
            .slice(0, 20)
            .map((p) => `- ${p.title} — ${p.url}`)
            .join("\n")}`
        : "No existing pages are available for internal linking.",
    ].filter(Boolean).join("\n"),
    outputFormat: "Return only JSON conforming to the schema.",
  });

  const res = await gateway.generate(ctx, {
    taskAlias: "reasoning_high",
    system,
    cacheableSystemPrefixLength: cacheablePrefixLength,
    messages: [{ role: "user", content: "Produce the content brief." }],
    schema: BRIEF_SCHEMA as unknown as Record<string, unknown>,
    promptVersion: PROMPT_VERSIONS.contentBrief,
  });

  return normalizeBrief(res.parsed, input);
}

function normalizeBrief(parsed: unknown, input: GenerateBriefInput): ContentBrief {
  const raw = (parsed ?? {}) as Record<string, unknown>;

  const outline = Array.isArray(raw["outline"])
    ? (raw["outline"] as Record<string, unknown>[])
        .filter((o) => typeof o["heading"] === "string" && o["heading"].trim() !== "")
        .map((o) => ({
          heading: String(o["heading"]).trim(),
          level: clampInt(Number(o["level"] ?? 2), 2, 4),
          guidance: String(o["guidance"] ?? ""),
        }))
    : [];

  // Internal link targets are chosen from the supplied candidates only — the
  // model is never the source of a URL (spec: never invent a URL).
  const internalLinkTargets = input.internalLinkCandidates.slice(0, 6).map((c) => ({
    url: c.url,
    anchor: c.title.slice(0, 80),
  }));

  return {
    angle: String(raw["angle"] ?? `A practical guide to ${input.topicTitle}`),
    audience: String(raw["audience"] ?? input.business.audience ?? "Prospective customers"),
    searchIntent: String(raw["searchIntent"] ?? input.intent),
    outline: outline.length > 0 ? outline : defaultOutline(input),
    mustCoverFacts: Array.isArray(raw["mustCoverFacts"])
      ? (raw["mustCoverFacts"] as unknown[]).filter((f): f is string => typeof f === "string")
      : [],
    internalLinkTargets,
    targetWordCount: clampInt(Number(raw["targetWordCount"] ?? 1200), 400, 4000),
    ctaGuidance: String(raw["ctaGuidance"] ?? "Invite the reader to get in touch."),
  };
}

/** Used when the model returns no usable outline — never leaves a writer stuck. */
function defaultOutline(input: GenerateBriefInput): ContentBrief["outline"] {
  return [
    { heading: `What ${input.primaryKeyword} means`, level: 2, guidance: "Define the topic for a reader new to it." },
    { heading: "Why it matters", level: 2, guidance: "Explain the practical consequence for the reader." },
    { heading: "How it works in practice", level: 2, guidance: "Walk through the process concretely." },
    { heading: "What to do next", level: 2, guidance: "Give the reader a clear next step." },
  ];
}

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.round(n)));
}
