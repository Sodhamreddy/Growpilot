import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  article: { id: "33333333-3333-4333-8333-333333333333", status: "failed", version: 1 },
  ctx: { workspaceId: "11111111-1111-4111-8111-111111111111", userId: "22222222-2222-4222-8222-222222222222", role: "owner", correlationId: "retry-test" },
  getArticle: vi.fn(), getJob: vi.fn(), enqueue: vi.fn(),
}));
vi.mock("@ob/db", async original => ({ ...await original<object>(), repo: { getArticle: state.getArticle } }));
vi.mock("@/lib/api", () => ({ route: (handler: Function) => (req: Request) => handler(state.ctx, req) }));
vi.mock("@/lib/services", () => ({ db: () => ({}), getQueues: () => ({ get: () => ({ getJob: state.getJob }), enqueue: state.enqueue }) }));
import { GET, POST } from "./route";

const request = () => new Request(`https://example.test/api/articles/${state.article.id}/generate`, { method: "POST" });
beforeEach(() => {
  state.article.status = "failed"; state.article.version = 1; state.ctx.role = "owner";
  state.getArticle.mockReset().mockResolvedValue(state.article);
  state.getJob.mockReset().mockResolvedValue(null);
  state.enqueue.mockReset().mockResolvedValue("new-job");
});

describe("explicit article generation retry", () => {
  it.each(["failed", "completed"])("retries a retained %s job instead of silently deduplicating it", async status => {
    const retry = vi.fn().mockResolvedValue(undefined);
    state.getJob.mockResolvedValue({ id: "existing", getState: async () => status, retry });
    expect(await POST(request())).toMatchObject({ ok: true, jobId: "existing" });
    expect(retry).toHaveBeenCalledWith(status); expect(state.enqueue).not.toHaveBeenCalled();
  });
  it.each(["active", "waiting", "delayed"])("shares an existing %s job", async status => {
    state.article.status = "generating";
    const retry = vi.fn();
    state.getJob.mockResolvedValue({ id: "existing", getState: async () => status, retry });
    expect(await POST(request())).toMatchObject({ jobId: "existing" });
    expect(retry).not.toHaveBeenCalled(); expect(state.enqueue).not.toHaveBeenCalled();
  });
  it("handles a second click racing the same retained-job retry", async () => {
    state.getJob.mockResolvedValue({ id: "existing", getState: vi.fn().mockResolvedValueOnce("failed").mockResolvedValue("waiting"),
      retry: vi.fn().mockRejectedValue(new Error("Already moved")) });
    expect(await POST(request())).toMatchObject({ ok: true, jobId: "existing" });
    expect(state.enqueue).not.toHaveBeenCalled();
  });
  it("queues a missing job with the existing version-bound idempotency key", async () => {
    await POST(request());
    expect(state.enqueue).toHaveBeenCalledWith("ai", "ai.generate-article", expect.objectContaining({ articleId: state.article.id, workspaceId: state.ctx.workspaceId }),
      { idempotencyKey: `generate:${state.article.id}:v1` });
  });
  it.each(["approved", "scheduled", "published", "awaiting_approval"])("does not generate over %s content", async status => {
    state.article.status = status;
    await expect(POST(request())).rejects.toMatchObject({ code: "conflict" });
    expect(state.enqueue).not.toHaveBeenCalled();
  });
  it("does not restart an article already being generated when the job is missing", async () => {
    state.article.status = "generating";
    await expect(POST(request())).rejects.toMatchObject({ code: "conflict" });
    expect(state.enqueue).not.toHaveBeenCalled();
  });
  it("requires an editor before looking up the article or queue", async () => {
    state.ctx.role = "viewer";
    await expect(POST(request())).rejects.toMatchObject({ code: "forbidden" });
    expect(state.getArticle).not.toHaveBeenCalled(); expect(state.getJob).not.toHaveBeenCalled();
  });
  it("does not replay a terminal job while the article is still generating", async () => {
    state.article.status = "generating";
    const retry = vi.fn();
    state.getJob.mockResolvedValue({ id: "old", getState: async () => "completed", retry });
    await expect(POST(request())).rejects.toMatchObject({ code: "conflict" });
    expect(retry).not.toHaveBeenCalled();
  });
  it("reports a fast retry failure even if the article's status never changed", async () => {
    state.getJob.mockResolvedValue({ name: "ai.generate-article", data: { workspaceId: state.ctx.workspaceId, articleId: state.article.id }, getState: async () => "failed" });
    expect(await GET(new Request(`${request().url}?jobId=existing`))).toMatchObject({ state: "failed", error: expect.any(String) });
  });
  it.each([
    { name: "analytics.ingest", data: { workspaceId: "11111111-1111-4111-8111-111111111111", articleId: "33333333-3333-4333-8333-333333333333" } },
    { name: "ai.generate-article", data: { workspaceId: "other", articleId: "33333333-3333-4333-8333-333333333333" } },
    { name: "ai.generate-article", data: { workspaceId: "11111111-1111-4111-8111-111111111111", articleId: "other" } },
  ])("does not expose another article, workspace, or task's status", async job => {
    state.getJob.mockResolvedValue(job);
    await expect(GET(new Request(`${request().url}?jobId=existing`))).rejects.toMatchObject({ code: "not_found" });
  });
});
