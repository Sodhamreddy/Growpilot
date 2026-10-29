import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { WorkerContext } from "../../context.js";

const providers = vi.hoisted(() => ({ page: vi.fn(), posts: vi.fn(), instagram: vi.fn(), instagramPosts: vi.fn() }));
vi.mock("@ob/social", async (actual) => ({ ...await actual<typeof import("@ob/social")>(),
  fetchPageInsights: providers.page, fetchRecentPosts: providers.posts,
  fetchInstagramInsights: providers.instagram, fetchRecentInstagramPosts: providers.instagramPosts,
}));
vi.mock("@ob/core", async (actual) => ({ ...await actual<typeof import("@ob/core")>(),
  open: () => JSON.stringify({ userToken: "test", pages: [{ id: "page", name: "Client", accessToken: "test" }] }),
}));
import { processSocialInsights } from "./insights.js";

function fixture(selectedPage = "page") {
  const deletes: SQL[] = [];
  const inserts: unknown[] = [];
  const select = vi.fn()
    .mockReturnValueOnce({ from: () => ({ where: () => ({ limit: async () => [{ credentialSealed: "test" }] }) }) })
    .mockReturnValueOnce({ from: () => ({ where: () => ({ limit: async () => [{ metaPageId: "page", name: "Client" }] }) }) });
  const tx = {
    select: () => ({ from: () => ({ where: () => ({ for: async () => [{ metaPageId: selectedPage }] }) }) }),
    delete: () => ({ where: async (where: SQL) => { deletes.push(where); } }),
    insert: () => ({ values: async (rows: unknown[]) => { inserts.push(...rows); } }),
  };
  const wc = { db: { select, transaction: async (fn: (tx: unknown) => unknown) => fn(tx) },
    cfg: { CREDENTIAL_ENCRYPTION_KEY: "test" }, logger: { child: () => ({ info: vi.fn(), warn: vi.fn() }) },
  } as unknown as WorkerContext;
  return { wc, deletes, inserts };
}
const payload = { workspaceId: "workspace", businessId: "client", userId: "user", correlationId: "test" };

describe("social insights replacement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    providers.page.mockResolvedValue([{ source: "facebook", metric: "followers", date: new Date("2026-10-25"), value: 25, dimensions: { businessId: "client" } }]);
    providers.posts.mockResolvedValue([{ source: "facebook", metric: "likes", date: new Date("2026-01-01"), value: 5, dimensions: { businessId: "client", postId: "old-post" } }]);
  });
  it("updates returned metric points without deleting the months between old posts and daily data", async () => {
    const { wc, deletes, inserts } = fixture();
    await processSocialInsights(wc, payload);
    expect(inserts).toHaveLength(2);
    const query = new PgDialect().sqlToQuery(deletes[0]!);
    expect(query.sql).not.toContain(">=");
    expect(query.sql).toContain("IS NULL"); // daily points are separate from post points
    expect(query.params).toContain("old-post");
    expect(query.params).toContain("followers");
    expect(query.params).not.toContain("instagram"); // no fetched Instagram data => no deletion
  });
  it("keeps post history when a best-effort post fetch fails", async () => {
    providers.posts.mockRejectedValue(new Error("rate limited"));
    const { wc, deletes, inserts } = fixture();
    await processSocialInsights(wc, payload);
    expect(inserts).toHaveLength(1);
    expect(new PgDialect().sqlToQuery(deletes[0]!).params).not.toContain("likes");
  });
  it("refuses results if the client switched Pages during the provider request", async () => {
    const { wc, deletes, inserts } = fixture("replacement-page");
    await expect(processSocialInsights(wc, payload)).rejects.toThrow("Page changed during sync");
    expect(deletes).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });
});
