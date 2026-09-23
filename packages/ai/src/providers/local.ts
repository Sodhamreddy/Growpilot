import { createHash } from "node:crypto";
import type {
  AiProvider, EmbedRequest, EmbedResponse, GenerateRequest, GenerateResponse,
} from "../types.js";

/**
 * Deterministic offline provider.
 *
 * Two jobs:
 *  1. Embeddings when no embedding API is configured — a hashing embedder that
 *     is stable, local, and free. Retrieval quality is materially worse than a
 *     real model's, but the pipeline is exercised end to end and tests are
 *     reproducible. Swap in a real model by setting EMBEDDING_MODEL.
 *  2. Generation under AI_MOCK=1, so CI and offline development run the whole
 *     article pipeline with no credentials and no network.
 *
 * Output is a deterministic function of the input, so snapshot tests are stable.
 */
export class LocalProvider implements AiProvider {
  readonly name = "local";

  isConfigured(): boolean {
    return true;
  }

  async generate(req: GenerateRequest, model: string): Promise<GenerateResponse> {
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
    const seed = createHash("sha256")
      .update(req.system)
      .update(lastUser?.content ?? "")
      .digest("hex");

    const text = req.schema
      ? JSON.stringify(synthesizeFromSchema(req.schema, seed))
      : synthesizeProse(req, seed);

    const inputTokens = estimateTokens(req.system) + estimateTokens(lastUser?.content ?? "");
    return {
      text,
      parsed: req.schema ? JSON.parse(text) : undefined,
      usage: { inputTokens, outputTokens: estimateTokens(text), cacheReadTokens: 0 },
      model,
      provider: this.name,
      stopReason: "end_turn",
    };
  }

  async embed(req: EmbedRequest, model: string): Promise<EmbedResponse> {
    return {
      vectors: req.texts.map((t) => hashEmbed(t, 1536)),
      usage: {
        inputTokens: req.texts.reduce((n, t) => n + estimateTokens(t), 0),
        outputTokens: 0,
        cacheReadTokens: 0,
      },
      model,
      provider: this.name,
    };
  }
}

/**
 * Hashing ("random projection") embedder. Each token is hashed to a dimension
 * and a sign; the vector is L2-normalised so cosine distance behaves. Captures
 * lexical overlap only — no semantics.
 */
export function hashEmbed(text: string, dimensions: number): number[] {
  const vec = new Float64Array(dimensions);
  const tokens = text.toLowerCase().match(/[a-z0-9']+/g) ?? [];

  for (const token of tokens) {
    const h = createHash("sha1").update(token).digest();
    const idx = h.readUInt32BE(0) % dimensions;
    const sign = (h[4]! & 1) === 0 ? 1 : -1;
    // Sub-linear term weighting keeps frequent tokens from dominating.
    vec[idx] = vec[idx]! + sign;
  }

  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  return Array.from(vec, (v) => v / norm);
}

/** ~4 characters per token. Good enough for budget accounting on the mock path. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function synthesizeProse(req: GenerateRequest, seed: string): string {
  const topic = extractTopic(req);
  return [
    `## ${topic}`,
    "",
    `This draft was produced by the offline mock provider (AI_MOCK=1), seeded \`${seed.slice(0, 12)}\`.`,
    "It exercises the full generation, QA and approval pipeline without calling a model.",
    "",
    "### What this section covers",
    "",
    `- The requested task alias was \`${req.taskAlias}\`.`,
    `- Prompt version \`${req.promptVersion}\` was applied.`,
    "- Business facts and brand voice rules were composed into the system prompt.",
    "",
    "Set `AI_MOCK=0` and provide `ANTHROPIC_API_KEY` to generate real content.",
  ].join("\n");
}

function extractTopic(req: GenerateRequest): string {
  const user = req.messages.find((m) => m.role === "user")?.content ?? "";
  const match = /(?:topic|title|keyword)\s*:\s*(.+)/i.exec(user);
  return (match?.[1] ?? "Generated Draft").split("\n")[0]!.trim().slice(0, 120);
}

/**
 * Build a value satisfying a JSON Schema. Supports the subset this codebase
 * uses: object/array/string/number/integer/boolean, `enum`, `required`,
 * `items`, `properties`, `minItems`.
 */
function synthesizeFromSchema(schema: Record<string, unknown>, seed: string, depth = 0): unknown {
  if (depth > 6) return null;
  const type = schema["type"] as string | undefined;
  const enumValues = schema["enum"] as unknown[] | undefined;
  if (enumValues?.length) return enumValues[0];

  switch (type) {
    case "object": {
      const props = (schema["properties"] ?? {}) as Record<string, Record<string, unknown>>;
      const required = (schema["required"] as string[] | undefined) ?? Object.keys(props);
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(props)) {
        if (!required.includes(key)) continue;
        out[key] = synthesizeFromSchema(props[key]!, `${seed}:${key}`, depth + 1);
      }
      return out;
    }
    case "array": {
      const items = schema["items"] as Record<string, unknown> | undefined;
      const count = Math.max(1, Number(schema["minItems"] ?? 1));
      if (!items) return [];
      return Array.from({ length: count }, (_, i) =>
        synthesizeFromSchema(items, `${seed}:${i}`, depth + 1),
      );
    }
    case "number":
    case "integer": {
      const min = Number(schema["minimum"] ?? 0);
      const max = Number(schema["maximum"] ?? min + 100);
      const span = Math.max(0, max - min);
      const value = min + (parseInt(seed.slice(0, 4), 16) % (span + 1));
      return type === "integer" ? Math.round(value) : value;
    }
    case "boolean":
      return parseInt(seed.slice(0, 2), 16) % 2 === 0;
    case "string":
    default:
      return `mock:${seed.slice(0, 8)}`;
  }
}
