import { z } from "zod";
import { AppError, type TenantContext } from "@ob/core";
import { articleComments, articleCommentReplies } from "@ob/db";

export function articleCommentIds(req: Request, withComment = false) {
  const segments = new URL(req.url).pathname.split("/");
  const articleId = segments[segments.indexOf("articles") + 1] ?? "";
  const commentId = segments[segments.indexOf("comments") + 1] ?? "";
  if (!z.uuid().safeParse(articleId).success || (withComment && !z.uuid().safeParse(commentId).success)) {
    throw new AppError("validation_failed", "Choose a valid article or comment.", { retryable: false });
  }
  return { articleId, commentId };
}

export function canResolveComment(ctx: TenantContext, authorId: string | null) {
  return ctx.userId === authorId || ["owner", "admin", "editor"].includes(ctx.role);
}

export function serializeCommentReply(reply: typeof articleCommentReplies.$inferSelect) {
  return { id: reply.id, authorName: reply.authorName, body: reply.body, createdAt: reply.createdAt.toISOString() };
}

export function serializeComment(ctx: TenantContext, comment: typeof articleComments.$inferSelect,
  replies: (typeof articleCommentReplies.$inferSelect)[] = []) {
  return {
    id: comment.id, authorName: comment.authorName, articleVersion: comment.articleVersion,
    anchor: { quote: comment.quote, prefix: comment.prefix, suffix: comment.suffix, start: comment.startOffset, end: comment.endOffset },
    body: comment.body, resolvedAt: comment.resolvedAt?.toISOString() ?? null, createdAt: comment.createdAt.toISOString(),
    replies: replies.map(serializeCommentReply), canResolve: canResolveComment(ctx, comment.authorId),
  };
}
