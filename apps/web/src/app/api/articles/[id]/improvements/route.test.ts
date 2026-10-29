import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@ob/core";

const state = vi.hoisted(() => ({
  ctx: { workspaceId: "11111111-1111-4111-8111-111111111111", userId: "22222222-2222-4222-8222-222222222222", role: "owner", correlationId: "improvements-test" },
  article: { id: "33333333-3333-4333-8333-333333333333", businessId: "44444444-4444-4444-8444-444444444444", topicId: null as string | null,
    version: 2, status: "needs_changes", updatedAt: new Date("2026-10-27T10:00:00Z"), title: "Home care questions", metaTitle: "Home care", metaDescription: null,
    bodyMarkdown: "A practical guide.\n\n## Cost questions\n\nAsk about your care plan.", seoScore: 69.6 as number | null },
  getArticle: vi.fn(), getBusiness: vi.fn(), listFacts: vi.fn(), listGateResults: vi.fn(), getScore: vi.fn(), writeAudit: vi.fn(),
  propose: vi.fn(), select: vi.fn(), update: vi.fn(), insert: vi.fn(), queryResults: [] as unknown[][],
  options: null as unknown,
}));
vi.mock("@ob/db", async original => ({ ...await original<object>(), repo: {
  getArticle: state.getArticle, getBusiness: state.getBusiness, listFacts: state.listFacts,
  listGateResults: state.listGateResults, getScore: state.getScore, writeAudit: state.writeAudit,
} }));
vi.mock("@ob/blog", () => ({ suggestScoreImprovements: state.propose, splitSections: () => [{ id: "0" }, { id: "1" }] }));
vi.mock("@/lib/services", () => ({ db: () => ({ select: state.select, update: state.update, insert: state.insert }), getGateway: () => ({ kind: "gateway" }) }));
vi.mock("@/lib/api", () => ({
  route: (handler: Function, options: unknown) => { state.options = options; return (req: Request) => handler(state.ctx, req); },
  parseBody: async (req: Request, schema: { parse: Function }) => schema.parse(await req.json()),
}));
import { POST } from "./route";

const suggestion = { id: "improvement-1", title: "Clarify the meta description", reason: "The description is missing.",
  priority: "high", target: "metaDescription", value: "Prepare for a home care consultation with practical questions about your care plan." };
const request = (body: unknown = { expectedVersion: 2 }) => new Request(`https://example.test/api/articles/${state.article.id}/improvements`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
beforeEach(() => {
  state.ctx.role = "owner";
  Object.assign(state.article, { status: "needs_changes", version: 2, updatedAt: new Date("2026-10-27T10:00:00Z"), topicId: null,
    bodyMarkdown: "A practical guide.\n\n## Cost questions\n\nAsk about your care plan.", seoScore: 69.6 });
  state.getArticle.mockReset().mockImplementation(async () => ({ ...state.article }));
  state.getBusiness.mockReset().mockResolvedValue({ id: state.article.businessId, name: "Care", audience: "Families" });
  state.listFacts.mockReset().mockResolvedValue([{ key: "service", value: "Home care", confidence: 1, verified: true }]);
  state.listGateResults.mockReset().mockResolvedValue([{ gate: "seo", verdict: "warn", findings: [{ severity: "warn", message: "Meta description is missing." }] }]);
  state.getScore.mockReset().mockResolvedValue({ components: [{ key: "meta", label: "Metadata", weight: 10, score: 0, reasons: ["Missing description"] }] });
  state.writeAudit.mockReset().mockResolvedValue(undefined);
  state.propose.mockReset().mockResolvedValue({ summary: "Start with the missing description.", suggestions: [{ ...suggestion }] });
  state.queryResults = [[{ settings: { minSeoScoreToPublish: 75 } }], [{ term: "home care cost" }]];
  state.select.mockReset().mockImplementation(() => {
    const rows = state.queryResults.shift() ?? [];
    const chain = { from: vi.fn(), where: vi.fn(), leftJoin: vi.fn(), limit: vi.fn().mockResolvedValue(rows) };
    chain.from.mockReturnValue(chain); chain.where.mockReturnValue(chain); chain.leftJoin.mockReturnValue(chain);
    return chain;
  });
  state.update.mockReset(); state.insert.mockReset();
});

describe("AI score improvement suggestions", () => {
  it("uses actual current-version findings, score components, facts, and workspace target", async () => {
    state.article.topicId = "55555555-5555-4555-8555-555555555555";
    const result = await POST(request()) as any;
    expect(result).toMatchObject({ ok: true, expectedVersion: 2, currentScore: 69.6, minimumScore: 75, suggestions: [suggestion] });
    expect(state.propose).toHaveBeenCalledWith({ kind: "gateway" }, state.ctx, expect.objectContaining({
      currentScore: 69.6, minimumScore: 75, primaryKeyword: "home care cost",
      facts: [expect.objectContaining({ key: "service", value: "Home care" })],
      gates: [expect.objectContaining({ gate: "seo", verdict: "warn" })],
      scoreComponents: [expect.objectContaining({ key: "meta", score: 0 })],
    }));
    expect(state.getArticle).toHaveBeenCalledTimes(2);
    expect(state.getArticle).toHaveBeenCalledWith(expect.anything(), state.ctx, state.article.id);
    expect(state.listGateResults).toHaveBeenCalledWith(expect.anything(), state.ctx, state.article.id, 2);
    expect(state.getScore).toHaveBeenCalledWith(expect.anything(), state.ctx, state.article.id, 2);
    expect(state.update).not.toHaveBeenCalled(); expect(state.insert).not.toHaveBeenCalled();
    expect(state.writeAudit).toHaveBeenCalledWith(expect.anything(), state.ctx, expect.objectContaining({ action: "article.score_improvements_proposed",
      after: { version: 2, currentScore: 69.6, minimumScore: 75, count: 1, targets: ["metaDescription"] } }));
  });
  it("keeps an unmeasured score null and defaults to the existing policy threshold", async () => {
    state.article.seoScore = null;
    state.queryResults = [[{ settings: {} }]];
    expect(await POST(request())).toMatchObject({ currentScore: null, minimumScore: 70 });
  });
  it("requires editor access before reading the article or spending AI budget", async () => {
    state.ctx.role = "viewer";
    await expect(POST(request())).rejects.toMatchObject({ code: "forbidden" });
    expect(state.getArticle).not.toHaveBeenCalled(); expect(state.propose).not.toHaveBeenCalled();
  });
  it("uses the tenant-scoped article lookup and does not produce another workspace's advice", async () => {
    state.getArticle.mockRejectedValue(new AppError("not_found", "That article could not be found."));
    await expect(POST(request())).rejects.toMatchObject({ code: "not_found" });
    expect(state.propose).not.toHaveBeenCalled(); expect(state.getBusiness).not.toHaveBeenCalled();
  });
  it("rejects a stale version before the model call", async () => {
    await expect(POST(request({ expectedVersion: 1 }))).rejects.toMatchObject({ code: "conflict" });
    expect(state.propose).not.toHaveBeenCalled();
  });
  it.each(["qa", "generating", "approved", "scheduled", "published", "failed"])("does not suggest unappliable edits while %s", async status => {
    state.article.status = status;
    await expect(POST(request())).rejects.toMatchObject({ code: "conflict" });
    expect(state.propose).not.toHaveBeenCalled();
  });
  it("refuses an empty draft", async () => {
    state.article.bodyMarkdown = " \n ";
    await expect(POST(request())).rejects.toMatchObject({ code: "validation_failed" });
    expect(state.propose).not.toHaveBeenCalled();
  });
  it.each(["version", "status", "updatedAt"])("discards advice when %s changes during the model call", async field => {
    state.propose.mockImplementationOnce(async () => {
      if (field === "version") state.article.version = 3;
      else if (field === "status") state.article.status = "qa";
      else state.article.updatedAt = new Date("2026-10-27T10:01:00Z");
      return { summary: "Improve the description.", suggestions: [{ ...suggestion }] };
    });
    await expect(POST(request())).rejects.toMatchObject({ code: "conflict" });
    expect(state.writeAudit).not.toHaveBeenCalled(); expect(state.update).not.toHaveBeenCalled();
  });
  it.each([
    { ...suggestion, target: "metaTitle", value: "x".repeat(71) },
    { ...suggestion, target: "section", sectionId: "99", instruction: "Improve the opening", value: undefined },
    { ...suggestion, target: "section", sectionId: "0", instruction: "x", value: undefined },
    { ...suggestion, target: "seoScore", value: "100" },
  ])("rejects malformed or unsupported generated actions", async action => {
    state.propose.mockResolvedValueOnce({ summary: "Improve this draft.", suggestions: [action] });
    await expect(POST(request())).rejects.toMatchObject({ code: "provider_error" });
    expect(state.writeAudit).not.toHaveBeenCalled(); expect(state.update).not.toHaveBeenCalled();
  });
  it("preserves the gateway's budget failure without changing the article", async () => {
    state.propose.mockRejectedValueOnce(new AppError("budget_exceeded", "The workspace AI budget is used up."));
    await expect(POST(request())).rejects.toMatchObject({ code: "budget_exceeded" });
    expect(state.writeAudit).not.toHaveBeenCalled(); expect(state.update).not.toHaveBeenCalled();
  });
  it("requires a real expected version", async () => {
    await expect(POST(request({ expectedVersion: 0 }))).rejects.toThrow();
    expect(state.getArticle).not.toHaveBeenCalled(); expect(state.propose).not.toHaveBeenCalled();
  });
  it("bounds model requests per workspace", () => {
    expect(state.options).toEqual({ rateLimit: { limit: 30, windowSeconds: 3600 } });
  });
});
