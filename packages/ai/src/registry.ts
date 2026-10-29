import type { RoutePolicy, TaskAlias } from "./types.js";

/**
 * Task-alias → model routing table — spec §5.1 and §5.3.
 *
 * This file is the ONLY place model identifiers appear. Changing a model, a
 * provider, or a fallback order is an edit here; no feature code changes
 * (spec §5.2: "Allow model changes without changing application code").
 *
 * ── Note on the spec's model table ──────────────────────────────────────────
 * Spec §5.1 names `GPT-5.6 Sol/Terra/Luna` and `Gemini 3.1 Pro`. The Gemini one
 * turned out to be real — `gemini-3.1-pro-preview` exists, though it is gated
 * behind paid quota, so the default below is a model that works on a standard
 * key. The GPT-5.6 identifiers remain unverified and are not hardcoded; the
 * OpenAI rung reads its model id from the environment and activates the moment
 * you supply a real name plus a key. The chain skips any unconfigured rung.
 *
 * Costs are micro-dollars per 1M tokens (1 USD = 1_000_000 micros).
 */

const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "";
/*
 * Gemini model ids, overridable per deployment.
 *
 * Defaults are the ones verified working on a standard API key. The newer
 * preview models (gemini-3.x) are gated behind paid quota and return 429 on a
 * free key, so they are not defaults — set GOOGLE_MODEL to one if your billing
 * covers it. Model availability shifts, so treat these as a starting point and
 * check `client.models.list()` rather than trusting this comment.
 */
const GOOGLE_PRO = process.env.GOOGLE_MODEL ?? "gemini-2.5-flash";
const GOOGLE_FLASH = process.env.GOOGLE_MODEL_FAST ?? "gemini-2.5-flash-lite";

// Anthropic list pricing, micro-dollars per 1M tokens.
const ANTHROPIC = {
  opus5: { inputCostPerMTok: 5_000_000, outputCostPerMTok: 25_000_000 },
  sonnet5: { inputCostPerMTok: 2_000_000, outputCostPerMTok: 10_000_000 },
  haiku45: { inputCostPerMTok: 1_000_000, outputCostPerMTok: 5_000_000 },
} as const;

/*
 * Which provider leads every chain.
 *
 * `AI_PRIMARY=google` puts Gemini first everywhere and demotes Anthropic to
 * the fallback rung. This is a deployment decision, not a code one: a customer
 * running on a free Gemini key and a customer paying for Sonnet want different
 * orders from the same build.
 *
 * Expressed as a reorder rather than as deletion so the other provider stays
 * available. Nothing is removed — if the leader is unconfigured or failing,
 * the chain still falls through to whatever else is set up, which is the whole
 * point of having a chain.
 */
const PRIMARY = (process.env.AI_PRIMARY ?? "anthropic").toLowerCase();

/*
 * Run on one provider only.
 *
 * `AI_ONLY=google` drops every other rung instead of demoting it. Ordering
 * alone still falls through on any failure, which is usually what you want and
 * occasionally exactly what you do not: a workspace deliberately running on
 * Gemini should not quietly spend on Anthropic because one call timed out.
 *
 * The trade is explicit and worth stating: with one rung there is no fallback.
 * A provider outage stops the pipeline rather than costing money elsewhere.
 * That is the point, but it is a choice, not a free win.
 */
const ONLY = (process.env.AI_ONLY ?? "").toLowerCase();

/**
 * Order a chain so the configured primary provider is tried first, or keep
 * only that provider when `AI_ONLY` names one.
 *
 * A filter that would empty a chain is ignored rather than honoured: a typo in
 * `AI_ONLY` should not silently leave a task with nowhere to run, and failing
 * loudly at the first call is better than an alias that can never resolve.
 */
const ordered = <T extends { provider: string }>(rungs: T[]): T[] => {
  if (ONLY) {
    const kept = rungs.filter((r) => r.provider === ONLY);
    if (kept.length > 0) return kept;
  }
  return [
    ...rungs.filter((r) => r.provider === PRIMARY),
    ...rungs.filter((r) => r.provider !== PRIMARY),
  ];
};

const openaiRung = (maxTokens: number) =>
  OPENAI_MODEL
    ? [{
        provider: "openai",
        model: OPENAI_MODEL,
        inputCostPerMTok: Number(process.env.OPENAI_INPUT_COST_PER_MTOK ?? 0),
        outputCostPerMTok: Number(process.env.OPENAI_OUTPUT_COST_PER_MTOK ?? 0),
        maxTokens,
      }]
    : [];

const googleRung = (maxTokens: number, fast = false) => [{
  provider: "google",
  model: fast ? GOOGLE_FLASH : GOOGLE_PRO,
  inputCostPerMTok: Number(
    process.env[fast ? "GOOGLE_FAST_INPUT_COST_PER_MTOK" : "GOOGLE_INPUT_COST_PER_MTOK"] ?? 0,
  ),
  outputCostPerMTok: Number(
    process.env[fast ? "GOOGLE_FAST_OUTPUT_COST_PER_MTOK" : "GOOGLE_OUTPUT_COST_PER_MTOK"] ?? 0,
  ),
  maxTokens,
}];

export const ROUTES: Record<TaskAlias, RoutePolicy> = {
  // §5.1 "Complex reasoning / orchestration"
  reasoning_high: {
    alias: "reasoning_high",
    chain: ordered([
      { provider: "anthropic", model: "claude-opus-5", ...ANTHROPIC.opus5, maxTokens: 16_000 },
      { provider: "anthropic", model: "claude-sonnet-5", ...ANTHROPIC.sonnet5, maxTokens: 16_000 },
      ...googleRung(16_000),
    ]),
    timeoutMs: 180_000,
    maxAttemptsPerBinding: 2,
  },

  // §5.1 "Long-form article writing" — streamed, so a generous output budget.
  writing_long: {
    alias: "writing_long",
    chain: ordered([
      { provider: "anthropic", model: "claude-sonnet-5", ...ANTHROPIC.sonnet5, maxTokens: 32_000 },
      { provider: "anthropic", model: "claude-opus-5", ...ANTHROPIC.opus5, maxTokens: 32_000 },
      ...googleRung(32_000),
      ...openaiRung(32_000),
    ]),
    timeoutMs: 300_000,
    maxAttemptsPerBinding: 2,
  },

  // §5.1 "Editing / rewriting"
  editing_rewrite: {
    alias: "editing_rewrite",
    chain: ordered([
      { provider: "anthropic", model: "claude-sonnet-5", ...ANTHROPIC.sonnet5, maxTokens: 16_000 },
      { provider: "anthropic", model: "claude-haiku-4-5", ...ANTHROPIC.haiku45, maxTokens: 8_000 },
      ...googleRung(16_000),
    ]),
    timeoutMs: 120_000,
    maxAttemptsPerBinding: 2,
  },

  /*
   * §5.1 "SEO/schema structured output", business extraction, and the social
   * topic pool.
   *
   * The ceiling and the timeout were both sized for a handful of fields. A
   * category of sixteen topics, each with a ninety-word hook and an image
   * idea, is several thousand tokens of JSON on its own: at 8k the model ran
   * to the 90s timeout three times over before the chain gave up, which read
   * as "every provider is unavailable" when the real answer was "the answer
   * did not fit".
   */
  structured_json: {
    alias: "structured_json",
    chain: ordered([
      { provider: "anthropic", model: "claude-sonnet-5", ...ANTHROPIC.sonnet5, maxTokens: 32_000 },
      { provider: "anthropic", model: "claude-haiku-4-5", ...ANTHROPIC.haiku45, maxTokens: 16_000 },
      /*
       * The full model, not the fast one.
       *
       * This alias carries the heaviest structured work in the product: a
       * category of sixteen topics, each with a ninety-word hook, an audience,
       * a format and an image idea, all conforming to a schema. Flash-Lite is
       * sized for classification, and it was only ever reached here as the
       * third rung behind two Anthropic models. Running on one provider makes
       * it the only rung, so the weakest model would become the only one that
       * ever writes a topic.
       */
      ...googleRung(32_000),
      ...openaiRung(16_000),
    ]),
    timeoutMs: 240_000,
    // Two, not three. A timeout that has already burned the full window twice
    // is not going to succeed on a third identical attempt, and each one is
    // four minutes a person spends watching a spinner.
    maxAttemptsPerBinding: 2,
  },

  // §5.1 "High-volume classification" — cheapest capable model.
  bulk_classification: {
    alias: "bulk_classification",
    chain: ordered([
      { provider: "anthropic", model: "claude-haiku-4-5", ...ANTHROPIC.haiku45, maxTokens: 2_000 },
      ...googleRung(2_000, true),
    ]),
    timeoutMs: 45_000,
    maxAttemptsPerBinding: 3,
  },

  // §5.1 "Research / fact checking" — grounding gate runs here.
  research_grounded: {
    alias: "research_grounded",
    chain: ordered([
      { provider: "anthropic", model: "claude-opus-5", ...ANTHROPIC.opus5, maxTokens: 12_000 },
      { provider: "anthropic", model: "claude-sonnet-5", ...ANTHROPIC.sonnet5, maxTokens: 12_000 },
      ...googleRung(12_000),
    ]),
    timeoutMs: 180_000,
    maxAttemptsPerBinding: 2,
  },

  // §5.1 "Embeddings / RAG". No first-party Anthropic embedding model, so this
  // routes to the configured embedding provider and falls back to the
  // deterministic local hashing embedder used by tests and offline dev.
  embedding: {
    alias: "embedding",
    chain: [
      {
        provider: process.env.EMBEDDING_PROVIDER ?? "google",
        model: process.env.EMBEDDING_MODEL ?? "gemini-embedding-001",
        inputCostPerMTok: Number(process.env.EMBEDDING_COST_PER_MTOK ?? 150_000),
        outputCostPerMTok: 0,
        maxTokens: 0,
      },
      { provider: "local", model: "hashing-1536", inputCostPerMTok: 0, outputCostPerMTok: 0, maxTokens: 0 },
    ],
    timeoutMs: 60_000,
    maxAttemptsPerBinding: 2,
  },
};

export function routeFor(alias: TaskAlias): RoutePolicy {
  const route = ROUTES[alias];
  if (!route) throw new Error(`No route configured for task alias "${alias}"`);
  return route;
}

/**
 * The image model.
 *
 * One binding rather than a chain: only Google's model is wired, and a
 * fallback to a different image model would change what posts look like
 * from one day to the next. Priced per image, not per token, because that is
 * how Google bills it (list price for gemini-2.5-flash-image, 1024px).
 */
export const IMAGE_BINDING = {
  provider: "google",
  model: "gemini-2.5-flash-image",
  costMicrosPerImage: 39_000,
  timeoutMs: 90_000,
} as const;

/** Micro-dollar cost of one call. Recorded on every AI job (spec §14.1). */
export function computeCostMicros(
  binding: { inputCostPerMTok: number; outputCostPerMTok: number },
  usage: { inputTokens: number; outputTokens: number },
): number {
  const input = (usage.inputTokens / 1_000_000) * binding.inputCostPerMTok;
  const output = (usage.outputTokens / 1_000_000) * binding.outputCostPerMTok;
  return Math.round(input + output);
}
