export const dynamic = "force-dynamic";

import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { AppError, requireRole, slugify } from "@ob/core";
import { repo, businessLocations, topics, articles, keywords, auditLogs } from "@ob/db";
import { suggestTrendingTopics } from "@ob/blog";
import { JOBS, payloadFrom } from "@ob/jobs";
import { route, parseBody } from "@/lib/api";
import { db, getGateway, getQueues } from "@/lib/services";
import { contentBriefSchema, mustIncludeSchema, withMustInclude } from "@/lib/content-brief";

/**
 * Blog automation, step one: propose topics; step two: commit one.
 *
 * POST  — ask the model for topic suggestions grounded in services and locations.
 * PUT   — accept one suggestion, create the article, and queue generation.
 *
 * Suggestions are deliberately NOT written to the database. They are a
 * proposal: a customer looks at five and picks one, and storing the four they
 * rejected would leave the topics table full of things nobody chose and the
 * content plan unreadable. Only an accepted topic becomes a row.
 */

const suggestSchema = z.object({
  businessId: z.string().uuid(),
  limit: z.number().int().min(1).max(10).optional(),
});

const acceptSchema = z.object({
  businessId: z.string().uuid(),
  title: z.string().min(4).max(200),
  primaryKeyword: z.string().min(2).max(120),
  intent: z.enum(["informational", "commercial", "transactional", "local"]),
  rationale: z.string().max(1000).optional(),
  brief: contentBriefSchema.optional(),
  mustInclude: mustIncludeSchema.optional(),
});

export const POST = route(
  async (ctx, req) => {
    requireRole(ctx, "editor");
    const body = await parseBody(req, suggestSchema);
    const database = db();

    const business = await repo.getBusiness(database, ctx, body.businessId);

    if (!business.confirmedAt) {
      throw new AppError(
        "validation_failed",
        "Confirm the business profile before generating topics — suggestions are only as good " +
          "as the facts they are built from.",
        { retryable: false },
      );
    }

    const [facts, locationRows, existingTopics, existingArticles] = await Promise.all([
      repo.listFacts(database, ctx, body.businessId),
      database
        .select({ label: businessLocations.label, locality: businessLocations.locality })
        .from(businessLocations)
        .where(and(
          eq(businessLocations.workspaceId, ctx.workspaceId),
          eq(businessLocations.businessId, body.businessId),
        )),
      database
        .select({ title: topics.title })
        .from(topics)
        .where(and(eq(topics.workspaceId, ctx.workspaceId), eq(topics.businessId, body.businessId))),
      database
        .select({ title: articles.title })
        .from(articles)
        .where(and(eq(articles.workspaceId, ctx.workspaceId), eq(articles.businessId, body.businessId))),
    ]);

    const services = facts.filter((f) => f.key === "service").map((f) => f.value);

    // The customer's own steering for topic ideas, set in Blog settings.
    const prompts = business.prompts?.blog;

    if (services.length === 0) {
      throw new AppError(
        "validation_failed",
        "Add at least one service first. Topics are built from what you sell, and without that " +
          "the suggestions would be generic industry filler.",
        { details: { businessId: body.businessId }, retryable: false },
      );
    }

    const suggestions = await suggestTrendingTopics(getGateway(), ctx, {
      business: {
        name: business.name,
        industry: business.industry,
        audience: business.audience,
        usp: business.usp,
        description: business.description,
      },
      facts,
      services,
      locations: locationRows
        .map((l) => [l.label, l.locality].filter(Boolean).join(", "))
        .filter(Boolean),
      existingTitles: [
        ...existingTopics.map((t) => t.title),
        ...existingArticles.map((a) => a.title),
      ],
      ...(body.limit ? { limit: body.limit } : {}),
      ...(prompts?.topics?.trim() ? { instructions: prompts.topics } : {}),
      ...(prompts?.reference?.trim() ? { reference: prompts.reference } : {}),
    });

    await repo.writeAudit(database, ctx, {
      action: "topics.suggested",
      entityType: "business",
      entityId: body.businessId,
      after: { count: suggestions.length },
    });

    return { ok: true, topics: suggestions };
  },
  // Each call is a model request against the workspace budget.
  { rateLimit: { limit: 30, windowSeconds: 3600 } },
);

export const PUT = route(async (ctx, req) => {
  requireRole(ctx, "editor");
  const body = await parseBody(req, acceptSchema);
  const database = db();

  const business = await repo.getBusiness(database, ctx, body.businessId);
  if (!business.confirmedAt) throw new AppError("validation_failed", "Confirm the business profile before writing an article.");
  if (body.mustInclude?.length && !body.brief) throw new AppError("validation_failed", "Prepare a brief before adding writing requirements.");

  const { topic, article } = await database.transaction(async tx => {
    const database = tx;

    /*
     * Record the keyword this topic targets.
     *
     * The article generator resolves its primary keyword through the topic's
     * `primaryKeywordId`, so a suggestion accepted here has to leave a keyword
     * row behind or generation falls back to the title. `onConflictDoNothing`
     * covers the case where research already found the same term.
     */
    const term = body.primaryKeyword.trim().toLowerCase();
    await database
      .insert(keywords)
      .values({
        workspaceId: ctx.workspaceId,
        businessId: body.businessId,
        term,
        intent: body.intent,
        location: "",
        provider: "suggested",
        // A suggested keyword has no market data, and inventing a score for it
        // would put it above researched terms for no reason.
        relevance: 0.8,
        refreshedAt: new Date(),
      })
      .onConflictDoNothing({ target: [keywords.businessId, keywords.term, keywords.location] });

    const [keywordRow] = await database
      .select({ id: keywords.id })
      .from(keywords)
      .where(and(
        eq(keywords.workspaceId, ctx.workspaceId),
        eq(keywords.businessId, body.businessId),
        eq(keywords.term, term),
        eq(keywords.location, ""),
      ))
      .limit(1);

    const [topic] = await database
      .insert(topics)
      .values({
        workspaceId: ctx.workspaceId,
        businessId: body.businessId,
        title: body.title.trim(),
        primaryKeywordId: keywordRow?.id ?? null,
        secondaryTerms: [],
        intent: body.intent,
        // Chosen by a person, so it outranks anything the planner scored.
        priority: 100,
        publishDate: new Date(),
        status: "planned",
        ...(body.brief ? { brief: withMustInclude(body.brief, body.mustInclude ?? []) } : {}),
      })
      .returning();

    const [article] = await database
      .insert(articles)
      .values({
        workspaceId: ctx.workspaceId,
        businessId: body.businessId,
        topicId: topic!.id,
        title: topic!.title,
        slug: `${slugify(topic!.title) || "article"}-${Date.now().toString(36)}`,
        status: "draft",
      })
      .returning();

    await database.insert(auditLogs).values({
      workspaceId: ctx.workspaceId,
      actorId: ctx.userId,
      actorType: ctx.userId === "system" ? "system" : "user",
      correlationId: ctx.correlationId,
      action: "topic.accepted",
      entityType: "topic",
      entityId: topic!.id,
      after: {
        title: topic!.title,
        primaryKeyword: term,
        intent: body.intent,
        articleId: article!.id,
        rationale: body.rationale ?? "",
      },
    });
    return { topic: topic!, article: article! };
  });

  try {
    await getQueues().enqueue("ai", JOBS.generateArticle,
      payloadFrom(ctx, { articleId: article.id }), { idempotencyKey: `generate:${article.id}:v1` });
  } catch {
    // Preserve one recoverable article and return its ID. Retrying creation
    // after a queue outage would otherwise produce duplicate drafts.
    await database.update(articles).set({ status: "failed", updatedAt: new Date() })
      .where(and(eq(articles.workspaceId, ctx.workspaceId), eq(articles.id, article.id), eq(articles.status, "draft")));
    return { ok: true, topicId: topic.id, articleId: article.id, queued: false,
      warning: "Your article is saved, but writing could not start. Open it and retry when background processing is available." };
  }
  return { ok: true, topicId: topic.id, articleId: article.id, queued: true };
});
