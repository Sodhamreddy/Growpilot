export const dynamic = "force-dynamic";

import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { AppError } from "@ob/core";
import { repo, articleComments, auditLogs } from "@ob/db";
import { route, parseBody } from "@/lib/api";
import { db } from "@/lib/services";
import { articleCommentIds, canResolveComment } from "@/lib/article-comments-server";

export const PATCH = route(async (ctx, req) => {
  const { articleId, commentId } = articleCommentIds(req, true);
  const body = await parseBody(req, z.object({ resolved: z.boolean() }).strict());
  const database = db();
  await repo.getArticle(database, ctx, articleId);
  return database.transaction(async tx => {
    const scope = and(eq(articleComments.workspaceId, ctx.workspaceId), eq(articleComments.articleId, articleId), eq(articleComments.id, commentId));
    const [comment] = await tx.select().from(articleComments).where(scope).for("update");
    if (!comment) throw new AppError("not_found", "This comment is no longer available.", { retryable: false });
    if (!canResolveComment(ctx, comment.authorId)) {
      throw new AppError("forbidden", "Only the comment author or an editor can resolve or reopen this discussion.", { retryable: false });
    }
    const resolvedAt = body.resolved ? comment.resolvedAt ?? new Date() : null;
    await tx.update(articleComments).set({ resolvedAt }).where(scope);
    if (Boolean(comment.resolvedAt) !== body.resolved) await tx.insert(auditLogs).values({
      workspaceId: ctx.workspaceId, actorId: ctx.userId, actorType: "user",
      action: body.resolved ? "article.comment.resolved" : "article.comment.reopened", entityType: "article", entityId: articleId,
      after: { commentId }, correlationId: ctx.correlationId,
    });
    return { id: commentId, resolvedAt: resolvedAt?.toISOString() ?? null };
  });
}, { rateLimit: { limit: 120, windowSeconds: 60 } });
