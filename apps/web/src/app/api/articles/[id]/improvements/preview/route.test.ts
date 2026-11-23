import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@ob/core";

const state = vi.hoisted(() => ({
  ctx: { workspaceId: "11111111-1111-4111-8111-111111111111", userId: "22222222-2222-4222-8222-222222222222", role: "owner", correlationId: "test" },
  article: { id: "33333333-3333-4333-8333-333333333333", businessId: "44444444-4444-4444-8444-444444444444", topicId: null as string | null,
    version: 2, status: "needs_changes", updatedAt: new Date("2026-10-27T10:00:00Z"), title: "Home care questions", metaTitle: null, metaDescription: null,
    bodyMarkdown: "Original opening.\n\n## Planning\n\nOriginal planning.", seoScore: 69.6 },
  getArticle: vi.fn(), getBusiness: vi.fn(), listFacts: vi.fn(), getActiveVoice: vi.fn(), listGateResults: vi.fn(), getScore: vi.fn(), retrieve: vi.fn(), writeAudit: vi.fn(),
  preview: vi.fn(), select: vi.fn(), update: vi.fn(), insert: vi.fn(), rows: [] as unknown[][],
}));
vi.mock("@ob/db", async original => ({ ...await original<object>(), repo: {
  getArticle: state.getArticle, getBusiness: state.getBusiness, listFacts: state.listFacts, getActiveVoice: state.getActiveVoice, writeAudit: state.writeAudit,
  listGateResults: state.listGateResults, getScore: state.getScore,
} }));
vi.mock("@ob/blog", () => ({ previewScoreImprovements: state.preview }));
vi.mock("@ob/kb", () => ({ retrieve: state.retrieve }));
vi.mock("@/lib/services", () => ({ db: () => ({ select: state.select, update: state.update, insert: state.insert }), getGateway: () => ({ kind: "gateway" }) }));
vi.mock("@/lib/api", () => ({ route: (handler: Function) => (req: Request) => handler(state.ctx, req),
  parseBody: async (req: Request, schema: { parse: Function }) => schema.parse(await req.json()) }));
import { POST } from "./route";

const metadata = { id: "improvement-1", title: "Clarify metadata", reason: "The description is missing.", priority: "high", target: "metaDescription", value: "Useful home care questions." };
const section = { id: "improvement-2", title: "Expand the opening", reason: "The opening lacks context.", priority: "medium", target: "section", sectionId: "0", instruction: "Explain the purpose more clearly." };
const request = (body: unknown = { expectedVersion: 2, suggestions: [metadata, section] }) => new Request(`https://example.test/api/articles/${state.article.id}/improvements/preview`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
beforeEach(() => {
  state.ctx.role = "owner";
  Object.assign(state.article, { version: 2, status: "needs_changes", updatedAt: new Date("2026-10-27T10:00:00Z"), topicId: null,
    bodyMarkdown: "Original opening.\n\n## Planning\n\nOriginal planning." });
  state.getArticle.mockReset().mockImplementation(async () => ({ ...state.article }));
  state.getBusiness.mockReset().mockResolvedValue({ name: "Care" }); state.listFacts.mockReset().mockResolvedValue([]);
  state.getActiveVoice.mockReset().mockResolvedValue(null); state.writeAudit.mockReset().mockResolvedValue(undefined);
  state.listGateResults.mockReset().mockResolvedValue([{ gate: "brand", verdict: "warn", findings: [{ severity: "warn", message: "Use the approved style." }] }]);
  state.getScore.mockReset().mockResolvedValue({ components: [] });
  state.retrieve.mockReset().mockResolvedValue([{ content: "Approved business evidence.", sourceUrl: "https://care.example/about" }]);
  state.preview.mockReset().mockResolvedValue({ changes: [{ suggestionId: metadata.id, target: "metaDescription", before: "", after: metadata.value, changed: true },
    { suggestionId: section.id, target: "section", sectionId: "0", before: "Original opening.", after: "Revised opening.", changed: true }],
    patch: { metaDescription: metadata.value, bodyMarkdown: "Revised opening.\n\n## Planning\n\nOriginal planning." } });
  state.rows = [[{ settings: { minSeoScoreToPublish: 75 } }]];
  state.select.mockReset().mockImplementation(() => {
    const rows = state.rows.shift() ?? [];
    const chain = { from: vi.fn(), where: vi.fn(), leftJoin: vi.fn(), limit: vi.fn().mockResolvedValue(rows) };
    chain.from.mockReturnValue(chain); chain.where.mockReturnValue(chain); chain.leftJoin.mockReturnValue(chain); return chain;
  });
  state.update.mockReset(); state.insert.mockReset();
});

describe("combined score improvement preview", () => {
  it("prepares metadata and selected sections together without saving or enqueueing", async () => {
    const result = await POST(request());
    expect(result).toMatchObject({ ok: true, expectedVersion: 2, patch: { metaDescription: metadata.value }, changes: expect.any(Array) });
    expect(state.preview).toHaveBeenCalledTimes(1);
    expect(state.preview).toHaveBeenCalledWith({ kind: "gateway" }, state.ctx, expect.objectContaining({
      suggestions: [metadata, section], minimumScore: 75, currentScore: 69.6, primaryKeyword: "Home care questions", voice: null,
    }));
    expect(state.update).not.toHaveBeenCalled(); expect(state.insert).not.toHaveBeenCalled();
    expect(state.writeAudit).toHaveBeenCalledWith(expect.anything(), state.ctx, expect.objectContaining({ action: "article.score_improvements_previewed" }));
  });
  it("requires editor access before reading or spending AI budget", async () => {
    state.ctx.role = "viewer";
    await expect(POST(request())).rejects.toMatchObject({ code: "forbidden" });
    expect(state.getArticle).not.toHaveBeenCalled(); expect(state.preview).not.toHaveBeenCalled();
  });
  it("does not spend on knowledge retrieval when only selected metadata is being previewed", async () => {
    await POST(request({ expectedVersion: 2, suggestions: [metadata] }));
    expect(state.retrieve).not.toHaveBeenCalled();
  });
  it("prepares a whole-article action with current findings and evidence", async () => {
    const whole = { id: "whole", title: "Improve all quality areas", reason: "Resolve brand and clarity findings.", priority: "high", target: "article", instruction: "Improve brand voice, factual grounding and readability throughout.", checks: ["brand", "facts", "readability"] };
    await POST(request({ expectedVersion: 2, suggestions: [whole, metadata] }));
    expect(state.preview).toHaveBeenCalledWith(expect.anything(), state.ctx, expect.objectContaining({ suggestions: [whole, metadata],
      gates: [expect.objectContaining({ gate: "brand" })], evidence: [expect.objectContaining({ sourceUrl: "https://care.example/about" })] }));
  });
  it("rejects overlapping whole-article and section edits before spending AI budget", async () => {
    const whole = { id: "whole", title: "Improve article", reason: "Resolve all findings.", priority: "high", target: "article", instruction: "Improve the full body." };
    await expect(POST(request({ expectedVersion: 2, suggestions: [whole, section] }))).rejects.toThrow();
    expect(state.preview).not.toHaveBeenCalled();
  });
  it("preserves tenant access checks", async () => {
    state.getArticle.mockRejectedValue(new AppError("not_found", "Not found"));
    await expect(POST(request())).rejects.toMatchObject({ code: "not_found" });
    expect(state.preview).not.toHaveBeenCalled();
  });
  it("rejects an outdated original version", async () => {
    await expect(POST(request({ expectedVersion: 1, suggestions: [metadata] }))).rejects.toMatchObject({ code: "conflict" });
    expect(state.preview).not.toHaveBeenCalled();
  });
  it.each(["qa", "generating", "approved", "scheduled", "published", "failed"])("refuses preview while %s", async status => {
    state.article.status = status;
    await expect(POST(request())).rejects.toMatchObject({ code: "conflict" });
    expect(state.preview).not.toHaveBeenCalled();
  });
  it.each([[], [metadata, metadata], [metadata, { ...metadata, id: "other" }], [section, { ...section, id: "other" }],
    [{ ...metadata, target: "seoScore" }], [{ ...metadata, value: "x".repeat(161) }]].map(suggestions => ({ suggestions })))("rejects invalid or duplicate selections (%j)", async ({ suggestions }) => {
    await expect(POST(request({ expectedVersion: 2, suggestions }))).rejects.toThrow();
    expect(state.preview).not.toHaveBeenCalled();
  });
  it.each(["version", "status", "updatedAt"])("rejects when %s changes during preview", async field => {
    state.preview.mockImplementationOnce(async () => {
      if (field === "version") state.article.version++;
      else if (field === "status") state.article.status = "qa";
      else state.article.updatedAt = new Date("2026-10-27T11:00:00Z");
      return { changes: [], patch: {} };
    });
    await expect(POST(request())).rejects.toMatchObject({ code: "conflict" });
    expect(state.writeAudit).not.toHaveBeenCalled();
  });
  it("propagates provider or budget failure without writing the draft", async () => {
    state.preview.mockRejectedValueOnce(new AppError("budget_exceeded", "Budget used up"));
    await expect(POST(request())).rejects.toMatchObject({ code: "budget_exceeded" });
    expect(state.update).not.toHaveBeenCalled(); expect(state.insert).not.toHaveBeenCalled(); expect(state.writeAudit).not.toHaveBeenCalled();
  });
});
