import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * `AI_PRIMARY` reorders every generative chain.
 *
 * The property worth pinning is that this is a *reorder*, not a filter. It
 * would be easy to implement "Gemini only" by dropping the Anthropic rungs,
 * and it would work right up until Gemini had an outage — at which point the
 * pipeline would stop instead of falling back to a provider that was
 * configured and available the whole time. A chain with one rung is not a
 * chain.
 *
 * The registry reads the env var at module load, so each case re-imports with
 * a fresh module registry.
 */

const ALIASES = [
  "reasoning_high", "writing_long", "editing_rewrite",
  "structured_json", "bulk_classification", "research_grounded",
] as const;

async function loadRoutes(primary?: string, only?: string) {
  vi.resetModules();
  if (primary === undefined) delete process.env["AI_PRIMARY"];
  else process.env["AI_PRIMARY"] = primary;
  if (only === undefined) delete process.env["AI_ONLY"];
  else process.env["AI_ONLY"] = only;
  // Google needs a model id to produce a rung at all.
  process.env["GOOGLE_MODEL"] ??= "gemini-2.5-flash";
  return (await import("./registry.js")).ROUTES;
}

const originalPrimary = process.env["AI_PRIMARY"];
const originalOnly = process.env["AI_ONLY"];
beforeEach(() => {
  delete process.env["AI_PRIMARY"];
  delete process.env["AI_ONLY"];
});
afterEach(() => {
  if (originalPrimary === undefined) delete process.env["AI_PRIMARY"];
  else process.env["AI_PRIMARY"] = originalPrimary;
  if (originalOnly === undefined) delete process.env["AI_ONLY"];
  else process.env["AI_ONLY"] = originalOnly;
});

describe("AI_PRIMARY=google", () => {
  it("puts google first on every generative chain", async () => {
    const routes = await loadRoutes("google");
    for (const alias of ALIASES) {
      expect(routes[alias].chain[0]!.provider, alias).toBe("google");
    }
  });

  it("keeps anthropic available as a fallback rather than removing it", async () => {
    const routes = await loadRoutes("google");
    for (const alias of ALIASES) {
      const providers = routes[alias].chain.map((b) => b.provider);
      expect(providers, alias).toContain("anthropic");
      // Present, but never first.
      expect(providers.indexOf("anthropic"), alias).toBeGreaterThan(0);
    }
  });

  it("loses no rungs — the chain is reordered, not filtered", async () => {
    const def = await loadRoutes(undefined);
    const lengths = ALIASES.map((a) => def[a].chain.length);
    const google = await loadRoutes("google");
    expect(ALIASES.map((a) => google[a].chain.length)).toEqual(lengths);
  });

  it("is case-insensitive", async () => {
    const routes = await loadRoutes("GOOGLE");
    expect(routes.writing_long.chain[0]!.provider).toBe("google");
  });
});

describe("default and unknown values", () => {
  it("leads with anthropic when unset", async () => {
    const routes = await loadRoutes(undefined);
    expect(routes.writing_long.chain[0]!.provider).toBe("anthropic");
  });

  it("leaves the order alone for a provider that is not in any chain", async () => {
    // A typo must not silently empty a chain or reshuffle it into nonsense.
    const def = await loadRoutes(undefined);
    const before = def.writing_long.chain.map((b) => b.model);
    const typo = await loadRoutes("gogle");
    expect(typo.writing_long.chain.map((b) => b.model)).toEqual(before);
  });
});

describe("embedding is left alone", () => {
  it("still leads with the configured embedding provider", async () => {
    const routes = await loadRoutes("google");
    // Its chain is already provider-configured and has no anthropic rung —
    // reordering it by the generative primary would be meaningless.
    const last = routes.embedding.chain.at(-1)!;
    expect(last.provider).toBe("local");
    expect(routes.embedding.chain).toHaveLength(2);
  });
});

describe("AI_ONLY=google", () => {
  it("leaves exactly one provider on every generative chain", async () => {
    const routes = await loadRoutes(undefined, "google");
    for (const alias of ALIASES) {
      const providers = new Set(routes[alias].chain.map((b) => b.provider));
      expect([...providers], alias).toEqual(["google"]);
    }
  });

  it("removes anthropic entirely, rather than demoting it", async () => {
    // The difference that matters: an ordered chain still falls through on a
    // failure and spends on the other provider. A workspace that chose one
    // provider did not choose that.
    const routes = await loadRoutes(undefined, "google");
    for (const alias of ALIASES) {
      expect(routes[alias].chain.map((b) => b.provider), alias).not.toContain("anthropic");
    }
  });

  it("ignores a value that would empty a chain", async () => {
    /*
     * A typo must not leave a task with nowhere to run. Failing loudly on the
     * first call beats an alias that can never resolve, so an unmatched
     * AI_ONLY falls back to ordering rather than filtering to nothing.
     */
    const def = await loadRoutes(undefined, undefined);
    const typo = await loadRoutes(undefined, "gogle");
    for (const alias of ALIASES) {
      expect(typo[alias].chain.length, alias).toBe(def[alias].chain.length);
    }
  });

  it("takes precedence over AI_PRIMARY", async () => {
    const routes = await loadRoutes("anthropic", "google");
    expect(routes.writing_long.chain.every((b) => b.provider === "google")).toBe(true);
  });

  it("leaves the local embedding fallback alone", async () => {
    // `local` is a deterministic in-process hasher, not a provider that costs
    // anything or leaves the machine, so restricting providers does not apply.
    const routes = await loadRoutes(undefined, "google");
    expect(routes.embedding.chain.map((b) => b.provider)).toContain("local");
  });
});
