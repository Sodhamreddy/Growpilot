import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { users, workspaces, businesses, articles, articleRevisions, qualityGateResults, topics, keywords, integrations, metricSnapshots } from "@ob/db";
import { seal } from "@ob/core";

const state = vi.hoisted(() => ({ database: null as any, enqueue: vi.fn().mockResolvedValue("job"), getJob: vi.fn(), gates: vi.fn(), measurements: vi.fn(),
  ctx: { workspaceId: "11111111-1111-4111-8111-111111111111", userId: "22222222-2222-4222-8222-222222222222", role: "owner", correlationId: "test" } }));
vi.mock("@/lib/services", () => ({ db: () => state.database, getQueues: () => ({ enqueue: state.enqueue, get: () => ({ getJob: state.getJob }) }) }));
vi.mock("@/lib/api", () => ({ route: (handler: Function) => (req: Request) => handler(state.ctx, req),
  parseBody: async (req: Request, schema: { parse: Function }) => schema.parse(await req.json()) }));
vi.mock("@ob/kb", () => ({ retrieve: vi.fn().mockResolvedValue([]) }));
vi.mock("@ob/pipeline", async (original) => ({ ...await original<object>(), runAllGates: state.gates }));
vi.mock("@ob/blog", async (original) => ({ ...await original<object>(), fetchMeasurement: state.measurements }));

import { PATCH as editArticle } from "./[id]/route";
import { POST as applyRevision } from "./[id]/revise/apply/route";
import { GET as history } from "./[id]/revisions/route";
import { POST as queueQa } from "./[id]/qa/route";
import { processRunQualityGates, extractStructure } from "../../../../../worker/src/processors/blog/article";
import { processBuildContentPlan } from "../../../../../worker/src/processors/blog/plan";
import { processMeasurement } from "../../../../../worker/src/processors/blog/measurement";

let pg: PGlite;
let database: ReturnType<typeof drizzle>;
let businessId: string;
const passing = { publishable: true, score: { total: 90, components: [] }, voiceScore: 90,
  gates: [{ gate: "seo", verdict: "pass", score: 90, findings: [] }] };
const request = (id: string, body: unknown, suffix = "", method = "PATCH") => new Request(`http://localhost/api/articles/${id}${suffix}`, {
  method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const wc = () => ({ db: database, gateway: {}, queues: { enqueue: state.enqueue }, logger: { child: () => ({ info() {}, warn() {} }) } }) as any;
const payload = (id: string, version = 1) => ({ ...state.ctx, articleId: id, articleVersion: version });
const createArticle = async (extra: Record<string, unknown> = {}) => (await database.insert(articles).values({
  workspaceId: state.ctx.workspaceId, businessId, title: "Care", slug: randomUUID(), status: "needs_changes",
  bodyMarkdown: "## Costs\n\nOriginal pricing.\n\n## Locations\n\nOriginal locations.", ...extra,
} as any).returning())[0]!;

beforeAll(async () => {
  pg = await PGlite.create({ extensions: { vector, pg_trgm } });
  await pg.exec("CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm;");
  const dir = "packages/db/migrations";
  const files = (await readdir(dir)).filter(f => f.endsWith(".sql") && !f.startsWith("pre_"));
  for (const file of [...files.filter(f => !f.startsWith("post_")).sort(), ...files.filter(f => f.startsWith("post_")).sort()]) {
    await pg.exec(await readFile(`${dir}/${file}`, "utf8"));
  }
  database = drizzle(pg); state.database = database;
  await database.insert(users).values({ id: state.ctx.userId, email: "article@example.com", emailNormalized: "article@example.com" });
  await database.insert(workspaces).values({ id: state.ctx.workspaceId, ownerId: state.ctx.userId, name: "Articles", slug: "articles" });
  businessId = (await database.insert(businesses).values({ workspaceId: state.ctx.workspaceId, name: "Care", websiteUrl: "https://care.example" }).returning())[0]!.id;
}, 30000);
afterAll(async () => { await pg?.close(); });
beforeEach(() => { state.enqueue.mockClear(); state.getJob.mockReset().mockResolvedValue(null); state.gates.mockReset().mockResolvedValue(passing); });

describe.sequential("article editing and quality checks", () => {
  it("saves a selected batch as one version and checks that saved content", async () => {
    const article = await createArticle({ seoScore: 69.6, voiceScore: 90, approvedAt: new Date() });
    const bodyMarkdown = "## Costs\n\nBetter cost questions.\n\n## Locations\n\nBetter location guidance.";
    const result = await editArticle(request(article.id, { expectedVersion: 1, title: "Home care questions",
      metaTitle: "Home Care Questions for Your Consultation", metaDescription: "A clearer summary of home care questions.", bodyMarkdown, runQualityChecks: true })) as any;
    expect(result).toMatchObject({ ok: true, version: 2, rescoreNeeded: true, qaQueued: true });
    expect(state.enqueue).toHaveBeenCalledTimes(1);
    expect(state.enqueue).toHaveBeenCalledWith("qa", expect.any(String), expect.objectContaining({ articleId: article.id, articleVersion: 2 }),
      { idempotencyKey: `qa:${article.id}:v2` });
    const [saved] = await database.select().from(articles).where(eq(articles.id, article.id));
    expect(saved).toMatchObject({ version: 2, title: "Home care questions", bodyMarkdown, seoScore: null, voiceScore: null, approvedAt: null });
    const revisions = await database.select().from(articleRevisions).where(eq(articleRevisions.articleId, article.id));
    expect(revisions.map(revision => revision.version).sort()).toEqual([1, 2]);
    await processRunQualityGates(wc(), payload(article.id, 2));
    expect(state.gates).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ article: expect.objectContaining({ bodyMarkdown }) }));
    expect((await database.select().from(articles).where(eq(articles.id, article.id)))[0]?.seoScore).toBe(90);
  });
  it("reports a recoverable QA outage after the combined edit has committed", async () => {
    const article = await createArticle();
    state.enqueue.mockRejectedValueOnce(new Error("Queue unavailable"));
    const result = await editArticle(request(article.id, { expectedVersion: 1, bodyMarkdown: "Saved selected changes.", runQualityChecks: true })) as any;
    expect(result).toMatchObject({ ok: true, version: 2, qaQueued: false });
    expect(result.qaWarning).toContain("changes were saved");
    expect((await database.select().from(articles).where(eq(articles.id, article.id)))[0]?.bodyMarkdown).toBe("Saved selected changes.");
  });
  it("does not enqueue quality checks for a no-op batch or an ordinary save", async () => {
    const article = await createArticle();
    await editArticle(request(article.id, { expectedVersion: 1, bodyMarkdown: article.bodyMarkdown, runQualityChecks: true }));
    await editArticle(request(article.id, { expectedVersion: 1, bodyMarkdown: "A manual edit." }));
    expect(state.enqueue).not.toHaveBeenCalled();
  });
  it("does not save or queue an outdated combined preview", async () => {
    const article = await createArticle({ version: 2 });
    await expect(editArticle(request(article.id, { expectedVersion: 1, bodyMarkdown: "Stale preview", runQualityChecks: true }))).rejects.toMatchObject({ code: "conflict" });
    expect(state.enqueue).not.toHaveBeenCalled();
    expect((await database.select().from(articles).where(eq(articles.id, article.id)))[0]?.version).toBe(2);
  });
  it.each(["failed", "completed"])("explicit QA rerun retries a retained %s job", async status => {
    const article = await createArticle();
    const retry = vi.fn().mockResolvedValue(undefined);
    state.getJob.mockResolvedValue({ id: "old-qa", getState: async () => status, retry });
    await queueQa(new Request(`http://localhost/api/articles/${article.id}/qa`, { method: "POST" }));
    expect(retry).toHaveBeenCalledWith(status);
    expect(state.enqueue).not.toHaveBeenCalled();
  });
  it("does not duplicate QA already running", async () => {
    const article = await createArticle({ status: "qa" });
    const retry = vi.fn();
    state.getJob.mockResolvedValue({ id: "active-qa", getState: async () => "active", retry });
    await queueQa(new Request(`http://localhost/api/articles/${article.id}/qa`, { method: "POST" }));
    expect(retry).not.toHaveBeenCalled(); expect(state.enqueue).not.toHaveBeenCalled();
  });
  it.each(["generating", "approved", "scheduled", "published"])("does not run QA while %s", async status => {
    const article = await createArticle({ status });
    await expect(processRunQualityGates(wc(), payload(article.id))).rejects.toMatchObject({ code: "conflict" });
    expect(state.gates).not.toHaveBeenCalled();
  });
  it.each(["draft", "needs_changes", "awaiting_approval"])("reruns QA from %s", async status => {
    const article = await createArticle({ status });
    await processRunQualityGates(wc(), payload(article.id));
    const [saved] = await database.select().from(articles).where(eq(articles.id, article.id));
    expect(saved?.status).toBe("awaiting_approval"); expect(saved?.seoScore).toBe(90);
  });
  it("does not save QA results over an edit made during the check", async () => {
    const article = await createArticle();
    state.gates.mockImplementationOnce(async () => {
      await editArticle(request(article.id, { expectedVersion: 1, bodyMarkdown: "Edited while checking." }));
      return passing;
    });
    await expect(processRunQualityGates(wc(), payload(article.id))).rejects.toMatchObject({ code: "conflict" });
    const [saved] = await database.select().from(articles).where(eq(articles.id, article.id));
    expect(saved?.version).toBe(2); expect(saved?.seoScore).toBeNull(); expect(saved?.status).toBe("needs_changes");
    expect(await database.select().from(qualityGateResults).where(eq(qualityGateResults.articleId, article.id))).toHaveLength(0);
  });
  it("invalidates scores when only SEO metadata changes and preserves history", async () => {
    const article = await createArticle({ status: "awaiting_approval", seoScore: 90, metaDescription: "Old description" });
    const result = await editArticle(request(article.id, { expectedVersion: 1, metaDescription: null })) as any;
    expect(result.rescoreNeeded).toBe(true); expect(result.version).toBe(2);
    const [saved] = await database.select().from(articles).where(eq(articles.id, article.id));
    expect(saved?.seoScore).toBeNull(); expect(saved?.status).toBe("needs_changes");
    expect(await database.select().from(articleRevisions).where(eq(articleRevisions.articleId, article.id))).toHaveLength(2);
  });
  it("refuses a stale manual edit and a proposal whose positional section moved", async () => {
    const article = await createArticle();
    await editArticle(request(article.id, { expectedVersion: 1, bodyMarkdown: `## Overview\n\nNew section.\n\n${article.bodyMarkdown}` }));
    await expect(editArticle(request(article.id, { expectedVersion: 1, title: "Old tab" }))).rejects.toMatchObject({ code: "conflict" });
    await expect(applyRevision(request(article.id, { expectedVersion: 1, sectionId: "1", content: "New locations." }, "/revise/apply", "POST"))).rejects.toMatchObject({ code: "conflict" });
  });
  it("restores an old title/body as a new version without losing current history", async () => {
    const article = await createArticle();
    await editArticle(request(article.id, { expectedVersion: 1, title: "Changed", bodyMarkdown: "Changed body" }));
    const data = await history(new Request(`http://localhost/api/articles/${article.id}/revisions?version=1`)) as any;
    await editArticle(request(article.id, { expectedVersion: 2, title: data.revision.title, bodyMarkdown: data.revision.bodyMarkdown }));
    const [saved] = await database.select().from(articles).where(eq(articles.id, article.id));
    expect(saved?.version).toBe(3); expect(saved?.bodyMarkdown).toBe(article.bodyMarkdown);
    expect(await database.select().from(articleRevisions).where(eq(articleRevisions.articleId, article.id))).toHaveLength(3);
  });
  it("drafts existing planned topics even when no new keywords remain", async () => {
    const [keyword] = await database.insert(keywords).values({ workspaceId: state.ctx.workspaceId, businessId, term: "care costs" }).returning();
    const [topic] = await database.insert(topics).values({ workspaceId: state.ctx.workspaceId, businessId, title: "Care costs", primaryKeywordId: keyword!.id, status: "planned" }).returning();
    const result = await processBuildContentPlan(wc(), { ...state.ctx, businessId, draftCount: 1 });
    expect(result).toEqual({ topics: 0, drafted: 1 });
    expect(await database.select().from(articles).where(eq(articles.topicId, topic!.id))).toHaveLength(1);
    await processBuildContentPlan(wc(), { ...state.ctx, businessId, draftCount: 1 });
    expect(await database.select().from(articles).where(eq(articles.topicId, topic!.id))).toHaveLength(1);
  });
  it("stores large Search Console responses in bounded batches", async () => {
    const key = Buffer.alloc(32, 1).toString("base64");
    const [connection] = await database.insert(integrations).values({ workspaceId: state.ctx.workspaceId,
      provider: "google_search_console", scopeKey: businessId, status: "connected", credentialSealed: seal("{}", key) }).returning();
    state.measurements.mockResolvedValue(Array.from({ length: 11000 }, (_, i) => ({
      metric: "search_query_clicks", date: new Date("2026-10-01"), value: i, dimensions: { query: `query ${i}` },
    })));
    const context = { ...wc(), cfg: { CREDENTIAL_ENCRYPTION_KEY: key } };
    expect(await processMeasurement(context, { workspaceId: state.ctx.workspaceId, integrationId: connection!.id })).toEqual({ rows: 11000 });
    expect(await database.select({ id: metricSnapshots.id }).from(metricSnapshots)).toHaveLength(11000);
  }, 30000);
});

it("counts absolute own-site links as internal and ignores images and contact protocols", () => {
  const parsed = extractStructure("[Service](https://www.care.example/service) [Relative](/cost) [External](https://other.example) [Email](mailto:hi@care.example) ![Photo](/photo.jpg)", "Title", "https://care.example");
  expect(parsed.internalLinks).toHaveLength(2); expect(parsed.externalLinks).toHaveLength(1); expect(parsed.images).toHaveLength(1);
});
