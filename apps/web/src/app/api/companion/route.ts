export const dynamic = "force-dynamic";

import { z } from "zod";
import { eq, asc } from "drizzle-orm";
import { requireRole } from "@ob/core";
import { repo, socialCategories, socialTopics } from "@ob/db";
import { interpret } from "@ob/companion";
import { route, parseBody } from "@/lib/api";
import { db, getGateway } from "@/lib/services";

/**
 * POST /api/companion — interpret what somebody typed.
 *
 * Returns an intent, never a side effect. Every action the companion can
 * choose is already an endpoint with its own role check and its own rate
 * limit, and routing through this one would mean those checks existed twice
 * with a chance of drifting apart.
 *
 * So the browser gets a validated instruction and calls the same endpoint a
 * button would have called. The companion is a faster way to reach the
 * product's actions, not a second way around them.
 */

const schema = z.object({
  message: z.string().trim().min(1).max(500),
  currentPath: z.string().max(200),
  history: z
    .array(z.object({
      role: z.enum(["user", "assistant"]),
      content: z.string().max(1000),
    }))
    .max(10)
    .optional(),
  /** The open article, when there is one, so section names resolve. */
  articleId: z.string().uuid().optional(),
});

export const POST = route(
  async (ctx, req) => {
    requireRole(ctx, "editor");
    const body = await parseBody(req, schema);
    const database = db();

    const business = await repo.getPrimaryBusiness(database, ctx);

    /*
     * Only what exists, and only for this workspace.
     *
     * The model can reference a category or a section that is not on this
     * list, and the interpreter refuses when it does. Sending the real list
     * makes that refusal rare rather than the normal case.
     */
    const categories = business
      ? await database
          .select({
            id: socialCategories.id,
            name: socialCategories.name,
            targetCount: socialCategories.targetCount,
          })
          .from(socialCategories)
          .where(eq(socialCategories.businessId, business.id))
          .orderBy(asc(socialCategories.position))
      : [];

    const filled = business
      ? await database
          .select({ categoryId: socialTopics.categoryId, status: socialTopics.status })
          .from(socialTopics)
          .where(eq(socialTopics.workspaceId, ctx.workspaceId))
      : [];

    const countByCategory = new Map<string, number>();
    for (const t of filled) {
      if (t.status === "rejected") continue;
      countByCategory.set(t.categoryId, (countByCategory.get(t.categoryId) ?? 0) + 1);
    }

    let articleSections: { id: string; heading: string }[] = [];
    if (body.articleId) {
      const article = await repo.getArticle(database, ctx, body.articleId);
      // Imported lazily: the blog module owns what a section of an article is,
      // and the companion package must not depend on it.
      const { splitSections } = await import("@ob/blog");
      articleSections = splitSections(article.bodyMarkdown).map((s) => ({
        id: s.id,
        heading: s.heading,
      }));
    }

    const result = await interpret(getGateway(), ctx, {
      message: body.message,
      ...(body.history ? { history: body.history } : {}),
      context: {
        currentPath: body.currentPath,
        available: {
          categories: categories.map((c) => ({
            id: c.id,
            name: c.name,
            filled: countByCategory.get(c.id) ?? 0,
            target: c.targetCount,
          })),
          ...(body.articleId ? { articleId: body.articleId } : {}),
          articleSections,
        },
      },
    });

    return { ok: true, ...result };
  },
  /*
   * Rate limited like any other model call.
   *
   * A chat box invites rapid typing in a way a button does not, and every
   * message is a request against the workspace's budget.
   */
  { rateLimit: { limit: 120, windowSeconds: 3600 } },
);
