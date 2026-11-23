import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { users, workspaces, businesses, articles, articleRevisions, articleComments, articleCommentReplies } from "@ob/db";
import { createCommentAnchor, getArticleCommentText } from "@/lib/article-comment-text";

const state = vi.hoisted(() => ({ database: null as any, ctx: {
  workspaceId: "11111111-1111-4111-8111-111111111111", userId: "22222222-2222-4222-8222-222222222222",
  role: "viewer", correlationId: "comments-test",
} }));
vi.mock("@/lib/services", () => ({ db: () => state.database }));
vi.mock("@/lib/api", () => ({ route: (handler: Function) => (req: Request) => handler(state.ctx, req),
  parseBody: async (req: Request, schema: { parse: Function }) => schema.parse(await req.json()) }));

import { GET as getComments, POST as createComment } from "./[id]/comments/route";
import { PATCH as resolveComment } from "./[id]/comments/[commentId]/route";

let pg: PGlite;
let database: ReturnType<typeof drizzle>;
let businessId: string;
const workspaceId = state.ctx.workspaceId;
const ownerId = state.ctx.userId;
const secondUserId = "33333333-3333-4333-8333-333333333333";
const otherWorkspaceId = "44444444-4444-4444-8444-444444444444";
let otherBusinessId: string;
const request = (articleId: string, body?: unknown, commentId = "") => new Request(
  `http://localhost/api/articles/${articleId}/comments${commentId ? `/${commentId}` : ""}`, body === undefined ? {} : {
    method: commentId ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
const makeArticle = async (extra: Record<string, unknown> = {}) => (await database.insert(articles).values({
  workspaceId, businessId, title: "Care guide", slug: randomUUID(), bodyMarkdown: "## Costs\n\nAsk about **care costs** before booking.",
  status: "awaiting_approval", seoScore: 90, voiceScore: 82, ...extra,
} as any).returning())[0]!;
function payload(article: { title: string; bodyMarkdown: string; version: number }, quote = "care costs") {
  const text = getArticleCommentText(article.title, article.bodyMarkdown);
  const start = text.indexOf(quote), end = start + quote.length;
  return { expectedVersion: article.version, body: "Please clarify this passage.", anchor: {
    quote, start, end, prefix: text.slice(Math.max(0, start - 64), start), suffix: text.slice(end, end + 64),
  } };
}
const commentOn = async (article: Awaited<ReturnType<typeof makeArticle>>) =>
  (await createComment(request(article.id, payload(article))) as any).comment;

beforeAll(async () => {
  pg = await PGlite.create({ extensions: { vector, pg_trgm } });
  await pg.exec("CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm;");
  const dir = "packages/db/migrations";
  const files = (await readdir(dir)).filter(file => file.endsWith(".sql") && !file.startsWith("pre_"));
  for (const file of [...files.filter(file => !file.startsWith("post_")).sort(), ...files.filter(file => file.startsWith("post_")).sort()]) {
    await pg.exec(await readFile(`${dir}/${file}`, "utf8"));
  }
  // The additive migration is safe to replay if deployment stops before recording it.
  await pg.exec(await readFile(`${dir}/post_0015_article_comments.sql`, "utf8"));
  database = drizzle(pg); state.database = database;
  await database.insert(users).values([
    { id: ownerId, email: "reviewer@example.com", emailNormalized: "reviewer@example.com", name: "Reviewer" },
    { id: secondUserId, email: "teammate@example.com", emailNormalized: "teammate@example.com", name: "Teammate" },
  ]);
  await database.insert(workspaces).values([
    { id: workspaceId, ownerId, name: "Review", slug: "comments" },
    { id: otherWorkspaceId, ownerId, name: "Other", slug: "other-comments" },
  ]);
  businessId = (await database.insert(businesses).values({ workspaceId, name: "Care", websiteUrl: "https://care.example" }).returning())[0]!.id;
  otherBusinessId = (await database.insert(businesses).values({ workspaceId: otherWorkspaceId, name: "Other", websiteUrl: "https://other.example" }).returning())[0]!.id;
}, 30000);
afterAll(async () => { await pg?.close(); });
beforeEach(() => { state.ctx.workspaceId = workspaceId; state.ctx.userId = ownerId; state.ctx.role = "viewer"; });

describe.sequential("article text comments", () => {
  it("lets a viewer save and reload a selected passage without changing content, version, or quality scores", async () => {
    const article = await makeArticle();
    const comment = await commentOn(article);
    expect(comment).toMatchObject({ authorName: "Reviewer", articleVersion: 1, body: "Please clarify this passage.",
      anchor: payload(article).anchor, resolvedAt: null, canResolve: true, replies: [] });
    const result = await getComments(request(article.id)) as any;
    expect(result).toEqual({ comments: [comment], canComment: true });
    expect((await database.select().from(articles).where(eq(articles.id, article.id)))[0]).toEqual(article);
    expect(await database.select().from(articleRevisions).where(eq(articleRevisions.articleId, article.id))).toHaveLength(0);
  });

  it("can anchor a comment to the article title and returns safe author names", async () => {
    const article = await makeArticle();
    const result = await createComment(request(article.id, payload(article, "Care guide"))) as any;
    expect(result.comment.anchor).toMatchObject({ quote: "Care guide", start: 0, end: 10 });
    expect(result.comment).not.toHaveProperty("authorId");
    expect(result.comment).not.toHaveProperty("email");
  });

  it("stores replies under their thread and permits replies after the article is edited", async () => {
    const article = await makeArticle();
    const comment = await commentOn(article);
    await database.update(articles).set({ version: 2, bodyMarkdown: "Changed text." }).where(eq(articles.id, article.id));
    state.ctx.userId = secondUserId;
    const result = await createComment(request(article.id, { parentId: comment.id, body: "Added the details." })) as any;
    expect(result).toMatchObject({ parentId: comment.id, reply: { authorName: "Teammate", body: "Added the details." } });
    const list = await getComments(request(article.id)) as any;
    expect(list.comments[0]).toMatchObject({ articleVersion: 1, anchor: payload(article).anchor, canResolve: false,
      replies: [result.reply] });
  });

  it("rejects a stale article version and a changed quote or context", async () => {
    const article = await makeArticle({ version: 2 });
    const data = payload(article);
    await expect(createComment(request(article.id, { ...data, expectedVersion: 1 }))).rejects.toMatchObject({ code: "conflict" });
    for (const anchor of [{ ...data.anchor, quote: "made up text" }, { ...data.anchor, start: data.anchor.start + 1 },
      { ...data.anchor, suffix: "different nearby text" }, { ...data.anchor, prefix: "" }]) {
      await expect(createComment(request(article.id, { ...data, anchor }))).rejects.toMatchObject({ code: "conflict" });
    }
    expect(await database.select().from(articleComments).where(eq(articleComments.articleId, article.id))).toHaveLength(0);
  });

  it("rejects comments while generation is changing the article", async () => {
    const article = await makeArticle({ status: "generating" });
    await expect(commentOn(article)).rejects.toMatchObject({ code: "conflict" });
  });

  it("preserves discussions across edits, quality checks, and published status", async () => {
    const article = await makeArticle({ status: "published" });
    const comment = await commentOn(article);
    await database.update(articles).set({ version: 2, title: "Changed guide", bodyMarkdown: "New wording.", status: "qa" }).where(eq(articles.id, article.id));
    expect((await getComments(request(article.id)) as any).comments[0]).toEqual(comment);
  });

  it("allows the author to resolve and reopen without changing article data, and blocks replies while resolved", async () => {
    const article = await makeArticle();
    const comment = await commentOn(article);
    const resolved = await resolveComment(request(article.id, { resolved: true }, comment.id)) as any;
    expect(resolved).toMatchObject({ id: comment.id, resolvedAt: expect.any(String) });
    await expect(createComment(request(article.id, { parentId: comment.id, body: "Too late" }))).rejects.toMatchObject({ code: "conflict" });
    expect(await resolveComment(request(article.id, { resolved: false }, comment.id))).toEqual({ id: comment.id, resolvedAt: null });
    expect((await database.select().from(articles).where(eq(articles.id, article.id)))[0]).toEqual(article);
  });

  it("prevents another viewer resolving a thread, but permits an editor", async () => {
    const article = await makeArticle();
    const comment = await commentOn(article);
    state.ctx.userId = secondUserId;
    await expect(resolveComment(request(article.id, { resolved: true }, comment.id))).rejects.toMatchObject({ code: "forbidden" });
    state.ctx.role = "editor";
    expect((await getComments(request(article.id)) as any).comments[0].canResolve).toBe(true);
    await expect(resolveComment(request(article.id, { resolved: true }, comment.id))).resolves.toMatchObject({ resolvedAt: expect.any(String) });
  });

  it("isolates both threads and replies between workspaces", async () => {
    const article = await makeArticle();
    const comment = await commentOn(article);
    state.ctx.workspaceId = otherWorkspaceId;
    await expect(getComments(request(article.id))).rejects.toMatchObject({ code: "not_found" });
    await expect(createComment(request(article.id, payload(article)))).rejects.toMatchObject({ code: "not_found" });
    await expect(resolveComment(request(article.id, { resolved: true }, comment.id))).rejects.toMatchObject({ code: "not_found" });
    const otherArticle = await makeArticle({ workspaceId: otherWorkspaceId, businessId: otherBusinessId });
    await expect(createComment(request(otherArticle.id, { parentId: comment.id, body: "Wrong workspace" }))).rejects.toMatchObject({ code: "not_found" });
    expect((await getComments(request(otherArticle.id)) as any).comments).toEqual([]);
  });

  it("cannot address a thread through another article in the same workspace", async () => {
    const first = await makeArticle(), second = await makeArticle();
    const comment = await commentOn(first);
    await expect(createComment(request(second.id, { parentId: comment.id, body: "Wrong article" }))).rejects.toMatchObject({ code: "not_found" });
    await expect(resolveComment(request(second.id, { resolved: true }, comment.id))).rejects.toMatchObject({ code: "not_found" });
  });

  it("rejects malformed IDs, blank or excessive comments, and overlong selections", async () => {
    await expect(getComments(request("not-an-id"))).rejects.toMatchObject({ code: "validation_failed" });
    const article = await makeArticle();
    for (const body of [" ", "x".repeat(4001)]) {
      await expect(createComment(request(article.id, { ...payload(article), body }))).rejects.toThrow();
    }
    await expect(createComment(request(article.id, { ...payload(article), anchor: { ...payload(article).anchor, quote: "x".repeat(3001) } }))).rejects.toThrow();
    await expect(resolveComment(request(article.id, { resolved: true }, "invalid"))).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("round-trips selections whose surrounding context crosses emoji boundaries", async () => {
    const article = await makeArticle({ bodyMarkdown: "🧡" + "a".repeat(63) + "selected" + "b".repeat(63) + "🧡" });
    const text = getArticleCommentText(article.title, article.bodyMarkdown);
    const start = text.indexOf("selected"), anchor = createCommentAnchor(text, start, start + 8);
    await createComment(request(article.id, { expectedVersion: article.version, body: "Clarify this.", anchor }));
    expect((await getComments(request(article.id)) as any).comments[0].anchor).toEqual(anchor);
  });

  it("keeps the author name after an account is removed and cascades discussions with the article", async () => {
    const article = await makeArticle();
    const comment = await commentOn(article);
    const tempUser = randomUUID();
    await database.insert(users).values({ id: tempUser, email: "temporary@example.com", emailNormalized: "temporary@example.com", name: "Former reviewer" });
    state.ctx.userId = tempUser;
    await createComment(request(article.id, { parentId: comment.id, body: "Keep my feedback." }));
    await database.delete(users).where(eq(users.id, tempUser));
    state.ctx.userId = ownerId;
    expect((await getComments(request(article.id)) as any).comments[0].replies[0].authorName).toBe("Former reviewer");
    await database.delete(articles).where(eq(articles.id, article.id));
    expect(await database.select().from(articleComments).where(eq(articleComments.articleId, article.id))).toHaveLength(0);
    expect(await database.select().from(articleCommentReplies).where(eq(articleCommentReplies.articleId, article.id))).toHaveLength(0);
  });
});
