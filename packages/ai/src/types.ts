/**
 * Provider-neutral AI contracts — spec §5.2.
 *
 * The dashboard and workers speak only these types. No application code
 * imports a vendor SDK, so swapping or adding a provider is a change to
 * `registry.ts` and one adapter file, never to a feature.
 */

export type TaskAlias =
  | "reasoning_high"
  | "writing_long"
  | "structured_json"
  | "bulk_classification"
  | "research_grounded"
  | "editing_rewrite"
  | "embedding";

export interface AiMessage {
  role: "user" | "assistant";
  content: string;
}

export interface GenerateRequest {
  taskAlias: TaskAlias;
  /** Layered system prompt. Order is enforced by `composeSystemPrompt` (§18.4). */
  system: string;
  messages: AiMessage[];
  maxTokens?: number;
  /** JSON Schema. When set, the provider is asked to emit conforming JSON. */
  schema?: Record<string, unknown>;
  promptVersion: string;
  /** Stable prefix boundary hint for providers that support prompt caching. */
  cacheableSystemPrefixLength?: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export interface GenerateResponse {
  text: string;
  usage: Usage;
  model: string;
  provider: string;
  /** Populated when the request declared a schema and parsing succeeded. */
  parsed?: unknown;
  stopReason: string;
}

export interface EmbedRequest {
  texts: string[];
}

export interface EmbedResponse {
  vectors: number[][];
  usage: Usage;
  model: string;
  provider: string;
}

export interface AiProvider {
  readonly name: string;
  /** Whether credentials are present. Unavailable providers are skipped. */
  isConfigured(): boolean;
  generate(req: GenerateRequest, model: string, signal: AbortSignal): Promise<GenerateResponse>;
  embed?(req: EmbedRequest, model: string, signal: AbortSignal): Promise<EmbedResponse>;
}

/** One rung of a fallback chain (spec §5.2 "Support fallback providers"). */
export interface ModelBinding {
  provider: string;
  model: string;
  /** Cost in micro-dollars per 1M tokens. */
  inputCostPerMTok: number;
  outputCostPerMTok: number;
  maxTokens: number;
}

export interface RoutePolicy {
  alias: TaskAlias;
  /** Tried in order. First configured provider that succeeds wins. */
  chain: ModelBinding[];
  timeoutMs: number;
  maxAttemptsPerBinding: number;
}
