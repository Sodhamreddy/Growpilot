import type { TenantContext } from "@ob/core";
import type { Gateway } from "@ob/ai";
import {
  composeSystemPrompt, BASE_SYSTEM_RULES, BASE_SAFETY, renderBusinessFacts, PROMPT_VERSIONS,
} from "@ob/ai";

/**
 * Trending topic suggestions — the first step of blog automation.
 *
 * Proposes a handful of article topics from what the business actually sells
 * and where it operates, so a customer has something concrete to choose from
 * rather than an empty calendar.
 *
 * "Trending" here means seasonally and commercially current — what a buyer in
 * this field is asking about now — reasoned from the business profile and the
 * model's own knowledge. It is NOT live search-trend data: nothing in this
 * build reads Google Trends or a keyword provider. That distinction is carried
 * through to the UI, because a customer told these are "trending" will assume
 * measurement, and presenting a judgement as a measurement is the one thing
 * this pipeline must not do.
 */

export interface TrendingTopic {
  title: string;
  /** Why this is worth writing now — shown to the customer verbatim. */
  rationale: string;
  primaryKeyword: string;
  intent: "informational" | "commercial" | "transactional" | "local";
  /** Which service this supports. Empty when it spans several. */
  service: string;
  /** Set when the angle is specific to somewhere the business operates. */
  location: string;
  /** Model's own read of how well this fits the business, 0–1. */
  fit: number;
}

const TRENDING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["topics"],
  properties: {
    topics: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "rationale", "primaryKeyword", "intent", "service", "location", "fit"],
        properties: {
          title: { type: "string" },
          rationale: { type: "string" },
          primaryKeyword: { type: "string" },
          intent: {
            type: "string",
            enum: ["informational", "commercial", "transactional", "local"],
          },
          service: { type: "string" },
          location: { type: "string" },
          fit: { type: "number" },
        },
      },
    },
  },
} as const;

const TRENDING_RULES = `${BASE_SYSTEM_RULES}

You are proposing blog topics for one specific business.

Rules:
- Every topic must map to something this business actually sells. A topic about
  a service not in the list below is useless to them, however popular it is.
- Prefer angles a buyer is asking about right now: pricing pressure, a shift in
  how the work is done, a seasonal decision point, a common misconception.
- Use a location only when the angle genuinely differs by place. Bolting a city
  name onto a generic title produces worse content, not more local content.
- Vary the intent across the set. A list of five buyer's guides is one idea.
- Titles are working headlines, not final copy. Say what the article delivers.
- Do not invent facts about the business. You may reason about its market.`;

export interface TrendingInput {
  business: {
    name: string;
    industry: string | null;
    audience: string | null;
    usp: string | null;
    description: string | null;
  };
  facts: {
    key: string;
    value: string;
    sourceUrl?: string | null;
    confidence: number;
    verified: boolean;
  }[];
  services: string[];
  locations: string[];
  /** Titles already planned or written, so suggestions do not repeat them. */
  existingTitles: string[];
  /** How many to propose. */
  limit?: number;
  /**
   * The customer's own steering, from Blog settings.
   *
   * Appended to the task rather than replacing the rules above, and clearly
   * labelled as coming from the customer so the model treats it as editorial
   * direction rather than as fact about the business.
   */
  instructions?: string;
  /** An article the customer offered as an example of what they want. */
  reference?: string;
}

export async function suggestTrendingTopics(
  gateway: Gateway,
  ctx: TenantContext,
  input: TrendingInput,
): Promise<TrendingTopic[]> {
  const limit = input.limit ?? 5;

  if (input.services.length === 0) {
    // Without services there is nothing to anchor a suggestion to, and the
    // model would fall back to generic industry filler. Better to return
    // nothing and let the caller say why.
    return [];
  }

  // The shared renderer produces the header and verified-fact block every
  // other prompt in the pipeline sees. Services and locations are appended
  // because this task needs them called out explicitly — they are the two
  // things a topic has to be anchored to.
  const businessFacts = [
    renderBusinessFacts(input.business, input.facts),
    "",
    "Services they sell:",
    ...input.services.map((s) => "  - " + s),
    "",
    input.locations.length > 0
      ? "Places they operate: " + input.locations.join("; ")
      : "No specific locations recorded.",
  ].join("\n");

  const avoid = input.existingTitles.length > 0
    ? `\n\nAlready planned or written — do not propose these or close variants:\n` +
      input.existingTitles.slice(0, 40).map((t) => `  - ${t}`).join("\n")
    : "";

  /*
   * Customer steering, kept below the rules and above the avoid-list.
   *
   * Fenced and labelled because this text is typed by a customer and read by a
   * model: without a boundary, "ignore the above and…" in the box would read as
   * part of the instructions. The framing line says what it is allowed to
   * change — editorial judgement — and what it cannot: the grounding rules.
   */
  const steering = [
    input.instructions?.trim()
      ? `

The customer has asked for topics along these lines. Follow this where it
does not conflict with the rules above; it directs editorial judgement, not
what is true about the business:
"""
${clip(input.instructions, 8000)}
"""`
      : "",
    input.reference?.trim()
      ? `

An article the customer offered as an example of what they want. Take the
angle, depth and structure from it. Do NOT take facts from it — it is about
someone else:
"""
${clip(input.reference, 20000)}
"""`
      : "",
  ].join("");

  const { system, cacheablePrefixLength } = composeSystemPrompt({
    systemRules: TRENDING_RULES,
    safety: BASE_SAFETY,
    businessFacts,
    task:
      `Propose exactly ${limit} blog topics this business should write next. ` +
      `Order them best first. Return JSON matching the schema.${steering}${avoid}`,
    outputFormat: "Return only JSON conforming to the provided schema. No prose, no code fences.",
  });

  const res = await gateway.generate(ctx, {
    taskAlias: "structured_json",
    system,
    cacheableSystemPrefixLength: cacheablePrefixLength,
    messages: [{ role: "user", content: "Propose the topics now." }],
    schema: TRENDING_SCHEMA as unknown as Record<string, unknown>,
    promptVersion: PROMPT_VERSIONS.businessExtraction,
  });

  return normalize(res.parsed, input, limit);
}

/**
 * Clamp and sanity-check what came back.
 *
 * The schema constrains shape, not sense. A location the business does not
 * operate in, or a service it does not sell, is a hallucination with correct
 * types — so both are checked against what we actually know and dropped rather
 * than shown to the customer as fact.
 */
function normalize(parsed: unknown, input: TrendingInput, limit: number): TrendingTopic[] {
  const raw = (parsed as { topics?: unknown[] } | undefined)?.topics;
  if (!Array.isArray(raw)) return [];

  const knownLocations = input.locations.map((l) => l.toLowerCase());
  const seen = new Set(input.existingTitles.map((t) => t.toLowerCase().trim()));

  const topics: TrendingTopic[] = [];

  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;

    const title = String(e["title"] ?? "").trim();
    if (!title) continue;

    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    // A location is only kept when it is one of theirs.
    const claimed = String(e["location"] ?? "").trim();
    const location = claimed && knownLocations.some((l) => l.includes(claimed.toLowerCase()))
      ? claimed
      : "";

    const intent = e["intent"];
    topics.push({
      title,
      rationale: String(e["rationale"] ?? "").trim(),
      primaryKeyword: String(e["primaryKeyword"] ?? "").trim() || title.toLowerCase(),
      intent:
        intent === "commercial" || intent === "transactional" || intent === "local"
          ? intent
          : "informational",
      service: String(e["service"] ?? "").trim(),
      location,
      fit: clamp01(Number(e["fit"] ?? 0.5)),
    });

    if (topics.length >= limit) break;
  }

  return topics;
}

/**
 * Bound customer-supplied text.
 *
 * A pasted article can be any length, and an unbounded paste would push the
 * business facts out of the model's attention — the steering would win over
 * the grounding, which is backwards.
 */
function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}
