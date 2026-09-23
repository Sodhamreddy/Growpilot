import type { TenantContext } from "@ob/core";
import type { Gateway } from "@ob/ai";
import { composeSystemPrompt, BASE_SYSTEM_RULES, BASE_SAFETY, renderBusinessFacts, PROMPT_VERSIONS } from "@ob/ai";

/**
 * Keyword research — spec §6.1.
 *
 * Search-volume and difficulty data comes from a third-party provider. No such
 * credential was available for this build, so the provider sits behind
 * `KeywordDataProvider` with a documented stub implementation. Seed generation,
 * intent classification, clustering and prioritisation all work today; swapping
 * in SE Ranking, DataForSEO or Ahrefs means implementing one interface.
 */

export type SearchIntent = "informational" | "commercial" | "transactional" | "navigational" | "local";

export interface KeywordMetrics {
  term: string;
  volume: number | null;
  difficulty: number | null;
  cpcMicros: number | null;
}

export interface KeywordDataProvider {
  readonly name: string;
  /** Volume/difficulty/CPC for a batch of terms. */
  metrics(terms: string[], opts: { location?: string; language?: string }): Promise<KeywordMetrics[]>;
  /** Related and question expansions for a seed. */
  expand(seed: string, opts: { location?: string; language?: string; limit?: number }): Promise<string[]>;
}

/**
 * Stub provider.
 *
 * Returns nulls for every metric rather than plausible-looking numbers. That is
 * deliberate: a fabricated search volume would flow into the opportunity score
 * and into a content plan the customer acts on. Null is honest and the UI
 * renders it as "no data".
 */
export class StubKeywordProvider implements KeywordDataProvider {
  readonly name = "stub";

  async metrics(terms: string[]): Promise<KeywordMetrics[]> {
    return terms.map((term) => ({ term, volume: null, difficulty: null, cpcMicros: null }));
  }

  async expand(): Promise<string[]> {
    return [];
  }
}

// ─── Seed generation (spec §6.1 step 1) ─────────────────────────────────────

const SEED_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["keywords"],
  properties: {
    keywords: {
      type: "array",
      minItems: 10,
      maxItems: 80,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["term", "intent", "relevance", "rationale"],
        properties: {
          term: { type: "string" },
          intent: {
            type: "string",
            enum: ["informational", "commercial", "transactional", "navigational", "local"],
          },
          relevance: { type: "number", minimum: 0, maximum: 1 },
          rationale: { type: "string" },
        },
      },
    },
  },
} as const;

export interface SeedKeyword {
  term: string;
  intent: SearchIntent;
  relevance: number;
  rationale: string;
}

export async function generateSeedKeywords(
  gateway: Gateway,
  ctx: TenantContext,
  input: {
    business: { name: string; industry?: string | null; audience?: string | null; usp?: string | null };
    facts: { key: string; value: string; sourceUrl?: string | null; confidence: number; verified: boolean }[];
    services: string[];
    locations: string[];
  },
): Promise<SeedKeyword[]> {
  const { system, cacheablePrefixLength } = composeSystemPrompt({
    systemRules: `${BASE_SYSTEM_RULES}

You generate seed search keywords from a business's verified services and
locations. Produce terms real customers would type, not marketing slogans.

Rules:
- Base every term on a service, product or location in BUSINESS FACTS.
- Cover the intent spread: informational, commercial, transactional, and local
  where the business has locations.
- Include long-tail phrases, not just head terms.
- Do not invent services the business does not offer.
- "relevance" is how central the term is to this business, 0 to 1.`,
    safety: BASE_SAFETY,
    businessFacts: renderBusinessFacts(input.business, input.facts),
    task: [
      `Generate seed keywords for ${input.business.name}.`,
      input.services.length ? `Services: ${input.services.join(", ")}` : "",
      input.locations.length ? `Locations: ${input.locations.join(", ")}` : "",
    ].filter(Boolean).join("\n"),
    outputFormat: "Return only JSON conforming to the schema.",
  });

  const res = await gateway.generate(ctx, {
    taskAlias: "structured_json",
    system,
    cacheableSystemPrefixLength: cacheablePrefixLength,
    messages: [{ role: "user", content: "Generate the seed keyword set." }],
    schema: SEED_SCHEMA as unknown as Record<string, unknown>,
    promptVersion: PROMPT_VERSIONS.keywordIntent,
  });

  const parsed = res.parsed as { keywords?: unknown[] } | undefined;
  if (!Array.isArray(parsed?.keywords)) return [];

  const seen = new Set<string>();
  return (parsed.keywords as Record<string, unknown>[])
    .filter((k) => typeof k["term"] === "string" && k["term"].trim() !== "")
    .map((k) => ({
      term: String(k["term"]).trim().toLowerCase(),
      intent: normalizeIntent(k["intent"]),
      relevance: clamp01(Number(k["relevance"] ?? 0.5)),
      rationale: String(k["rationale"] ?? ""),
    }))
    .filter((k) => (seen.has(k.term) ? false : (seen.add(k.term), true)));
}

// ─── Prioritisation (spec §6.1 step 7) ──────────────────────────────────────

/**
 * Opportunity score: "business value, relevance and ranking opportunity".
 *
 * Returns null when there is no volume or difficulty data, rather than scoring
 * on relevance alone and presenting that as an opportunity ranking.
 */
export function opportunityScore(input: {
  relevance: number;
  intent: SearchIntent;
  volume: number | null;
  difficulty: number | null;
}): number | null {
  if (input.volume === null && input.difficulty === null) return null;

  // Commercial and transactional terms convert; informational terms build reach.
  const intentWeight: Record<SearchIntent, number> = {
    transactional: 1.0,
    commercial: 0.9,
    local: 0.85,
    informational: 0.6,
    navigational: 0.3,
  };

  // Log-scale volume so a 50k-search head term does not swamp everything else.
  const volumeScore = input.volume === null
    ? 0.5
    : Math.min(1, Math.log10(Math.max(1, input.volume)) / 5);

  // Low difficulty is high opportunity.
  const difficultyScore = input.difficulty === null
    ? 0.5
    : 1 - Math.min(1, Math.max(0, input.difficulty) / 100);

  const score =
    input.relevance * 0.35 +
    intentWeight[input.intent] * 0.2 +
    volumeScore * 0.25 +
    difficultyScore * 0.2;

  return Math.round(score * 1000) / 10;
}

// ─── Clustering (spec §6.1 step 6) ──────────────────────────────────────────

export interface KeywordCluster {
  label: string;
  intent: SearchIntent;
  terms: string[];
  totalVolume: number;
}

/**
 * Group terms by shared content stems and matching intent.
 *
 * Lexical clustering, not semantic: two terms cluster when they share
 * meaningful stems and the same intent. Cheap, deterministic and explainable.
 * An embedding-based upgrade would reuse the same output shape.
 */
export function clusterKeywords(
  keywords: { term: string; intent: SearchIntent; volume: number | null }[],
): KeywordCluster[] {
  const STOP = new Set([
    "the", "a", "an", "for", "of", "in", "to", "and", "or", "with", "on", "at",
    "my", "your", "best", "near", "me", "how", "what", "why", "is", "are", "do", "does",
  ]);

  const stems = (term: string): Set<string> =>
    new Set(
      term.toLowerCase().split(/\s+/)
        .map((w) => w.replace(/[^a-z0-9]/g, ""))
        .filter((w) => w.length > 2 && !STOP.has(w))
        .map(stem),
    );

  const clusters: { stems: Set<string>; intent: SearchIntent; terms: string[]; volume: number }[] = [];

  // Longest terms first: they carry the most specific stems, which makes for
  // better cluster seeds than head terms.
  const sorted = [...keywords].sort((a, b) => b.term.length - a.term.length);

  for (const kw of sorted) {
    const kwStems = stems(kw.term);
    if (kwStems.size === 0) continue;

    const match = clusters.find(
      (c) => c.intent === kw.intent && overlap(c.stems, kwStems) >= Math.min(2, kwStems.size),
    );

    if (match) {
      match.terms.push(kw.term);
      match.volume += kw.volume ?? 0;
      for (const s of kwStems) match.stems.add(s);
    } else {
      clusters.push({ stems: kwStems, intent: kw.intent, terms: [kw.term], volume: kw.volume ?? 0 });
    }
  }

  return clusters
    .map((c) => ({
      label: labelFor(c.terms),
      intent: c.intent,
      terms: c.terms,
      totalVolume: c.volume,
    }))
    .sort((a, b) => b.terms.length - a.terms.length);
}

function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const x of b) if (a.has(x)) n++;
  return n;
}

/** Crude suffix stripping — enough to group "dentist"/"dentists"/"dental". */
function stem(word: string): string {
  return word
    .replace(/(ies)$/, "y")
    .replace(/(sses|shes|ches|xes)$/, "")
    .replace(/([^s])s$/, "$1")
    .replace(/(ing|ed)$/, "");
}

/** The shortest term is usually the cluster's head term. */
function labelFor(terms: string[]): string {
  return [...terms].sort((a, b) => a.length - b.length)[0] ?? "cluster";
}

function normalizeIntent(v: unknown): SearchIntent {
  const valid: SearchIntent[] = ["informational", "commercial", "transactional", "navigational", "local"];
  return valid.includes(v as SearchIntent) ? (v as SearchIntent) : "informational";
}

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5);
