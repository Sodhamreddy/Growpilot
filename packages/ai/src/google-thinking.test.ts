import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Gemini's thinking allowance.
 *
 * Gemini 2.5 counts thinking against maxOutputTokens, so a caller's small
 * limit used to be spent thinking and the JSON answer was cut off: the
 * content-quality review failed every time and capped every article's score.
 */

const calls: { model: string; config: Record<string, unknown> }[] = [];
let reply: { text: string; finishReason: string } = { text: "{}", finishReason: "STOP" };
let failure: unknown = null;

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = {
      generateContent: async ({ model, config }: { model: string; config: Record<string, unknown> }) => {
        calls.push({ model, config });
        if (failure) throw failure;
        return { text: reply.text, candidates: [{ finishReason: reply.finishReason }], usageMetadata: { candidatesTokenCount: 40 } };
      },
    };
  },
}));

const { GoogleProvider, THINKING_BUDGET } = await import("./providers/google.js");
const request = (maxTokens?: number) => ({
  taskAlias: "structured_json" as const, system: "s", messages: [{ role: "user" as const, content: "u" }],
  schema: { type: "object", properties: { score: { type: "number" } } }, promptVersion: "test", ...(maxTokens ? { maxTokens } : {}),
});

describe("Gemini thinking allowance", () => {
  beforeEach(() => { calls.length = 0; failure = null; reply = { text: '{"score":90}', finishReason: "STOP" }; });

  it("gives thinking models their own budget on top of the answer's limit", async () => {
    await new GoogleProvider("key").generate(request(1200), "gemini-2.5-flash", new AbortController().signal);
    expect(calls[0]!.config["maxOutputTokens"]).toBe(1200 + THINKING_BUDGET);
    expect(calls[0]!.config["thinkingConfig"]).toEqual({ thinkingBudget: THINKING_BUDGET });
  });

  it("leaves models that do not think alone", async () => {
    await new GoogleProvider("key").generate(request(1200), "gemini-2.5-flash-lite", new AbortController().signal);
    expect(calls[0]!.config["maxOutputTokens"]).toBe(1200);
    expect(calls[0]!.config["thinkingConfig"]).toBeUndefined();
  });

  it("reports a structured answer cut off by the limit as a retryable failure", async () => {
    reply = { text: '{"score": 9', finishReason: "MAX_TOKENS" };
    await expect(new GoogleProvider("key").generate(request(1200), "gemini-2.5-flash", new AbortController().signal))
      .rejects.toMatchObject({ code: "provider_error", retryable: true });
  });

  it("still returns a complete answer that happened to reach the limit", async () => {
    reply = { text: '{"score":90}', finishReason: "MAX_TOKENS" };
    const res = await new GoogleProvider("key").generate(request(1200), "gemini-2.5-flash", new AbortController().signal);
    expect(res.parsed).toEqual({ score: 90 });
  });
});

describe("Google's free daily allowance", () => {
  beforeEach(() => { calls.length = 0; failure = null; });

  it("is reported as used up, with the fix, and is not retried", async () => {
    failure = Object.assign(new Error('{"error":{"code":429,"message":"You exceeded your current quota","details":[{"violations":[{"quotaMetric":"generativelanguage.googleapis.com/generate_content_free_tier_requests","quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier","quotaValue":"20"}]}]}}'), { status: 429 });
    await expect(new GoogleProvider("key").generate(request(), "gemini-2.5-flash", new AbortController().signal)).rejects.toMatchObject({
      code: "rate_limited", retryable: false,
      message: expect.stringMatching(/free daily allowance \(20 requests a day\).*billing/),
    });
  });

  it("keeps an ordinary per-minute rate limit retryable", async () => {
    failure = Object.assign(new Error("Resource has been exhausted (e.g. check quota)."), { status: 429 });
    await expect(new GoogleProvider("key").generate(request(), "gemini-2.5-flash", new AbortController().signal))
      .rejects.toMatchObject({ code: "rate_limited", retryable: true });
  });
});
