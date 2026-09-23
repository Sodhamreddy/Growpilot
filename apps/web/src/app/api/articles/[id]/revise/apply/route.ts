export const dynamic = "force-dynamic";

import { z } from "zod";
import { eq } from "drizzle-orm";
import { AppError, requireRole } from "@ob/core";
import { repo, articles, articleRevisions } from "@ob/db";
import { splitSections, replaceSection } from "@ob/blog";
import { route, parseBody } from "@/lib/api";
import { db } from "@/lib/services";

/**
 * POST /api/articles/:id/revise/apply — accept a proposed revision.
 *
 * Separate from the propose call because approving is a different act from
 * asking. The reviewer has read the text by the time they get here, and what
 * lands is the text they read — the model is not consulted again.
 *
 * Applies the same versioning as a hand edit: previous body filed as a
 * revision, version bumped, scores cleared. Scores describe a version, and a
 * revised draft inheriting the previous version's SEO and voice scores would
 * hand the publish gate a number that no longer describes the text it is
 * gating.
 */

const schema = z.object({
  sectionId: z.string().min(1).max(8),
  content: z.string().max(100_000),
});

const EDITABLE = ["draft", "qa", "needs_changes", "awaiting_approval"];

export const POST = route(async (ctx, req) => {
  requireRole(ctx, "editor");
  const segments = new URL(req.url).pathname.split("/");
  const id = segments[segments.indexOf("articles") + 1] ?? "";
  const body = await parseBody(req, schema);
  const database = db();

  const article = await repo.getArticle(database, ctx, id);

  if (!EDITABLE.includes(article.status)) {
    throw new AppError(
      "validation_failed",
      "This article can no longer be edited.",
      { details: { status: article.status }, retryable: false },
    );
  }

  /*
   * Re-split the draft as it is now, not as it was when the proposal was made.
   *
   * Between proposing and applying, someone else may have saved an edit. If
   * the section count changed, the id the reviewer approved may now point at
   * different text — and silently writing over it would destroy work with no
   * trace. Refusing costs one retry; guessing costs a paragraph.
   */
  const sections = splitSections(article.bodyMarkdown);
  const target = sections.find((s) => s.id === body.sectionId);
  if (!target) {
    throw new AppError(
      "conflict",
      "The draft changed while you were reviewing. Ask again to see a fresh version.",
      { retryable: false },
    );
  }

  const nextBody = replaceSection(article.bodyMarkdown, body.sectionId, body.content);
  if (nextBody === article.bodyMarkdown) {
    return { ok: true, changed: false, version: article.version };
  }

  const nextVersion = article.version + 1;
  const wordCount = (nextBody.match(/[\p{L}\p{N}'’-]+/gu) ?? []).length;

  await database.transaction(async (tx) => {
    await tx.insert(articleRevisions).values({
      workspaceId: ctx.workspaceId,
      articleId: article.id,
      version: nextVersion,
      title: article.title,
      bodyMarkdown: nextBody,
      // Attributed to the person: they read the text and chose it, which is
      // what authorship means here even though a model drafted the words.
      authoredBy: "human",
    });

    await tx
      .update(articles)
      .set({
        bodyMarkdown: nextBody,
        version: nextVersion,
        wordCount,
        seoScore: null,
        voiceScore: null,
        updatedAt: new Date(),
      })
      .where(eq(articles.id, article.id));
  });

  await repo.writeAudit(database, ctx, {
    action: "article.revision_applied",
    entityType: "article",
    entityId: article.id,
    before: { version: article.version, section: target.content.slice(0, 500) },
    after: {
      version: nextVersion,
      sectionId: body.sectionId,
      heading: target.heading,
      section: body.content.slice(0, 500),
    },
  });

  return { ok: true, changed: true, version: nextVersion };
});
