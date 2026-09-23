export const dynamic = "force-dynamic";

import { z } from "zod";
import { eq, and, inArray } from "drizzle-orm";
import { AppError, requireRole } from "@ob/core";
import { repo, businessLocations, socialCategories, socialTopics } from "@ob/db";
import { generateCategoryTopics } from "@ob/social";
import { route, parseBody } from "@/lib/api";
import { db, getGateway } from "@/lib/services";

/**
 * Social topic pool — generate, then curate.
 *
 * POST   fill one category with topics
 * PATCH  reject or restore a topic
 *
 * One category per call, deliberately. Filling all nine in a single request
 * would be nine sequential model calls behind one spinner, and a prompt that
 * turns out to be wrong would cost the whole run before anyone saw a line of
 * it. Generating sixteen and reading them is the cheap way to find that out.
 */

const generateSchema = z.object({
  categoryId: z.string().uuid(),
  /** How many to add. Defaults to whatever is missing from the target. */
  count: z.number().int().min(1).max(24).optional(),
});

const curateSchema = z.object({
  topicId: z.string().uuid(),
  action: z.enum(["reject", "restore", "edit"]),
  /** Only read for `edit`. */
  format: z.string().trim().min(1).max(40).optional(),
});

export const POST = route(
  async (ctx, req) => {
    requireRole(ctx, "editor");
    const body = await parseBody(req, generateSchema);
    const database = db();

    const [category] = await database
      .select()
      .from(socialCategories)
      .where(and(
        eq(socialCategories.workspaceId, ctx.workspaceId),
        eq(socialCategories.id, body.categoryId),
      ))
      .limit(1);

    if (!category) {
      throw new AppError("not_found", "That category is not in this workspace.", {
        retryable: false,
      });
    }

    const business = await repo.getBusiness(database, ctx, category.businessId);

    if (!business.confirmedAt) {
      throw new AppError(
        "validation_failed",
        "Confirm the business profile before generating topics. Suggestions are only as good " +
          "as the facts they are built from.",
        { retryable: false },
      );
    }

    const [facts, locationRows, poolRows] = await Promise.all([
      repo.listFacts(database, ctx, category.businessId),
      database
        .select({ label: businessLocations.label, locality: businessLocations.locality })
        .from(businessLocations)
        .where(and(
          eq(businessLocations.workspaceId, ctx.workspaceId),
          eq(businessLocations.businessId, category.businessId),
        )),
      /*
       * Every title in the pool, not just this category's.
       *
       * A dementia topic and a companion-care topic can arrive at the same
       * idea from different directions, and the duplicate only becomes
       * obvious once both are on a calendar.
       */
      database
        .select({ title: socialTopics.title })
        .from(socialTopics)
        .where(eq(socialTopics.workspaceId, ctx.workspaceId)),
    ]);

    // Rejected topics do not count against the target: rejecting one is how a
    // reviewer asks for a replacement.
    const live = await database
      .select({ id: socialTopics.id })
      .from(socialTopics)
      .where(and(
        eq(socialTopics.categoryId, category.id),
        inArray(socialTopics.status, ["idea", "scheduled", "written", "approved", "published"]),
      ));
    const existing = live.length;

    const want = body.count ?? Math.max(0, category.targetCount - existing);
    if (want === 0) {
      throw new AppError(
        "validation_failed",
        `${category.name} already has its ${category.targetCount} topics. Reject some first, or ask for a specific number.`,
        { retryable: false },
      );
    }

    const result = await generateCategoryTopics(getGateway(), ctx, {
      business: {
        name: business.name,
        industry: business.industry,
        audience: business.audience,
        usp: business.usp,
        description: business.description,
      },
      facts,
      locations: locationRows
        .map((l) => [l.label, l.locality].filter(Boolean).join(", "))
        .filter(Boolean),
      category: { name: category.name, description: category.description },
      count: want,
      existingTitles: poolRows.map((r) => r.title),
      wordsToAvoid: business.prompts?.social?.wordsToAvoid ?? [],
    });

    if (result.topics.length > 0) {
      await database.insert(socialTopics).values(
        result.topics.map((t) => ({
          workspaceId: ctx.workspaceId,
          categoryId: category.id,
          title: t.title,
          hook: t.hook,
          audience: t.audience,
          format: t.format,
          imageIdea: t.imageIdea,
          occasion: t.occasion,
          // Stored as a date, not a string: a calendar has to sort and range
          // over these, and a text column would sort "2026-10-2" wrongly.
          postDate: t.postDate ? new Date(`${t.postDate}T12:00:00Z`) : null,
          dateRule: t.dateRule,
          recommended: t.recommended,
          recommendedWhy: t.recommendedWhy,
        })),
      );
    }

    await repo.writeAudit(database, ctx, {
      action: "social.topics_generated",
      entityType: "business",
      entityId: category.businessId,
      after: {
        category: category.name,
        added: result.topics.length,
        rejected: result.rejected.length,
      },
    });

    return {
      ok: true,
      added: result.topics.length,
      rejected: result.rejected,
      total: existing + result.topics.length,
      target: category.targetCount,
    };
  },
  // Each call is a model request against the workspace budget.
  { rateLimit: { limit: 40, windowSeconds: 3600 } },
);

export const PATCH = route(async (ctx, req) => {
  requireRole(ctx, "editor");
  const body = await parseBody(req, curateSchema);
  const database = db();

  const [topic] = await database
    .select({ id: socialTopics.id, status: socialTopics.status, monthId: socialTopics.monthId })
    .from(socialTopics)
    .where(and(
      eq(socialTopics.workspaceId, ctx.workspaceId),
      eq(socialTopics.id, body.topicId),
    ))
    .limit(1);

  if (!topic) {
    throw new AppError("not_found", "That topic is not in this workspace.", { retryable: false });
  }

  /*
   * A scheduled topic cannot be rejected out from under its month.
   *
   * The calendar would keep a slot pointing at something the reviewer had
   * thrown away, which is worse than refusing.
   */
  if (body.action === "reject" && topic.monthId) {
    throw new AppError(
      "conflict",
      "This topic is scheduled in a month. Remove it from the calendar first.",
      { retryable: false },
    );
  }

  if (body.action === "edit") {
    if (!body.format) {
      throw new AppError("validation_failed", "Nothing to change.", { retryable: false });
    }
    await database
      .update(socialTopics)
      .set({ format: body.format, updatedAt: new Date() })
      .where(eq(socialTopics.id, topic.id));
    return { ok: true, format: body.format };
  }

  await database
    .update(socialTopics)
    .set({ status: body.action === "reject" ? "rejected" : "idea", updatedAt: new Date() })
    .where(eq(socialTopics.id, topic.id));

  return { ok: true, status: body.action === "reject" ? "rejected" : "idea" };
});
