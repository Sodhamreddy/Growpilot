import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@ob/core";
import { JOBS } from "@ob/jobs";

const mocked = vi.hoisted(() => ({ business: vi.fn(), job: vi.fn(), enqueue: vi.fn() }));
vi.mock("@/lib/api", () => ({ route: (handler: unknown) => handler }));
vi.mock("@/lib/services", () => ({ db: () => ({}), getQueues: () => ({ get: () => ({ getJob: mocked.job }) }) }));
vi.mock("@/lib/reviews", () => ({ queueReviewSync: mocked.enqueue }));
vi.mock("@ob/db", async (actual) => ({ ...await actual<typeof import("@ob/db")>(), repo: { getPrimaryBusiness: mocked.business } }));
import { GET, POST } from "./route";

const ctx: TenantContext = { workspaceId: "workspace", userId: "user", role: "editor", correlationId: "test" };
const get = GET as unknown as (ctx: TenantContext, req: Request) => Promise<unknown>;
const post = POST as unknown as (ctx: TenantContext, req: Request) => Promise<unknown>;
const request = () => new Request("https://app.example/api/reviews/sync?jobId=job");

describe("queued review sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.business.mockResolvedValue({ id: "client", googleListing: { mapsLink: "https://maps.app.goo.gl/abc" } });
    mocked.enqueue.mockResolvedValue("job");
    mocked.job.mockResolvedValue({ name: JOBS.syncReviews, data: { workspaceId: "workspace", businessId: "client" },
      getState: async () => "completed", returnvalue: { added: 3, drafted: 2 } });
  });
  it("queues the selected client and returns immediately without fetching Google", async () => {
    await expect(post(ctx, request())).resolves.toEqual({ ok: true, queued: true, jobId: "job" });
    expect(mocked.enqueue).toHaveBeenCalledWith(ctx, "client");
  });
  it("refuses viewers and clients without a listing", async () => {
    await expect(post({ ...ctx, role: "viewer" }, request())).rejects.toThrow();
    mocked.business.mockResolvedValue({ id: "client", googleListing: null });
    await expect(post(ctx, request())).rejects.toThrow("choose its Google listing");
    expect(mocked.enqueue).not.toHaveBeenCalled();
  });
  it("returns completion only for this workspace and selected client", async () => {
    await expect(get(ctx, request())).resolves.toEqual({ state: "completed", result: { added: 3, drafted: 2 }, error: null });
  });
  it("does not expose another workspace's job", async () => {
    mocked.job.mockResolvedValue({ name: JOBS.syncReviews, data: { workspaceId: "other", businessId: "client" } });
    await expect(get(ctx, request())).rejects.toThrow("not in this workspace");
  });
  it("does not expose another client's job", async () => {
    mocked.business.mockResolvedValue({ id: "other-client" });
    await expect(get(ctx, request())).rejects.toThrow("another client");
  });
  it("rejects an unrelated or expired job", async () => {
    mocked.job.mockResolvedValue({ name: JOBS.ingestMetrics, data: { workspaceId: "workspace", businessId: "client" } });
    await expect(get(ctx, request())).rejects.toThrow("not in this workspace");
    mocked.job.mockResolvedValue(null);
    await expect(get(ctx, request())).rejects.toThrow("not in this workspace");
  });
});
