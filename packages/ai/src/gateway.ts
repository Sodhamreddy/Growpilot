import { AppError, type Logger, type TenantContext } from "@ob/core";
import type {
  AiProvider, EmbedRequest, GenerateRequest, GenerateResponse, ImageRequest, ImageResponse, ModelBinding,
} from "./types.js";
import { routeFor, computeCostMicros, IMAGE_BINDING } from "./registry.js";

/**
 * AI Gateway — spec §5.2.
 *
 * Every AI call in the platform goes through `Gateway.generate`. It:
 *   - resolves a task alias to a provider/model chain (never a hardcoded model),
 *   - enforces the per-workspace monthly budget before spending anything,
 *   - retries within a binding, then falls through to the next binding,
 *   - records model, prompt version, tokens, latency, cost and status for
 *     every attempt (spec §14.1), success or failure.
 */

export interface AiJobRecord {
  workspaceId: string;
  correlationId: string;
  taskAlias: string;
  provider: string;
  model: string;
  promptVersion: string;
  status: "succeeded" | "failed";
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costMicros: number;
  latencyMs: number;
  attemptIndex: number;
  error?: string;
}

export interface GatewayDeps {
  providers: Map<string, AiProvider>;
  logger: Logger;
  /** Persists one row per attempt. Must not throw — failures are logged only. */
  recordJob(record: AiJobRecord): Promise<void>;
  /** Spend so far this billing period, in micro-dollars. */
  spendThisPeriod(workspaceId: string): Promise<number>;
  /** Ceiling for the workspace, in micro-dollars. */
  budgetFor(workspaceId: string): Promise<number>;
}

export class Gateway {
  readonly #deps: GatewayDeps;

  constructor(deps: GatewayDeps) {
    this.#deps = deps;
  }

  async generate(ctx: TenantContext, req: GenerateRequest): Promise<GenerateResponse> {
    const route = routeFor(req.taskAlias);
    await this.#assertWithinBudget(ctx.workspaceId, req.taskAlias);

    const log = this.#deps.logger.child({
      correlationId: ctx.correlationId,
      workspaceId: ctx.workspaceId,
      taskAlias: req.taskAlias,
    });

    const errors: { binding: string; error: AppError }[] = [];
    let attemptIndex = 0;

    for (const binding of route.chain) {
      const provider = this.#deps.providers.get(binding.provider);
      if (!provider?.isConfigured()) {
        log.debug("Skipping unconfigured provider", { provider: binding.provider });
        continue;
      }

      for (let attempt = 0; attempt < route.maxAttemptsPerBinding; attempt++) {
        const started = Date.now();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), route.timeoutMs);

        try {
          const res = await provider.generate(
            { ...req, maxTokens: req.maxTokens ?? binding.maxTokens },
            binding.model,
            controller.signal,
          );
          const latencyMs = Date.now() - started;

          await this.#record({
            workspaceId: ctx.workspaceId,
            correlationId: ctx.correlationId,
            taskAlias: req.taskAlias,
            provider: res.provider,
            model: res.model,
            promptVersion: req.promptVersion,
            status: "succeeded",
            inputTokens: res.usage.inputTokens,
            outputTokens: res.usage.outputTokens,
            cacheReadTokens: res.usage.cacheReadTokens,
            costMicros: computeCostMicros(binding, res.usage),
            latencyMs,
            attemptIndex,
          });

          log.info("AI call succeeded", {
            provider: res.provider, model: res.model, latencyMs,
            inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens,
          });
          return res;
        } catch (err) {
          const appErr = err instanceof AppError
            ? err
            : new AppError("provider_error", "The AI request failed.", { cause: err });
          const latencyMs = Date.now() - started;

          await this.#record({
            workspaceId: ctx.workspaceId,
            correlationId: ctx.correlationId,
            taskAlias: req.taskAlias,
            provider: binding.provider,
            model: binding.model,
            promptVersion: req.promptVersion,
            status: "failed",
            inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costMicros: 0,
            latencyMs,
            attemptIndex,
            error: describeFailure(appErr),
          });

          log.warn("AI attempt failed", {
            provider: binding.provider, model: binding.model,
            attempt, code: appErr.code, retryable: appErr.retryable,
            details: appErr.details ?? null,
            cause: appErr.cause instanceof Error ? appErr.cause.message : undefined,
          });

          errors.push({ binding: `${binding.provider}/${binding.model}`, error: appErr });
          attemptIndex++;

          // A non-retryable failure (bad credentials, refusal) will not improve
          // with another try on the same binding — move to the next rung.
          if (!appErr.retryable) break;
          if (attempt < route.maxAttemptsPerBinding - 1) {
            await sleep(backoffMs(attempt));
          }
        } finally {
          clearTimeout(timer);
        }
      }
    }

    const summary = errors.map((e) => `${e.binding}: ${e.error.code}`).join("; ");
    throw new AppError(
      "provider_error",
      "Every AI provider for this task is unavailable right now. The job will be retried.",
      { details: { taskAlias: req.taskAlias, attempts: errors.length, summary }, retryable: true },
    );
  }

  /**
   * One image, budget-checked and recorded like every other model call.
   *
   * No retry loop: an image costs the same whether or not the attempt is
   * kept, so a failure goes back to the person who asked, who can try again.
   */
  async generateImage(ctx: TenantContext, req: ImageRequest): Promise<ImageResponse> {
    await this.#assertWithinBudget(ctx.workspaceId, "image_generation");
    const provider = this.#deps.providers.get(IMAGE_BINDING.provider);
    if (!provider?.isConfigured() || !provider.generateImage) {
      throw new AppError(
        "provider_error",
        "No image model is set up. Add a Google API key to generate images, or upload one instead.",
        { retryable: false },
      );
    }

    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), IMAGE_BINDING.timeoutMs);
    const base = {
      workspaceId: ctx.workspaceId,
      correlationId: ctx.correlationId,
      taskAlias: "image_generation",
      promptVersion: req.promptVersion,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
      attemptIndex: 0,
    };
    try {
      const res = await provider.generateImage(req, IMAGE_BINDING.model, controller.signal);
      await this.#record({
        ...base,
        provider: res.provider,
        model: res.model,
        status: "succeeded",
        // The offline stand-in costs nothing, and recording a price for it
        // would count against the budget of a workspace running on it.
        costMicros: res.provider === "local" ? 0 : IMAGE_BINDING.costMicrosPerImage,
        latencyMs: Date.now() - started,
      });
      this.#deps.logger.info("Image generated", {
        correlationId: ctx.correlationId, workspaceId: ctx.workspaceId,
        provider: res.provider, model: res.model, latencyMs: Date.now() - started,
      });
      return res;
    } catch (err) {
      const appErr = err instanceof AppError
        ? err
        : new AppError("provider_error", "The image request failed.", { cause: err });
      await this.#record({
        ...base,
        provider: IMAGE_BINDING.provider,
        model: IMAGE_BINDING.model,
        status: "failed",
        costMicros: 0,
        latencyMs: Date.now() - started,
        error: describeFailure(appErr),
      });
      throw appErr;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Embeddings for the knowledge base (spec §4). */
  async embed(ctx: TenantContext, req: EmbedRequest): Promise<{ vectors: number[][]; model: string }> {
    const route = routeFor("embedding");
    for (const binding of route.chain) {
      const provider = this.#deps.providers.get(binding.provider);
      if (!provider?.isConfigured() || !provider.embed) continue;

      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), route.timeoutMs);
      try {
        const res = await provider.embed(req, binding.model, controller.signal);
        await this.#record({
          workspaceId: ctx.workspaceId,
          correlationId: ctx.correlationId,
          taskAlias: "embedding",
          provider: res.provider,
          model: res.model,
          promptVersion: "n/a",
          status: "succeeded",
          inputTokens: res.usage.inputTokens,
          outputTokens: 0,
          cacheReadTokens: 0,
          costMicros: computeCostMicros(binding, res.usage),
          latencyMs: Date.now() - started,
          attemptIndex: 0,
        });
        return { vectors: res.vectors, model: res.model };
      } catch (err) {
        this.#deps.logger.warn("Embedding attempt failed", {
          provider: binding.provider, error: String(err),
        });
      } finally {
        clearTimeout(timer);
      }
    }
    throw new AppError("provider_error", "No embedding provider is available.");
  }

  async #assertWithinBudget(workspaceId: string, alias: string): Promise<void> {
    const [spent, budget] = await Promise.all([
      this.#deps.spendThisPeriod(workspaceId),
      this.#deps.budgetFor(workspaceId),
    ]);
    if (budget > 0 && spent >= budget) {
      throw new AppError(
        "budget_exceeded",
        "This workspace has reached its monthly AI budget. Raise the limit in Preferences to continue.",
        {
          details: {
            spentUsd: (spent / 1_000_000).toFixed(2),
            budgetUsd: (budget / 1_000_000).toFixed(2),
            taskAlias: alias,
          },
          retryable: false,
        },
      );
    }
  }

  /** Job recording must never mask the underlying AI outcome. */
  async #record(record: AiJobRecord): Promise<void> {
    try {
      await this.#deps.recordJob(record);
    } catch (err) {
      this.#deps.logger.error("Failed to record AI job", { error: String(err) });
    }
  }
}

function backoffMs(attempt: number): number {
  const base = 500 * 2 ** attempt;
  return base + Math.floor(Math.random() * 250); // jitter avoids retry convoys
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type { ModelBinding };

/**
 * A failure line that can be diagnosed without the process still running.
 *
 * `ai_jobs.error` used to hold the bare code, so every provider failure — a
 * bad key, a 429, a malformed request, an overloaded model — recorded the
 * identical string `provider_error`. That is enough to know something broke
 * and nothing about what, which turns every incident into a live reproduction
 * hunt. The HTTP status and the provider's own message are what actually
 * distinguish them, so they go in the row.
 */
function describeFailure(err: AppError): string {
  const status = (err.details as { status?: unknown } | undefined)?.status;
  const cause = err.cause instanceof Error ? err.cause.message : "";
  return [
    err.code,
    typeof status === "number" && status > 0 ? `http_${status}` : "",
    // Bounded: this column is for triage, not for storing a provider's essay.
    cause ? cause.replace(/\s+/g, " ").slice(0, 300) : "",
  ].filter(Boolean).join(" · ");
}
