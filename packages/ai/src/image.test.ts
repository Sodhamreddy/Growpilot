import { describe, it, expect, vi } from "vitest";
import { AppError, createLogger, type TenantContext } from "@ob/core";
import { Gateway, type AiJobRecord, type GatewayDeps } from "./gateway.js";
import { IMAGE_BINDING } from "./registry.js";
import { LocalProvider, gradientPng } from "./providers/local.js";
import { translateImageError } from "./providers/google.js";
import type { AiProvider } from "./types.js";

/**
 * Image generation through the gateway.
 *
 * An image is the most expensive single call in the product, so the two
 * properties that matter are the ones that protect a budget: it is refused
 * once the budget is spent, and every attempt is recorded with its cost.
 */

const ctx: TenantContext = { userId: "u1", workspaceId: "w1", role: "admin", correlationId: "req_img" };
const silentLogger = createLogger("error", {}, { log: () => {}, warn: () => {}, error: () => {} } as never);
const request = { prompt: "A stone.", aspectRatio: "4:5", promptVersion: "v1" };

function deps(google: Partial<AiProvider> | null, over: Partial<GatewayDeps> = {}) {
  const records: AiJobRecord[] = [];
  const providers = new Map<string, AiProvider>();
  if (google) {
    providers.set("google", {
      name: "google",
      isConfigured: () => true,
      generate: vi.fn(),
      ...google,
    } as AiProvider);
  }
  const d: GatewayDeps = {
    providers,
    logger: silentLogger,
    recordJob: async (r) => { records.push(r); },
    spendThisPeriod: async () => 0,
    budgetFor: async () => 50_000_000,
    ...over,
  };
  return { d, records };
}

describe("generating an image", () => {
  it("returns the image and records its per-image cost", async () => {
    const { d, records } = deps({
      generateImage: async (_r, model) => ({ data: new Uint8Array([1, 2]), mimeType: "image/png", provider: "google", model }),
    });
    const res = await new Gateway(d).generateImage(ctx, request);
    expect(res.mimeType).toBe("image/png");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      taskAlias: "image_generation", status: "succeeded", model: IMAGE_BINDING.model,
      costMicros: IMAGE_BINDING.costMicrosPerImage,
    });
  });

  it("refuses once the workspace budget is spent, without calling the model", async () => {
    const generateImage = vi.fn();
    const { d } = deps({ generateImage }, { spendThisPeriod: async () => 10, budgetFor: async () => 10 });
    await expect(new Gateway(d).generateImage(ctx, request)).rejects.toMatchObject({ code: "budget_exceeded" });
    expect(generateImage).not.toHaveBeenCalled();
  });

  it("records a failed attempt at no cost and passes the error on", async () => {
    const { d, records } = deps({
      generateImage: async () => { throw new AppError("rate_limited", "Slow down.", { retryable: true }); },
    });
    await expect(new Gateway(d).generateImage(ctx, request)).rejects.toMatchObject({ code: "rate_limited" });
    expect(records[0]).toMatchObject({ status: "failed", costMicros: 0 });
  });

  it("says plainly when no image model is set up", async () => {
    const { d } = deps(null);
    await expect(new Gateway(d).generateImage(ctx, request)).rejects.toThrow(/No image model is set up/);
  });

  it("charges nothing for the offline placeholder", async () => {
    const local = new LocalProvider();
    const { d, records } = deps({ generateImage: local.generateImage.bind(local) });
    await new Gateway(d).generateImage(ctx, request);
    expect(records[0]).toMatchObject({ provider: "local", costMicros: 0 });
  });
});

describe("the offline placeholder", () => {
  it("is a real PNG at the requested ratio", async () => {
    const res = await new LocalProvider().generateImage({ ...request, aspectRatio: "9:16" }, "local");
    const png = Buffer.from(res.data);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.readUInt32BE(16)).toBe(400); // IHDR width
    expect(png.readUInt32BE(20)).toBe(711); // 400 × 16 / 9
  });

  it("encodes a tiny gradient without an image library", () => {
    expect(Buffer.from(gradientPng(2, 2, [0, 0, 0], [255, 255, 255])).length).toBeGreaterThan(50);
  });
});

describe("reading Google's image errors", () => {
  it("names the free-tier limit instead of promising a retry", () => {
    const err = translateImageError(Object.assign(new Error(
      "Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0",
    ), { status: 429 }));
    expect(err.code).toBe("provider_error");
    expect(err.retryable).toBe(false);
    expect(err.safeMessage).toMatch(/Turn on billing/);
  });

  it("treats an ordinary rate limit as one", () => {
    const err = translateImageError(Object.assign(new Error("Too many requests"), { status: 429 }));
    expect(err.code).toBe("rate_limited");
  });
});
