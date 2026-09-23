export const dynamic = "force-dynamic";

import { z } from "zod";
import { and, asc, eq, count as countOf } from "drizzle-orm";
import { AppError, requireRole } from "@ob/core";
import { repo, socialCategories, socialTopics } from "@ob/db";
import { categoriesFor } from "@ob/social";
import { route, parseBody } from "@/lib/api";
import { db } from "@/lib/services";

/** Build social categories from facts a person has already confirmed. */
export const POST = route(async (ctx) => {
  requireRole(ctx, "editor");
  const database = db();
  const business = await repo.getPrimaryBusiness(database, ctx);

  if (!business) {
    throw new AppError("validation_failed", "Add a business profile before setting up social categories.", {
      retryable: false,
    });
  }
  if (!business.confirmedAt) {
    throw new AppError("validation_failed", "Confirm the business profile before setting up social categories.", {
      retryable: false,
    });
  }

  const existing = await database
    .select()
    .from(socialCategories)
    .where(eq(socialCategories.businessId, business.id))
    .orderBy(asc(socialCategories.position));

  /*
   * Content types, not service lines.
   *
   * This used to build one category per service, which gave a pharmacy six
   * buckets called "Home Delivery" and "Pill Packs". Sixteen topics about home
   * delivery repeat themselves by the fourth; sixteen about "Managing Your
   * Medication" do not, because the angle changes while the subject stays
   * broad. Services still anchor the topics inside each category.
   */
  const seeds = categoriesFor(business.industry, business.socialProfiles);

  /*
   * Add what is missing rather than stopping because something exists.
   *
   * Categories are seeded the first time somebody opens the social pillar,
   * which for a client added by URL is usually before the crawl has found
   * their accounts. Returning early meant the network categories could never
   * arrive: the only path that creates them had already run.
   *
   * Adding only the absent ones keeps this safe to call repeatedly and
   * preserves any category a person has since edited or reordered.
   */
  const have = new Set(existing.map((category) => category.name));
  const missing = seeds.filter((category) => !have.has(category.name));

  if (missing.length === 0) return { ok: true, categories: existing, created: 0 };

  // New categories go after the existing ones, so nothing a person has
  // already arranged shifts underneath them.
  const nextPosition = existing.reduce((n, c) => Math.max(n, (c.position ?? 0) + 1), 0);

  const created = await database
    .insert(socialCategories)
    .values(missing.map((category, offset) => ({
      workspaceId: ctx.workspaceId,
      businessId: business.id,
      name: category.name,
      description: category.description,
      position: nextPosition + offset,
      targetCount: category.targetCount,
    })))
    .onConflictDoNothing()
    .returning();

  await repo.writeAudit(database, ctx, {
    action: "social.categories_created",
    entityType: "business",
    entityId: business.id,
    after: { categories: created.map((category) => category.name) },
  });

  // The whole set, not just what this call added: the caller renders a
  // sidebar, and returning two new categories would blank the other nine.
  return {
    ok: true,
    categories: [...existing, ...created],
    created: created.length,
  };
});

/*
 * Editing the category set.
 *
 * The seeded set is a starting point, not a prescription. An agency knows
 * things about a client that no industry match does — a pharmacy that runs a
 * compounding lab, an agency that only sells to hospitals — and a category
 * they cannot rename or add is a plan they have to work around.
 *
 * PUT   add a category, or rename and re-describe an existing one
 * DELETE remove one, provided it holds no topics
 */

const upsertSchema = z.object({
  /** Absent to add, present to edit. */
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1, "Give the category a name.").max(80),
  description: z.string().trim().max(600).default(""),
  targetCount: z.number().int().min(1).max(60).default(16),
});

export const PUT = route(async (ctx, req) => {
  requireRole(ctx, "editor");
  const body = await parseBody(req, upsertSchema);
  const database = db();
  const business = await repo.getPrimaryBusiness(database, ctx);

  if (!business) {
    throw new AppError("validation_failed", "Select a client first.", { retryable: false });
  }

  /*
   * The name is unique per business, so a collision is a real conflict rather
   * than a database error to surface raw. Checked explicitly to say which
   * name, and excluding the row being edited so renaming a category to its
   * own current name is not a conflict with itself.
   */
  const clash = await database
    .select({ id: socialCategories.id })
    .from(socialCategories)
    .where(and(
      eq(socialCategories.businessId, business.id),
      eq(socialCategories.name, body.name),
    ))
    .limit(1);

  if (clash[0] && clash[0].id !== body.id) {
    throw new AppError("conflict", `${business.name} already has a "${body.name}" category.`, {
      retryable: false,
    });
  }

  if (body.id) {
    // Scoped by business as well as id: an id alone would let one workspace
    // edit another's category by guessing a uuid.
    const [updated] = await database
      .update(socialCategories)
      .set({
        name: body.name,
        description: body.description,
        targetCount: body.targetCount,
        updatedAt: new Date(),
      })
      .where(and(
        eq(socialCategories.id, body.id),
        eq(socialCategories.businessId, business.id),
        eq(socialCategories.workspaceId, ctx.workspaceId),
      ))
      .returning();

    if (!updated) {
      throw new AppError("not_found", "That category no longer exists.", { retryable: false });
    }

    await repo.writeAudit(database, ctx, {
      action: "social.category_updated",
      entityType: "business",
      entityId: business.id,
      after: { name: updated.name, targetCount: updated.targetCount },
    });

    return { ok: true, category: updated };
  }

  // New categories go last, so nothing a person has arranged shifts.
  const existing = await database
    .select({ position: socialCategories.position })
    .from(socialCategories)
    .where(eq(socialCategories.businessId, business.id));
  const position = existing.reduce((n, c) => Math.max(n, c.position + 1), 0);

  const [created] = await database
    .insert(socialCategories)
    .values({
      workspaceId: ctx.workspaceId,
      businessId: business.id,
      name: body.name,
      description: body.description,
      position,
      targetCount: body.targetCount,
    })
    .returning();

  await repo.writeAudit(database, ctx, {
    action: "social.category_created",
    entityType: "business",
    entityId: business.id,
    after: { name: body.name },
  });

  return { ok: true, category: created };
});

export const DELETE = route(async (ctx, req) => {
  requireRole(ctx, "editor");
  const body = await parseBody(req, z.object({ id: z.string().uuid() }));
  const database = db();
  const business = await repo.getPrimaryBusiness(database, ctx);

  if (!business) {
    throw new AppError("validation_failed", "Select a client first.", { retryable: false });
  }

  /*
   * Refuse while the category holds topics.
   *
   * social_topics cascades from social_categories, so removing a category
   * silently takes every topic written for it — including any already placed
   * in a month's calendar. Counting first makes that loss a decision rather
   * than a side effect, the same rule the client delete follows.
   *
   * One transaction, so a topic generated between the count and the delete
   * cannot slip through the guard.
   */
  let removed = "";
  await database.transaction(async (tx) => {
    const [category] = await tx
      .select({ id: socialCategories.id, name: socialCategories.name })
      .from(socialCategories)
      .where(and(
        eq(socialCategories.id, body.id),
        eq(socialCategories.businessId, business.id),
        eq(socialCategories.workspaceId, ctx.workspaceId),
      ))
      .limit(1);

    if (!category) {
      throw new AppError("not_found", "That category no longer exists.", { retryable: false });
    }

    const [row] = await tx
      .select({ count: countOf() })
      .from(socialTopics)
      .where(eq(socialTopics.categoryId, body.id));
    const topicCount = row?.count ?? 0;

    if (topicCount > 0) {
      throw new AppError(
        "conflict",
        `${category.name} holds ${topicCount} topic${topicCount === 1 ? "" : "s"}. ` +
          "Reject them first, or keep the category and leave it unused.",
        { retryable: false },
      );
    }

    await tx.delete(socialCategories).where(eq(socialCategories.id, body.id));
    removed = category.name;
  });

  // After the commit: an audit line for a delete that rolled back would be a
  // record of something that never happened.
  await repo.writeAudit(database, ctx, {
    action: "social.category_removed",
    entityType: "business",
    entityId: business.id,
    before: { name: removed },
  });

  return { ok: true };
});
