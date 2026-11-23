export const dynamic = "force-dynamic";

import { z } from "zod";
import { and, asc, eq } from "drizzle-orm";
import { AppError } from "@ob/core";
import { repo, articles, articleComments, articleCommentReplies, auditLogs, users } from "@ob/db";
import { route, parseBody } from "@/lib/api";
import { db } from "@/lib/services";
import { createCommentAnchor, getArticleCommentText } from "@/lib/article-comment-text";
import { articleCommentIds, serializeComment, serializeCommentReply } from "@/lib/article-comments-server";

export const GET = route(async (ctx, req) => {
  const { articleId } = articleCommentIds(req);
  const database = db();
  await repo.getArticle(database, ctx, articleId);
  const [comments, replies] = await Promise.all([
    database.select().from(articleComments).where(and(eq(articleComments.workspaceId, ctx.workspaceId), eq(articleComments.articleId, articleId)))
      .orderBy(asc(articleComments.createdAt), asc(articleComments.id)),
    database.select().from(articleCommentReplies).where(and(eq(articleCommentReplies.workspaceId, ctx.workspaceId), eq(articleCommentReplies.articleId, articleId)))
      .orderBy(asc(articleCommentReplies.createdAt), asc(articleCommentReplies.id)),
  ]);
  const byThread = new Map<string, typeof replies>();
  for (const reply of replies) {
    const thread = byThread.get(reply.commentId) ?? [];
    thread.push(reply); byThread.set(reply.commentId, thread);
  }
  return { comments: comments.map(comment => serializeComment(ctx, comment, byThread.get(comment.id))), canComment: true };
});

const commentBody = z.string().trim().min(1).max(4000);
const createSchema = z.union([
  z.object({
    expectedVersion: z.number().int().positive(),
    body: commentBody,
    anchor: z.object({
      quote: z.string().min(1).max(3000).refine(value => Boolean(value.trim())),
      prefix: z.string().max(64), suffix: z.string().max(64),
      start: z.number().int().min(0).max(500_000), end: z.number().int().positive().max(500_000),
    }).strict(),
  }).strict(),
  z.object({ parentId: z.uuid(), body: commentBody }).strict(),
]);

export const POST = route(async (ctx, req) => {
  const { articleId } = articleCommentIds(req);
  const body = await parseBody(req, createSchema, { maxBytes: 40_000 });
  const database = db();
  // Every operation is scoped to an article the signed-in workspace can read.
  await repo.getArticle(database, ctx, articleId);
  const [user] = await database.select({ name: users.name }).from(users).where(eq(users.id, ctx.userId)).limit(1);
  const authorName = user?.name?.trim() || "Workspace member";

  return database.transaction(async tx => {
    if ("parentId" in body) {
      const [parent] = await tx.select().from(articleComments).where(and(eq(articleComments.workspaceId, ctx.workspaceId),
        eq(articleComments.articleId, articleId), eq(articleComments.id, body.parentId))).for("update");
      if (!parent) throw new AppError("not_found", "This comment is no longer available.", { retryable: false });
      if (parent.resolvedAt) throw new AppError("conflict", "Reopen this discussion before adding a reply.", { retryable: false });
      const [reply] = await tx.insert(articleCommentReplies).values({ workspaceId: ctx.workspaceId, articleId,
        commentId: parent.id, authorId: ctx.userId, authorName, body: body.body }).returning();
      await tx.insert(auditLogs).values({ workspaceId: ctx.workspaceId, actorId: ctx.userId, actorType: "user",
        action: "article.comment.replied", entityType: "article", entityId: articleId,
        after: { commentId: parent.id, replyId: reply!.id }, correlationId: ctx.correlationId });
      return { reply: serializeCommentReply(reply!), parentId: parent.id };
    }

    // Lock against article saves; a selection from an older draft must never be attached to unrelated new text.
    const [article] = await tx.select().from(articles).where(and(eq(articles.workspaceId, ctx.workspaceId), eq(articles.id, articleId))).for("update");
    if (!article) throw new AppError("not_found", "This article is no longer available.", { retryable: false });
    if (article.version !== body.expectedVersion || article.status === "generating") {
      throw new AppError("conflict", "This article has changed. Refresh and select the text again before commenting.", { retryable: false });
    }
    const text = getArticleCommentText(article.title, article.bodyMarkdown);
    const { start, end, quote, prefix, suffix } = body.anchor;
    const expectedAnchor = createCommentAnchor(text, start, end);
    if (end - start !== quote.length || text.slice(start, end) !== quote ||
      prefix !== expectedAnchor.prefix || suffix !== expectedAnchor.suffix) {
      throw new AppError("conflict", "The selected passage has changed. Select it again before commenting.", { retryable: false });
    }
    const [comment] = await tx.insert(articleComments).values({ workspaceId: ctx.workspaceId, articleId,
      authorId: ctx.userId, authorName, articleVersion: article.version, quote, prefix, suffix,
      startOffset: start, endOffset: end, body: body.body }).returning();
    await tx.insert(auditLogs).values({ workspaceId: ctx.workspaceId, actorId: ctx.userId, actorType: "user",
      action: "article.comment.created", entityType: "article", entityId: articleId,
      after: { commentId: comment!.id, articleVersion: article.version }, correlationId: ctx.correlationId });
    return { comment: serializeComment(ctx, comment!) };
  });
}, { rateLimit: { limit: 120, windowSeconds: 60 } });
