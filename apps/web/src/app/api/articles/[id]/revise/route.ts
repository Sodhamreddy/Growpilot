export const dynamic = "force-dynamic";

import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { AppError, requireRole } from "@ob/core";
import { repo, topics, keywords } from "@ob/db";
import { splitSections, reviseSection } from "@ob/blog";
import { route, parseBody } from "@/lib/api";
import { db, getGateway } from "@/lib/services";

/**
 * POST /api/articles/:id/revise — the blog companion.
 *
 * Takes a section and an instruction, returns proposed replacement text. It
 * does NOT write: the reviewer sees the before and after and decides. Saving
 * goes through the existing PATCH, which is what bumps the version and files a
 * revision — so an applied change is indistinguishable from a hand edit, and
 * the version history stays honest about what the draft has been through.
 *
 * Splitting propose from apply is the point. A companion that edited on the
 * model's say-so would be a faster way to damage a draft, and the rest of this
 * pipeline is built on a person approving before anything lands.
 */

const schema = z.object({
  expectedVersion: z.number().int().positive(),
  sectionId: z.string().min(1).max(8),
  instruction: z.string().trim().min(3, "Say what you want changed.").max(1000),
});

const EDITABLE = ["draft", "qa", "needs_changes", "awaiting_approval"];

export const POST = route(
  async (ctx, req) => {
    requireRole(ctx, "editor");
    const segments = new URL(req.url).pathname.split("/");
    const id = segments[segments.indexOf("articles") + 1] ?? "";
    const body = await parseBody(req, schema);
    const database = db();

    const article = await repo.getArticle(database, ctx, id);
    if (body.expectedVersion !== article.version) {
      throw new AppError("conflict", "The draft changed. Refresh before choosing a section to revise.", { retryable: false });
    }

    /*
     * Refuse on a state that cannot accept the result.
     *
     * Proposing a change for a published article would spend a model call to
     * produce text the reviewer then cannot apply — a dead end that looks like
     * a bug. Better to say why up front.
     */
    if (!EDITABLE.includes(article.status)) {
      throw new AppError(
        "validation_failed",
        article.status === "published"
          ? "This article is published. Request changes on it before revising."
          : `An article being ${article.status.replace(/_/g, " ")} cannot be revised right now.`,
        { retryable: false },
      );
    }

    const sections = splitSections(article.bodyMarkdown);
    const section = sections.find((s) => s.id === body.sectionId);
    if (!section) {
      throw new AppError("validation_failed", "That section is no longer in the draft.", {
        details: { sectionId: body.sectionId, available: sections.length },
        retryable: false,
      });
    }

    const [business, facts, voice] = await Promise.all([
      repo.getBusiness(database, ctx, article.businessId),
      repo.listFacts(database, ctx, article.businessId),
      repo.getActiveVoice(database, ctx, article.businessId),
    ]);

    // The keyword the article targets, so a revision does not drift off it.
    let primaryKeyword = article.title;
    if (article.topicId) {
      const [row] = await database
        .select({ term: keywords.term })
        .from(topics)
        .leftJoin(keywords, eq(keywords.id, topics.primaryKeywordId))
        .where(and(eq(topics.workspaceId, ctx.workspaceId), eq(topics.id, article.topicId)))
        .limit(1);
      if (row?.term) primaryKeyword = row.term;
    }

    /*
     * Links already in the draft are the only ones a revision may keep.
     *
     * Collected from the current text rather than from the brief: the brief's
     * targets are what the writer *could* have used, and offering the model a
     * URL this section never contained is an invitation to add one.
     */
    const allowedLinks = [...section.content.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)].map((m) => ({
      anchor: m[1]!,
      url: m[2]!,
    }));

    const result = await reviseSection(getGateway(), ctx, {
      business,
      facts,
      voice: voice
        ? {
            profile: voice.profile,
            bannedTerms: voice.bannedTerms,
            preferredTerms: voice.preferredTerms,
            samples: voice.samples,
          }
        : null,
      articleTitle: article.title,
      primaryKeyword,
      section,
      instruction: body.instruction,
      allowedLinks,
    });

    await repo.writeAudit(database, ctx, {
      action: "article.revision_proposed",
      entityType: "article",
      entityId: article.id,
      after: {
        sectionId: body.sectionId,
        heading: section.heading,
        instruction: body.instruction,
        changed: result.changed,
      },
    });

    return {
      ok: true,
      expectedVersion: article.version,
      sectionId: body.sectionId,
      heading: section.heading,
      before: section.content,
      after: result.content,
      changed: result.changed,
    };
  },
  // Each call is a model request against the workspace budget.
  { rateLimit: { limit: 60, windowSeconds: 3600 } },
);
