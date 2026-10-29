import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { users, workspaces, businesses, articles, articleRevisions, qualityGateResults, articleScores } from "@ob/db";
import type { GateRunResult } from "@ob/pipeline";

const state = vi.hoisted(() => ({ gates: vi.fn(), improve: vi.fn(), draft: vi.fn(), brief: vi.fn(), enqueue: vi.fn() }));
vi.mock("@ob/kb", () => ({ retrieve: vi.fn().mockResolvedValue([]) }));
vi.mock("@ob/pipeline", async (original) => ({ ...await original<object>(), runAllGates: state.gates }));
vi.mock("@ob/blog", async (original) => ({ ...await original<object>(), improveGeneratedArticleQuality: state.improve,
  generateArticle: state.draft, generateBrief: state.brief }));

import { processGenerateArticle, processRunQualityGates } from "../../../../../worker/src/processors/blog/article";

const ctx = { workspaceId: "41111111-1111-4111-8111-111111111111", userId: "42222222-2222-4222-8222-222222222222", correlationId: "quality-test" };
const brief = { angle: "Practical", audience: "Families", searchIntent: "informational", outline: [], mustCoverFacts: [], targetWordCount: 900, ctaGuidance: "Contact Care", internalLinkTargets: [] };
const generated = { title: "Home care planning guide", slug: "home-care-planning", metaTitle: "Home care planning guide", metaDescription: "An accurate description.", bodyMarkdown: "## Planning\n\nImproved guidance for families.", internalLinks: [], wordCount: 8 };
const result = (score: number): GateRunResult => ({ publishable: true, score: { total: score, components: [] }, voiceScore: 90, blockingReasons: [],
  gates: [{ gate: "seo", verdict: "pass", score: null, findings: [] }] });
let pg: PGlite;
let db: ReturnType<typeof drizzle>;
let businessId: string;
const wc = () => ({ db, gateway: {}, queues: { enqueue: state.enqueue }, logger: { info() {}, warn() {} } }) as never;
const payload = (id: string, optimize = false) => ({ ...ctx, articleId: id, articleVersion: 1,
  ...(optimize ? { generationQuality: { brief, primaryKeyword: "home care planning" } } : {}) });
const create = async () => {
  const [article] = await db.insert(articles).values({ workspaceId: ctx.workspaceId, businessId, title: "Home care planning", slug: randomUUID(),
    status: "qa", bodyMarkdown: "## Planning\n\nOriginal body.", wordCount: 4 }).returning();
  await db.insert(articleRevisions).values({ workspaceId: ctx.workspaceId, articleId: article!.id, version: 1, title: article!.title, bodyMarkdown: article!.bodyMarkdown, authoredBy: "ai" });
  return article!;
};

beforeAll(async () => {
  pg = await PGlite.create({ extensions: { vector, pg_trgm } });
  await pg.exec("CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm;");
  const directory = "packages/db/migrations";
  const migrations = (await readdir(directory)).filter((file) => file.endsWith(".sql") && !file.startsWith("pre_"));
  for (const file of [...migrations.filter((file) => !file.startsWith("post_")).sort(), ...migrations.filter((file) => file.startsWith("post_")).sort()]) {
    await pg.exec(await readFile(`${directory}/${file}`, "utf8"));
  }
  db = drizzle(pg);
  await db.insert(users).values({ id: ctx.userId, email: "quality@example.com", emailNormalized: "quality@example.com" });
  await db.insert(workspaces).values({ id: ctx.workspaceId, ownerId: ctx.userId, name: "Quality", slug: "quality", settings: { minSeoScoreToPublish: 50 } });
  businessId = (await db.insert(businesses).values({ workspaceId: ctx.workspaceId, name: "Care", websiteUrl: "https://care.example" }).returning())[0]!.id;
}, 30000);
afterAll(async () => { await pg?.close(); });
beforeEach(() => {
  state.gates.mockReset().mockResolvedValue(result(68));
  state.improve.mockReset().mockResolvedValue({ article: generated, assessment: result(89), improved: true, attempts: 1, targetScore: 85, stoppedReason: "target_met" });
  state.draft.mockReset().mockResolvedValue(generated);
  state.brief.mockReset().mockResolvedValue(brief);
  state.enqueue.mockReset().mockResolvedValue("qa-job");
});

describe.sequential("first-draft quality lifecycle", () => {
  it("marks generated QA explicitly, carrying the original keyword and brief", async () => {
    const article = await create();
    await db.update(articles).set({ status: "draft" }).where(eq(articles.id, article.id));
    await processGenerateArticle(wc(), payload(article.id));
    expect(state.enqueue).toHaveBeenCalledWith("qa", expect.any(String), expect.objectContaining({ articleId: article.id, articleVersion: 2,
      generationQuality: { brief, primaryKeyword: article.title } }));
  });

  it("leaves manual QA read-only even when the score is low", async () => {
    const article = await create();
    await processRunQualityGates(wc(), payload(article.id));
    expect(state.improve).not.toHaveBeenCalled();
    const [saved] = await db.select().from(articles).where(eq(articles.id, article.id));
    expect(saved?.bodyMarkdown).toBe(article.bodyMarkdown);
    expect(saved?.version).toBe(1);
  });

  it("saves an accepted improvement and its measured results under a new revision", async () => {
    const article = await create();
    await processRunQualityGates(wc(), payload(article.id, true));
    const [saved] = await db.select().from(articles).where(eq(articles.id, article.id));
    expect(saved).toMatchObject({ version: 2, seoScore: 89, bodyMarkdown: generated.bodyMarkdown, status: "awaiting_approval" });
    expect(await db.select().from(articleRevisions).where(eq(articleRevisions.articleId, article.id))).toHaveLength(2);
    expect((await db.select().from(qualityGateResults).where(eq(qualityGateResults.articleId, article.id)))[0]?.articleVersion).toBe(2);
    expect((await db.select().from(articleScores).where(eq(articleScores.articleId, article.id)))[0]).toMatchObject({ articleVersion: 2, total: 89 });
  });

  it("keeps a draft below 70 out of review even if workspace publishing policy is lower", async () => {
    const article = await create();
    state.improve.mockResolvedValue({ article: generated, assessment: result(68), improved: false, attempts: 2, targetScore: 85, stoppedReason: "attempt_limit" });
    await processRunQualityGates(wc(), payload(article.id, true));
    const [saved] = await db.select().from(articles).where(eq(articles.id, article.id));
    expect(saved).toMatchObject({ status: "needs_changes", seoScore: 68, version: 1, bodyMarkdown: article.bodyMarkdown });
    const [gate] = await db.select().from(qualityGateResults).where(eq(qualityGateResults.articleId, article.id));
    expect(gate?.verdict).toBe("fail");
    expect(gate?.findings.some((finding) => finding.location === "generationQuality")).toBe(true);
  });

  it("does not overwrite a manual edit made while improvement is running", async () => {
    const article = await create();
    state.improve.mockImplementationOnce(async () => {
      await db.update(articles).set({ version: 2, status: "needs_changes", bodyMarkdown: "Saved manual changes" }).where(eq(articles.id, article.id));
      return { article: generated, assessment: result(89), improved: true, attempts: 1, targetScore: 85, stoppedReason: "target_met" };
    });
    await expect(processRunQualityGates(wc(), payload(article.id, true))).rejects.toMatchObject({ code: "conflict" });
    const [saved] = await db.select().from(articles).where(eq(articles.id, article.id));
    expect(saved?.bodyMarkdown).toBe("Saved manual changes");
    expect(await db.select().from(qualityGateResults).where(eq(qualityGateResults.articleId, article.id))).toHaveLength(0);
    expect(await db.select().from(articleRevisions).where(eq(articleRevisions.articleId, article.id))).toHaveLength(1);
  });
});
