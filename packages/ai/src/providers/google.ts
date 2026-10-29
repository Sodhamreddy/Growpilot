import { GoogleGenAI } from "@google/genai";
import { AppError } from "@ob/core";
import type {
  AiProvider, EmbedRequest, EmbedResponse, GenerateRequest, GenerateResponse, ImageRequest, ImageResponse,
} from "../types.js";

/**
 * Google Gemini adapter.
 *
 * Maps the gateway's provider-neutral contract onto the Gemini API:
 *  - our layered `system` string  → `config.systemInstruction`
 *  - our `schema`                 → `responseMimeType` + `responseSchema`
 *  - Gemini's `usageMetadata`     → our token counts, so cost accounting and
 *    the per-workspace budget work identically to any other provider
 *
 * Nothing above the gateway knows this exists — features request a task alias
 * and the registry decides which provider serves it (spec §5.2).
 */
/** Must match `knowledge_chunks.embedding` in packages/db/src/schema.ts. */
const EMBEDDING_DIMENSIONS = 1536;

export class GoogleProvider implements AiProvider {
  readonly name = "google";
  #client: GoogleGenAI | undefined;
  readonly #apiKey: string | undefined;

  constructor(apiKey: string | undefined) {
    this.#apiKey = apiKey?.trim() || undefined;
  }

  isConfigured(): boolean {
    return this.#apiKey !== undefined;
  }

  #getClient(): GoogleGenAI {
    if (!this.#apiKey) {
      throw new AppError("provider_error", "The Google provider is not configured.", {
        retryable: false,
      });
    }
    this.#client ??= new GoogleGenAI({ apiKey: this.#apiKey });
    return this.#client;
  }

  async generate(req: GenerateRequest, model: string, signal: AbortSignal): Promise<GenerateResponse> {
    const client = this.#getClient();

    // Gemini takes the conversation as `contents` with "model" for assistant.
    const contents = req.messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    const config: Record<string, unknown> = {
      systemInstruction: req.system,
      maxOutputTokens: req.maxTokens ?? 8_000,
      abortSignal: signal,
    };

    if (req.schema) {
      config["responseMimeType"] = "application/json";
      config["responseSchema"] = toGeminiSchema(req.schema);
    }

    let res: Awaited<ReturnType<typeof client.models.generateContent>>;
    try {
      res = await client.models.generateContent({ model, contents, config });
    } catch (err) {
      throw translateError(err);
    }

    const text = res.text ?? "";
    if (text === "") {
      // A blocked prompt returns 200 with no candidate text, so this has to be
      // checked rather than assumed successful.
      const reason = res.promptFeedback?.blockReason;
      throw new AppError(
        "provider_error",
        reason
          ? "The AI declined this request for safety reasons."
          : "The AI returned an empty response.",
        { details: reason ? { blockReason: reason } : {}, retryable: !reason },
      );
    }

    const usage = res.usageMetadata;
    return {
      text,
      parsed: req.schema ? safeParseJson(text) : undefined,
      usage: {
        inputTokens: usage?.promptTokenCount ?? 0,
        outputTokens: usage?.candidatesTokenCount ?? 0,
        cacheReadTokens: usage?.cachedContentTokenCount ?? 0,
      },
      model,
      provider: this.name,
      stopReason: res.candidates?.[0]?.finishReason ?? "STOP",
    };
  }

  /** Embeddings for the knowledge base (spec §4). */
  async generateImage(req: ImageRequest, model: string, signal: AbortSignal): Promise<ImageResponse> {
    const client = this.#getClient();
    let res: Awaited<ReturnType<typeof client.models.generateContent>>;
    try {
      res = await client.models.generateContent({
        model,
        contents: [{ role: "user", parts: [{ text: req.prompt }] }],
        config: {
          responseModalities: ["IMAGE"],
          imageConfig: { aspectRatio: req.aspectRatio },
          abortSignal: signal,
        },
      });
    } catch (err) {
      throw translateImageError(err);
    }

    const part = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
    if (!part?.inlineData?.data) {
      const reason = res.promptFeedback?.blockReason ?? res.candidates?.[0]?.finishReason;
      throw new AppError(
        "provider_error",
        reason && reason !== "STOP"
          ? "The image model declined this request. Adjust the image brief and try again."
          : "The image model returned no image. Try again.",
        { details: reason ? { reason } : {}, retryable: true },
      );
    }
    return {
      data: Buffer.from(part.inlineData.data, "base64"),
      mimeType: part.inlineData.mimeType ?? "image/png",
      provider: "google",
      model,
    };
  }

  async embed(req: EmbedRequest, model: string, signal: AbortSignal): Promise<EmbedResponse> {
    const client = this.#getClient();
    try {
      // The knowledge_chunks.embedding column is vector(1536), so the
      // dimensionality is pinned rather than left to the model default
      // (gemini-embedding-001 returns 3072 unless told otherwise). A mismatch
      // here fails at insert time with an opaque pgvector error.
      const res = await client.models.embedContent({
        model,
        contents: req.texts.map((t) => ({ parts: [{ text: t }] })),
        config: { outputDimensionality: EMBEDDING_DIMENSIONS, abortSignal: signal },
      });
      const vectors = (res.embeddings ?? []).map((e) => e.values ?? []);
      if (vectors.length !== req.texts.length) {
        throw new AppError("provider_error", "The embedding provider returned an unexpected result.");
      }
      const wrong = vectors.find((v) => v.length !== EMBEDDING_DIMENSIONS);
      if (wrong) {
        throw new AppError(
          "provider_error",
          `Embedding model returned ${wrong.length} dimensions; the schema expects ${EMBEDDING_DIMENSIONS}.`,
          { retryable: false },
        );
      }
      return {
        vectors,
        usage: {
          inputTokens: req.texts.reduce((n, t) => n + Math.ceil(t.length / 4), 0),
          outputTokens: 0,
          cacheReadTokens: 0,
        },
        model,
        provider: this.name,
      };
    } catch (err) {
      throw translateError(err);
    }
  }
}

/**
 * Adapt a JSON Schema for Gemini's structured output.
 *
 * Gemini compiles the schema into a constraint automaton and refuses anything
 * whose state space grows too large:
 *
 *   "The specified schema produces a constraint that has too many states for
 *    serving. Typical causes are schemas with long array length limits
 *    (especially when nested), or complex value matchers (numbers with
 *    minimum/maximum bounds, strings with patterns)."
 *
 * Our extraction schema hit exactly that — nested arrays with `maxItems: 40`
 * and `minimum`/`maximum` on every confidence field. The whole call fails with
 * a 400, which surfaced as an empty business profile.
 *
 * So the bounds are dropped here rather than weakened in the shared schema.
 * Nothing is lost: every numeric range is re-clamped and every array re-capped
 * by the normalisers in packages/pipeline, which have to run anyway because a
 * model can return a well-typed answer that is still wrong.
 */
export function toGeminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const UNSUPPORTED = new Set([
    // Not supported by Gemini at all.
    "additionalProperties", "$schema", "$ref", "definitions", "const",
    // Supported, but each one multiplies the constraint state space.
    "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
    "minItems", "maxItems", "minLength", "maxLength", "pattern", "format",
  ]);

  /*
   * Strip keywords only where they are keywords.
   *
   * The map inside `properties` is user-defined field names, not schema
   * vocabulary, and a field legitimately called `format`, `pattern` or
   * `maximum` was being deleted from `properties` while staying in `required`.
   * Gemini then rejected the whole request with
   *   "properties[topics].items.required[3]: property is not defined"
   * which reads like a malformed schema rather than what it was: this
   * function eating a field name it mistook for a constraint.
   *
   * So `properties` values are walked as schemas while their keys are left
   * alone, and the same applies to `$defs`.
   */
  const NAME_MAPS = new Set(["properties", "$defs", "patternProperties"]);

  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;

    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (UNSUPPORTED.has(k)) continue;

      if (NAME_MAPS.has(k) && v && typeof v === "object" && !Array.isArray(v)) {
        const inner: Record<string, unknown> = {};
        for (const [name, sub] of Object.entries(v as Record<string, unknown>)) {
          inner[name] = walk(sub);
        }
        out[k] = inner;
        continue;
      }

      out[k] = walk(v);
    }
    return out;
  };

  const cleaned = walk(schema) as Record<string, unknown>;

  /*
   * A `required` entry with no matching property is the error above, and it
   * can still arise from a schema that arrived inconsistent. Dropping the
   * dangling name costs one optional field; sending it costs the whole call.
   */
  const prune = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(prune); return; }
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;

    const props = obj["properties"];
    if (Array.isArray(obj["required"]) && props && typeof props === "object") {
      const known = new Set(Object.keys(props as Record<string, unknown>));
      obj["required"] = (obj["required"] as unknown[]).filter(
        (r) => typeof r === "string" && known.has(r),
      );
    }
    for (const v of Object.values(obj)) prune(v);
  };
  prune(cleaned);

  return cleaned;
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
    if (fenced?.[1]) {
      try {
        return JSON.parse(fenced[1]);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

/**
 * Image generation's own error reading.
 *
 * A free-tier key gets a 429 from the image model with a quota of zero, which
 * the general mapping would call "rate limiting us, retrying shortly". That is
 * false twice over: nothing retries, and waiting cannot help, because the free
 * tier does not include the image model at all. Only billing changes it.
 */
export function translateImageError(err: unknown): AppError {
  const message = String((err as { message?: string })?.message ?? "");
  if (/free[_ ]?tier/i.test(message) && /quota/i.test(message)) {
    return new AppError(
      "provider_error",
      "This Google API key cannot generate images: the free tier does not include the image model. " +
        "Turn on billing for the key's Google Cloud project, then try again. Uploading an image works meanwhile.",
      { cause: err, retryable: false, details: { reason: "image_model_not_in_free_tier" } },
    );
  }
  return translateError(err);
}

/** Map SDK errors onto our typed errors so retry policy is uniform. */
function translateError(err: unknown): AppError {
  if (err instanceof AppError) return err;

  const e = err as { status?: number; message?: string; name?: string };
  const status = typeof e?.status === "number" ? e.status : 0;
  const message = String(e?.message ?? "");

  if (e?.name === "AbortError" || /abort/i.test(message)) {
    return new AppError("provider_timeout", "The AI request timed out.", { cause: err, retryable: true });
  }
  if (status === 429 || /quota|rate limit/i.test(message)) {
    return new AppError("rate_limited", "The AI provider is rate limiting us. Retrying shortly.", {
      cause: err, retryable: true,
    });
  }
  if (status === 401 || status === 403 || /api key/i.test(message)) {
    return new AppError("provider_error", "The AI provider rejected our credentials.", {
      cause: err, retryable: false,
    });
  }
  return new AppError("provider_error", "The AI provider returned an error.", {
    cause: err,
    details: status ? { status } : {},
    // 4xx is our request's fault; retrying will not help.
    retryable: status === 0 || status >= 500,
  });
}
