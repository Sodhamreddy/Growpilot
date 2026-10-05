import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import type {
  AiProvider, EmbedRequest, EmbedResponse, GenerateRequest, GenerateResponse, ImageRequest, ImageResponse,
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

  /**
   * A plain two-colour placeholder, so the image step runs offline.
   *
   * Deliberately obvious: a flat gradient with no picture and no text, sized
   * to the requested ratio, so nobody mistakes it for a finished image.
   */
  async generateImage(req: ImageRequest): Promise<ImageResponse> {
    const [w, h] = req.aspectRatio.split(":").map(Number) as [number, number];
    const width = 400;
    const height = Math.round((400 * (h || 5)) / (w || 4));
    const seed = createHash("sha256").update(req.prompt).digest();
    return {
      data: gradientPng(width, height, [seed[0]!, seed[1]!, seed[2]!], [seed[3]!, seed[4]!, seed[5]!]),
      mimeType: "image/png",
      provider: this.name,
      // Named for what it is, so a placeholder is never read as the real model's work.
      model: "offline-placeholder",
    };
  }
}

/** A vertical two-colour gradient as a PNG, with no image library. */
export function gradientPng(width: number, height: number, top: number[], bottom: number[]): Uint8Array {
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const t = height > 1 ? y / (height - 1) : 0;
    const row = Buffer.alloc(1 + width * 3); // filter byte 0, then RGB
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 3; c++) row[1 + x * 3 + c] = Math.round(top[c]! * (1 - t) + bottom[c]! * t);
    }
    rows.push(row);
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
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
