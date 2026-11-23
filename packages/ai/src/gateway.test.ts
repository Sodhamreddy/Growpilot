import { describe, it, expect, vi, beforeEach } from "vitest";
import { AppError, createLogger, type TenantContext } from "@ob/core";
import { Gateway, type AiJobRecord, type GatewayDeps } from "./gateway.js";
import type { AiProvider, GenerateResponse } from "./types.js";

const ctx: TenantContext = {
  userId: "u1",
  workspaceId: "w1",
  role: "admin",
  correlationId: "req_test",
};

const silentLogger = createLogger("error", {}, { log: () => {}, warn: () => {}, error: () => {} } as never);

function ok(provider: string, model: string): GenerateResponse {
  return {
    text: "generated",
    usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0 },
    model,
    provider,
    stopReason: "end_turn",
  };
}

function stubProvider(name: string, impl: Partial<AiProvider> = {}): AiProvider {
  return {
    name,
    isConfigured: () => true,
    generate: vi.fn(async (_req, model) => ok(name, model)),
    ...impl,
  };
}

function deps(providers: Map<string, AiProvider>, over: Partial<GatewayDeps> = {}): GatewayDeps {
  return {
    providers,
    logger: silentLogger,
    recordJob: vi.fn(async () => {}),
    spendThisPeriod: async () => 0,
    budgetFor: async () => 50_000_000,
    ...over,
  };
}

const request = {
  taskAlias: "structured_json" as const,
  system: "rules",
  messages: [{ role: "user" as const, content: "hi" }],
  promptVersion: "v1",
};

describe("Gateway — routing and fallback", () => {
  it("uses the first configured provider in the chain", async () => {
    const anthropic = stubProvider("anthropic");
    const g = new Gateway(deps(new Map([["anthropic", anthropic]])));
    const res = await g.generate(ctx, request);
    expect(res.provider).toBe("anthropic");
    expect(anthropic.generate).toHaveBeenCalledOnce();
  });

  it("skips an unconfigured provider without calling it", async () => {
    const unconfigured = stubProvider("anthropic", { isConfigured: () => false });
    const g = new Gateway(deps(new Map([["anthropic", unconfigured], ["local", stubProvider("local")]])));
    await expect(g.generate(ctx, request)).rejects.toThrow(AppError);
    expect(unconfigured.generate).not.toHaveBeenCalled();
  });

  it("retries a retryable failure on the same binding", async () => {
    let calls = 0;
    const flaky = stubProvider("anthropic", {
      generate: vi.fn(async (_req, model) => {
        if (++calls === 1) throw new AppError("rate_limited", "slow down", { retryable: true });
        return ok("anthropic", model);
      }),
    });
    const g = new Gateway(deps(new Map([["anthropic", flaky]])));
    const res = await g.generate(ctx, request);
    expect(res.text).toBe("generated");
    expect(calls).toBe(2);
  });

  it("does not retry a non-retryable failure on the same binding", async () => {
    const auth = vi.fn(async () => {
      throw new AppError("provider_error", "bad key", { retryable: false });
    });
    const g = new Gateway(deps(new Map([["anthropic", stubProvider("anthropic", { generate: auth })]])));
    await expect(g.generate(ctx, request)).rejects.toThrow(AppError);
    // Two bindings in the structured_json chain are both anthropic, so the
    // provider is called once per binding, never twice for one binding.
    expect(auth).toHaveBeenCalledTimes(2);
  });

  it("surfaces a summary when every provider fails", async () => {
    const g = new Gateway(
      deps(new Map([["anthropic", stubProvider("anthropic", {
        generate: async () => { throw new AppError("provider_error", "boom"); },
      })]])),
    );
    try {
      await g.generate(ctx, request);
      expect.unreachable();
    } catch (e) {
      const err = e as AppError;
      expect(err.code).toBe("provider_error");
      expect(err.retryable).toBe(true);
      expect(err.safeMessage).toMatch(/unavailable right now/);
      expect(String(err.details["summary"])).toContain("anthropic");
    }
  });
});

describe("Gateway — budget enforcement (spec §5.2)", () => {
  it("refuses to spend when the workspace is over budget", async () => {
    const provider = stubProvider("anthropic");
    const g = new Gateway(
      deps(new Map([["anthropic", provider]]), {
        spendThisPeriod: async () => 50_000_000,
        budgetFor: async () => 50_000_000,
      }),
    );
    try {
      await g.generate(ctx, request);
      expect.unreachable();
    } catch (e) {
      const err = e as AppError;
      expect(err.code).toBe("budget_exceeded");
      expect(err.retryable).toBe(false);
      expect(err.safeMessage).toMatch(/monthly AI budget/);
    }
    // Critically: the provider is never called, so no money is spent.
    expect(provider.generate).not.toHaveBeenCalled();
  });

  it("allows spending below the budget", async () => {
    const g = new Gateway(
      deps(new Map([["anthropic", stubProvider("anthropic")]]), {
        spendThisPeriod: async () => 10_000_000,
        budgetFor: async () => 50_000_000,
      }),
    );
    await expect(g.generate(ctx, request)).resolves.toBeDefined();
  });

  it("treats a zero budget as unlimited rather than as blocked", async () => {
    const g = new Gateway(
      deps(new Map([["anthropic", stubProvider("anthropic")]]), {
        spendThisPeriod: async () => 999_000_000,
        budgetFor: async () => 0,
      }),
    );
    await expect(g.generate(ctx, request)).resolves.toBeDefined();
  });
});

describe("Gateway — observability (spec §14.1)", () => {
  let records: AiJobRecord[];

  beforeEach(() => {
    records = [];
  });

  it("records a success with model, prompt version, tokens and cost", async () => {
    const g = new Gateway(
      deps(new Map([["anthropic", stubProvider("anthropic")]]), {
        recordJob: async (r) => { records.push(r); },
      }),
    );
    await g.generate(ctx, request);

    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.status).toBe("succeeded");
    expect(r.promptVersion).toBe("v1");
    expect(r.taskAlias).toBe("structured_json");
    expect(r.correlationId).toBe("req_test");
    expect(r.workspaceId).toBe("w1");
    expect(r.inputTokens).toBe(1000);
    expect(r.outputTokens).toBe(500);
    // sonnet-5: 1000 in @ $2/MTok + 500 out @ $10/MTok = $0.007 = 7000 micros.
    expect(r.costMicros).toBe(7000);
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("records failed attempts too, not just successes", async () => {
    const g = new Gateway(
      deps(new Map([["anthropic", stubProvider("anthropic", {
        generate: async () => { throw new AppError("provider_error", "boom", { retryable: false }); },
      })]]), { recordJob: async (r) => { records.push(r); } }),
    );
    await expect(g.generate(ctx, request)).rejects.toThrow();

    expect(records.length).toBeGreaterThan(0);
    expect(records.every((r) => r.status === "failed")).toBe(true);
    expect(records[0]!.error).toBe("provider_error");
    expect(records[0]!.costMicros).toBe(0);
  });

  it("records what the provider actually said, not just the code", async () => {
    /*
     * Every provider failure used to record the single word `provider_error` —
     * a bad key, a 429 and a malformed request were indistinguishable in the
     * table. Diagnosing one then required reproducing it live. The status and
     * the provider's message are what tell them apart, so they belong in the
     * row that outlives the process.
     */
    const g = new Gateway(
      deps(new Map([["anthropic", stubProvider("anthropic", {
        generate: async () => {
          throw new AppError("provider_error", "The AI provider returned an error.", {
            cause: new Error("overloaded_error: the model is temporarily overloaded"),
            details: { status: 529 },
            retryable: false,
          });
        },
      })]]), { recordJob: async (r) => { records.push(r); } }),
    );
    await expect(g.generate(ctx, request)).rejects.toThrow();

    const line = records[0]!.error!;
    expect(line).toContain("provider_error");
    expect(line).toContain("http_529");
    expect(line).toContain("overloaded");
  });

  it("keeps the recorded failure bounded", async () => {
    const g = new Gateway(
      deps(new Map([["anthropic", stubProvider("anthropic", {
        generate: async () => {
          throw new AppError("provider_error", "boom", {
            cause: new Error("x".repeat(5_000)),
            retryable: false,
          });
        },
      })]]), { recordJob: async (r) => { records.push(r); } }),
    );
    await expect(g.generate(ctx, request)).rejects.toThrow();

    // A provider that returns a wall of text must not write a wall of text
    // into every row of the job table.
    expect(records[0]!.error!.length).toBeLessThan(400);
  });

  it("does not fail the AI call when job recording throws", async () => {
    const g = new Gateway(
      deps(new Map([["anthropic", stubProvider("anthropic")]]), {
        recordJob: async () => { throw new Error("database is down"); },
      }),
    );
    // Observability is best-effort; it must never break the feature.
    await expect(g.generate(ctx, request)).resolves.toBeDefined();
  });
});

describe("budget reservation before provider work", () => {
  it("never invokes a provider when the atomic reservation rejects", async () => {
    const provider = stubProvider("anthropic");
    const g = new Gateway(deps(new Map([["anthropic", provider]]), { reserveBudget: async () => { throw new AppError("budget_exceeded", "Budget held by another job."); } }));
    await expect(g.generate(ctx, request)).rejects.toMatchObject({ code: "budget_exceeded" });
    expect(provider.generate).not.toHaveBeenCalled();
  });
  it("reserves embedding cost and passes the reservation into usage settlement", async () => {
    const reserveBudget = vi.fn(async () => "reservation-1");
    const recordJob = vi.fn(async () => {});
    const provider = stubProvider("google", { embed: async () => ({ vectors: [[1]], model: "test", provider: "google", usage: { inputTokens: 10, outputTokens: 0 } }) });
    const g = new Gateway(deps(new Map([["google", provider]]), { reserveBudget, recordJob }));
    await g.embed(ctx, { texts: ["embedding input"] });
    expect(reserveBudget.mock.calls[0]![1]).toBeGreaterThan(0);
    expect(recordJob).toHaveBeenCalledWith(expect.objectContaining({ reservationId: "reservation-1", taskAlias: "embedding" }));
  });
});

describe("Gateway — a used-up daily allowance", () => {
  it("says so plainly instead of 'unavailable', and does not retry", async () => {
    const quota = vi.fn(async () => {
      throw new AppError("rate_limited", "Your Google AI key has used its free daily allowance (20 requests a day).", { retryable: false });
    });
    const g = new Gateway(deps(new Map([["anthropic", stubProvider("anthropic", { generate: quota })]])));
    await expect(g.generate(ctx, request)).rejects.toMatchObject({
      code: "rate_limited", retryable: false, message: expect.stringContaining("free daily allowance"),
    });
    expect(quota).toHaveBeenCalledTimes(2); // once per binding, never retried on the same one
  });
});
