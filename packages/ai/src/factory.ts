import type { AiProvider } from "./types.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { GoogleProvider } from "./providers/google.js";
import { LocalProvider } from "./providers/local.js";

/**
 * Assemble the provider map the Gateway routes across.
 *
 * With AI_MOCK=1 every alias resolves to the deterministic local provider, so
 * CI and offline development run the whole pipeline with no credentials.
 */
export function buildProviders(env: {
  ANTHROPIC_API_KEY?: string | undefined;
  GOOGLE_API_KEY?: string | undefined;
  AI_MOCK: number;
}): Map<string, AiProvider> {
  const local = new LocalProvider();
  const providers = new Map<string, AiProvider>();

  if (env.AI_MOCK === 1) {
    for (const name of ["anthropic", "openai", "google", "local"]) {
      providers.set(name, local);
    }
    return providers;
  }

  // Every configured provider is registered. The routing table decides which
  // one serves each task alias, and the gateway skips any that is unconfigured
  // — so a workspace with only a Google key still works end to end.
  providers.set("anthropic", new AnthropicProvider(env.ANTHROPIC_API_KEY));
  providers.set("google", new GoogleProvider(env.GOOGLE_API_KEY));
  providers.set("local", local);
  return providers;
}
