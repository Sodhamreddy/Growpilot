export const dynamic = "force-dynamic";

import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { AppError, requireRole } from "@ob/core";
import { repo, articles, articleRevisions } from "@ob/db";
import { route, parseBody } from "@/lib/api";
import { db } from "@/lib/services";

/** GET /api/articles/:id — full article with gate results and score breakdown. */
export const GET = route(async (ctx, req) => {
  const segments = new URL(req.url).pathname.split("/");
  const id = segments[segments.indexOf("articles") + 1] ?? "";
  const database = db();

  const article = await repo.getArticle(database, ctx, id);
  const [gates, score] = await Promise.all([
    repo.listGateResults(database, ctx, id, article.version),
    repo.getScore(database, ctx, id, article.version),
  ]);

  return {
    article: {
      id: article.id,
      title: article.title,
      slug: article.slug,
      metaTitle: article.metaTitle,
      metaDescription: article.metaDescription,
      bodyMarkdown: article.bodyMarkdown,
      status: article.status,
      version: article.version,
      seoScore: article.seoScore,
      voiceScore: article.voiceScore,
      wordCount: article.wordCount,
      approvedAt: article.approvedAt,
      publishedAt: article.publishedAt,
      publishedUrl: article.publishedUrl,
    },
    gates,
    scoreBreakdown: score?.components ?? null,
  };
});

const editSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  metaTitle: z.string().trim().max(70).nullable().optional(),
  metaDescription: z.string().trim().max(160).nullable().optional(),
  bodyMarkdown: z.string().max(200_000).optional(),
});

/**
 * PATCH /api/articles/:id — a person edits the draft.
 *
 * Editing bumps the version and keeps the previous body as a revision. That is
 * not bookkeeping: quality gates and scores are recorded against a version, so
 * an edit that changed the text without changing the version would leave a
 * score describing copy that no longer exists — and the publish gate reads that
 * score.
 *
 * Which states allow editing is deliberate. A published article is not editable
 * here; it goes back through `needs_changes` so the change is reviewed rather
 * than applied silently to something already public.
 */
const EDITABLE = ["draft", "qa", "needs_changes", "awaiting_approval"] as const;

export const PATCH = route(async (ctx, req) => {
  requireRole(ctx, "editor");
  const body = await parseBody(req, editSchema);
  const segments = new URL(req.url).pathname.split("/");
  const id = segments[segments.indexOf("articles") + 1] ?? "";
  const database = db();

  const article = await repo.getArticle(database, ctx, id);

  if (!EDITABLE.includes(article.status as (typeof EDITABLE)[number])) {
    throw new AppError(
      "conflict",
      article.status === "published"
        ? "This article is published. Request changes on it first, then edit."
        : `An article being ${article.status.replace(/_/g, " ")} cannot be edited right now.`,
      { details: { status: article.status }, retryable: false },
    );
  }

  const nextBody = body.bodyMarkdown ?? article.bodyMarkdown;
  const nextTitle = body.title ?? article.title;
  const textChanged = nextBody !== article.bodyMarkdown || nextTitle !== article.title;

  const updated = await database.transaction(async (tx) => {
    if (textChanged) {
      // Keep what was there before this edit, under the version it belonged to.
      await tx
        .insert(articleRevisions)
        .values({
          workspaceId: ctx.workspaceId,
          articleId: article.id,
          version: article.version,
          bodyMarkdown: article.bodyMarkdown,
          title: article.title,
          authoredBy: "ai",
        })
        .onConflictDoNothing({ target: [articleRevisions.articleId, articleRevisions.version] });
    }

    const [row] = await tx
      .update(articles)
      .set({
        title: nextTitle,
        ...(body.metaTitle !== undefined ? { metaTitle: body.metaTitle } : {}),
        ...(body.metaDescription !== undefined ? { metaDescription: body.metaDescription } : {}),
        bodyMarkdown: nextBody,
        wordCount: nextBody.trim() ? nextBody.trim().split(/\s+/).length : 0,
        /*
         * A human edit invalidates the machine scores.
         *
         * They describe the previous text. Leaving them in place would let an
         * edited article inherit a passing score it never earned, and the
         * publish gate reads exactly those numbers.
         */
        ...(textChanged
          ? { version: article.version + 1, seoScore: null, voiceScore: null }
          : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(articles.workspaceId, ctx.workspaceId), eq(articles.id, article.id)))
      .returning();

    return row!;
  });

  await repo.writeAudit(database, ctx, {
    action: "article.edited",
    entityType: "article",
    entityId: article.id,
    before: { version: article.version, wordCount: article.wordCount },
    after: { version: updated.version, wordCount: updated.wordCount },
  });

  return {
    ok: true,
    version: updated.version,
    wordCount: updated.wordCount,
    rescoreNeeded: textChanged,
  };
});
