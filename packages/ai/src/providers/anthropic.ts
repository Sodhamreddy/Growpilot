import Anthropic from "@anthropic-ai/sdk";
import { AppError } from "@ob/core";
import type { AiProvider, GenerateRequest, GenerateResponse } from "../types.js";

/**
 * Anthropic adapter.
 *
 * Notes on the API surface used here:
 *  - `thinking: { type: "adaptive" }` — current models decide their own depth.
 *    `budget_tokens` is rejected by these models. Not every model supports
 *    adaptive thinking at all, so it is sent per model rather than always.
 *  - `output_config.format` is the structured-output parameter (the older
 *    `output_format` is deprecated).
 *  - Streaming is used for every call: `max_tokens` on the long-form writing
 *    route exceeds what a non-streaming request can return before the SDK's
 *    HTTP timeout.
 *  - `stop_reason: "refusal"` arrives as HTTP 200, so it is checked before the
 *    content is read.
 */
export class AnthropicProvider implements AiProvider {
  readonly name = "anthropic";
  #client: Anthropic | undefined;
  readonly #apiKey: string | undefined;

  constructor(apiKey: string | undefined) {
    this.#apiKey = apiKey?.trim() || undefined;
  }

  isConfigured(): boolean {
    return this.#apiKey !== undefined;
  }

  #getClient(): Anthropic {
    if (!this.#apiKey) {
      throw new AppError("provider_error", "The Anthropic provider is not configured.");
    }
    this.#client ??= new Anthropic({ apiKey: this.#apiKey, maxRetries: 0 });
    return this.#client;
  }

  async generate(req: GenerateRequest, model: string, signal: AbortSignal): Promise<GenerateResponse> {
    const client = this.#getClient();

    // Cache the stable system prefix (rules + safety + business facts). The
    // volatile tail — task and keyword — sits after the breakpoint.
    const systemBlocks: Anthropic.TextBlockParam[] = [];
    const split = req.cacheableSystemPrefixLength;
    if (split !== undefined && split > 0 && split < req.system.length) {
      systemBlocks.push({
        type: "text",
        text: req.system.slice(0, split),
        cache_control: { type: "ephemeral" },
      });
      systemBlocks.push({ type: "text", text: req.system.slice(split) });
    } else {
      systemBlocks.push({ type: "text", text: req.system });
    }

    const params: Anthropic.MessageCreateParamsStreaming = {
      model,
      max_tokens: req.maxTokens ?? 8_000,
      system: systemBlocks,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
    };

    /*
     * Adaptive thinking, only where the model has it.
     *
     * Haiku 4.5 rejects it outright with "adaptive thinking is not supported
     * on this model" — a 400 that killed the whole rung rather than degrading.
     * Sending it unconditionally turned a fallback model into one that could
     * never answer, which is the opposite of what a fallback is for.
     */
    if (supportsAdaptiveThinking(model)) {
      params.thinking = { type: "adaptive" };
    }

    if (req.schema) {
      params.output_config = {
        format: { type: "json_schema", schema: req.schema },
      };
    }

    let message: Anthropic.Message;
    try {
      const stream = client.messages.stream(params, { signal });
      message = await stream.finalMessage();
    } catch (err) {
      throw translateError(err);
    }

    if (message.stop_reason === "refusal") {
      throw new AppError("provider_error", "The AI declined this request for safety reasons.", {
        details: { category: message.stop_details?.category ?? null },
        retryable: false,
      });
    }

    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    if (message.stop_reason === "max_tokens") {
      throw new AppError("provider_error", "The AI response was cut off before it finished.", {
        details: { stopReason: "max_tokens", partialLength: text.length },
        retryable: true,
      });
    }

    const usage = message.usage;
    return {
      text,
      parsed: req.schema ? safeParseJson(text) : undefined,
      usage: {
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      },
      model,
      provider: this.name,
      stopReason: message.stop_reason ?? "end_turn",
    };
  }
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Some models wrap JSON in a fenced block despite the schema constraint.
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

/** Map SDK exceptions onto our typed errors so retry policy is uniform. */
/**
 * Whether a model accepts `thinking: { type: "adaptive" }`.
 *
 * An allowlist by family rather than a denylist: a new model that does not
 * support it should fail closed (no thinking block, request still works)
 * rather than fail open with a 400 that takes the rung out of the chain.
 */
function supportsAdaptiveThinking(model: string): boolean {
  return /^claude-(opus|sonnet)-\d/.test(model);
}

function translateError(err: unknown): AppError {
  if (err instanceof Anthropic.APIUserAbortError) {
    return new AppError("provider_timeout", "The AI request timed out.", { cause: err, retryable: true });
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new AppError("rate_limited", "The AI provider is rate limiting us. Retrying shortly.", {
      cause: err,
      retryable: true,
    });
  }
  if (err instanceof Anthropic.AuthenticationError) {
    return new AppError("provider_error", "The AI provider rejected our credentials.", {
      cause: err,
      retryable: false,
    });
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new AppError("provider_error", "Could not reach the AI provider.", { cause: err, retryable: true });
  }
  if (err instanceof Anthropic.APIError) {
    const status = typeof err.status === "number" ? err.status : 0;
    return new AppError("provider_error", "The AI provider returned an error.", {
      cause: err,
      details: { status },
      // 4xx is our bug or our request's fault — retrying will not help.
      retryable: status === 0 || status >= 500,
    });
  }
  return new AppError("provider_error", "The AI request failed.", { cause: err, retryable: true });
}
