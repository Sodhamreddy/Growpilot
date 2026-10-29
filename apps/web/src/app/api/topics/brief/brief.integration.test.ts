import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { users, workspaces, businesses, businessFacts, articles, topics, keywords } from "@ob/db";

const state = vi.hoisted(() => ({ database: null as any, enqueue: vi.fn(), brief: vi.fn(), retrieve: vi.fn(),
  ctx: { workspaceId: "11111111-1111-4111-8111-111111111111", userId: "22222222-2222-4222-8222-222222222222", role: "owner", correlationId: "brief-test" } }));
vi.mock("@/lib/services", () => ({ db: () => state.database, getGateway: () => ({}), getQueues: () => ({ enqueue: state.enqueue }) }));
vi.mock("@/lib/api", () => ({ route: (handler: Function) => (req: Request) => handler(state.ctx, req),
  parseBody: async (req: Request, schema: { parse: Function }) => schema.parse(await req.json()) }));
vi.mock("@ob/kb", () => ({ retrieve: state.retrieve }));
vi.mock("@ob/blog", async original => ({ ...await original<object>(), generateBrief: state.brief }));
import { POST as preview } from "./route";
import { PUT as accept } from "../suggest/route";

const brief = { angle: "Understand home care costs", audience: "Families", searchIntent: "informational",
  outline: [{ heading: "Care costs", level: 2, guidance: "Explain the cost factors." }],
  mustCoverFacts: ["Offers home care"], internalLinkTargets: [], targetWordCount: 1200, ctaGuidance: "Contact the care team." };
let pg: PGlite;
let database: ReturnType<typeof drizzle>;
let businessId: string;
const body = (extra: Record<string, unknown> = {}) => ({ businessId, title: "How much does home care cost?", primaryKeyword: "home care cost", intent: "informational", ...extra });
const req = (value: unknown, method = "POST") => new Request("https://example.test/api/topics/brief", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
beforeAll(async () => {
  pg = await PGlite.create({ extensions: { vector, pg_trgm } });
  await pg.exec("CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm;");
  const dir = "packages/db/migrations";
  const files = (await readdir(dir)).filter(f => f.endsWith(".sql") && !f.startsWith("pre_"));
  for (const file of [...files.filter(f => !f.startsWith("post_")).sort(), ...files.filter(f => f.startsWith("post_")).sort()]) await pg.exec(await readFile(`${dir}/${file}`, "utf8"));
  database = drizzle(pg); state.database = database;
  await database.insert(users).values({ id: state.ctx.userId, email: "brief@example.test", emailNormalized: "brief@example.test" });
  await database.insert(workspaces).values({ id: state.ctx.workspaceId, ownerId: state.ctx.userId, name: "Brief", slug: "brief" });
  businessId = (await database.insert(businesses).values({ workspaceId: state.ctx.workspaceId, name: "Care", confirmedAt: new Date() }).returning())[0]!.id;
  await database.insert(businessFacts).values({ workspaceId: state.ctx.workspaceId, businessId, key: "service", value: "Home care", sourceUrl: "https://care.example/services", verified: true });
  await database.insert(keywords).values({ workspaceId: state.ctx.workspaceId, businessId, term: "home care cost", volume: 10, intent: "informational" });
}, 30000);
afterAll(async () => { await pg?.close(); });
beforeEach(() => {
  state.ctx.role = "owner";
  state.enqueue.mockReset().mockResolvedValue("job");
  state.brief.mockReset().mockResolvedValue(brief);
  state.retrieve.mockReset().mockResolvedValue([{ id: "evidence", content: "Offers home care", sourceUrl: "https://care.example/services", heading: "Home care services" }]);
});

describe.sequential("blog brief preview and acceptance", () => {
  it("returns actual sources and measured keyword data, and forwards editorial refinement", async () => {
    const result = await preview(req(body({ instructions: "Focus on family questions", previousBrief: brief }))) as any;
    expect(result.brief).toEqual(brief);
    expect(result.sources).toEqual([{ url: "https://care.example/services", title: "Home care services" }]);
    expect(result.keyword.volume).toBe(10);
    expect(state.brief.mock.calls[0]![2]).toMatchObject({ previousBrief: brief, instructions: "Focus on family questions" });
    expect(state.retrieve.mock.calls[0]![3].businessId).toBe(businessId);
  });
  it("does not invent search volume for suggested keywords", async () => {
    const result = await preview(req(body({ primaryKeyword: "unmeasured keyword" }))) as any;
    expect(result.keyword.volume).toBeNull();
  });
  it("rejects viewers before any AI request", async () => {
    state.ctx.role = "viewer";
    await expect(preview(req(body()))).rejects.toMatchObject({ code: "forbidden" });
    await expect(accept(req(body(), "PUT"))).rejects.toMatchObject({ code: "forbidden" });
    expect(state.brief).not.toHaveBeenCalled();
  });
  it("refuses another workspace's business", async () => {
    const saved = state.ctx.workspaceId;
    state.ctx.workspaceId = "33333333-3333-4333-8333-333333333333";
    try { await expect(preview(req(body()))).rejects.toMatchObject({ code: "not_found" }); }
    finally { state.ctx.workspaceId = saved; }
    expect(state.brief).not.toHaveBeenCalled();
  });
  it("persists the reviewed brief and requirements without relabelling them as facts", async () => {
    const result = await accept(req(body({ brief, mustInclude: ["Keep the tone reassuring"] }), "PUT")) as any;
    const [topic] = await database.select().from(topics).where(eq(topics.id, result.topicId));
    expect(topic?.brief?.mustCoverFacts).toEqual(brief.mustCoverFacts);
    expect(topic?.brief?.outline[0]?.guidance).toContain("Keep the tone reassuring");
    expect(topic?.brief?.outline[0]?.guidance).toContain("not independently verified facts");
    expect(result.queued).toBe(true);
  });
  it("keeps one recoverable article when the queue is unavailable", async () => {
    state.enqueue.mockRejectedValueOnce(new Error("Redis unavailable"));
    const result = await accept(req(body({ brief }), "PUT")) as any;
    const [article] = await database.select().from(articles).where(eq(articles.id, result.articleId));
    expect(result.queued).toBe(false); expect(result.warning).toContain("saved");
    expect(article?.status).toBe("failed");
  });
  it("keeps legacy acceptance compatible", async () => {
    const result = await accept(req(body(), "PUT")) as any;
    expect(result.articleId).toBeTruthy(); expect(result.queued).toBe(true);
  });
  it("rejects unsafe links or missing briefs for requirements", async () => {
    await expect(accept(req(body({ brief: { ...brief, internalLinkTargets: [{ url: "javascript:alert(1)", anchor: "Click" }] } }), "PUT"))).rejects.toThrow();
    await expect(accept(req(body({ mustInclude: ["Keep it short"] }), "PUT"))).rejects.toMatchObject({ code: "validation_failed" });
  });
});
