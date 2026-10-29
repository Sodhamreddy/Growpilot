export const dynamic = "force-dynamic";

import { z } from "zod";
import { eq, and, inArray } from "drizzle-orm";
import { AppError, requireRole } from "@ob/core";
import { repo, socialCategories, socialTopics, socialMonths } from "@ob/db";
import { planMonth, monthToPlan, type CalendarCandidate } from "@ob/social";
import { route, parseBody } from "@/lib/api";
import { db } from "@/lib/services";
import { dragBlocker, dropBlocker } from "@/lib/social-calendar";

/**
 * POST /api/social/calendar — lay out a month from the pool.
 *
 * Two steps, deliberately. `preview` returns the plan and its warnings without
 * writing anything, so a reviewer sees "one audience is two thirds of the
 * month" before committing rather than after. `commit` writes the same plan.
 *
 * No model call anywhere in here. Which approved topic lands on which day is
 * arithmetic, and asking a model to do it would spend money to reintroduce the
 * invented dates the pool was built to avoid.
 */

const schema = z.object({
  businessId: z.string().uuid(),
  /** "2026-10". Defaults to whichever month is next up. */
  monthKey: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  target: z.number().int().min(1).max(31).optional(),
  mode: z.enum(["preview", "commit"]).default("preview"),
  /** Only these topics. Empty means draw from the whole pool. */
  topicIds: z.array(z.string().uuid()).max(60).optional(),
});

export const POST = route(async (ctx, req) => {
  requireRole(ctx, "editor");
  const body = await parseBody(req, schema);
  const database = db();

  await repo.getBusiness(database, ctx, body.businessId);

  const now = new Date();
  const monthKey = body.monthKey ?? monthToPlan(now);

  /*
   * Never schedule into the past.
   *
   * Planning the month already running is normal in the first week of using
   * this, and days that have gone are not available. For any future month the
   * whole month is open.
   */
  const thisMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const notBefore = monthKey === thisMonth ? now.getUTCDate() : 1;
  if (monthKey < thisMonth) {
    throw new AppError("validation_failed", "That month has already finished.", {
      retryable: false,
    });
  }

  const rows = await database
    .select({
      id: socialTopics.id,
      title: socialTopics.title,
      categoryId: socialTopics.categoryId,
      categoryName: socialCategories.name,
      audience: socialTopics.audience,
      format: socialTopics.format,
      postDate: socialTopics.postDate,
      occasion: socialTopics.occasion,
      recommended: socialTopics.recommended,
      monthId: socialTopics.monthId,
    })
    .from(socialTopics)
    .innerJoin(socialCategories, eq(socialCategories.id, socialTopics.categoryId))
    .where(and(
      eq(socialTopics.workspaceId, ctx.workspaceId),
      eq(socialCategories.businessId, body.businessId),
      eq(socialTopics.status, "idea"),
    ));

  const chosen = body.topicIds?.length ? new Set(body.topicIds) : null;

  const candidates: CalendarCandidate[] = rows
    // A topic already committed to another month is not available for this one.
    .filter((r) => !r.monthId)
    .filter((r) => !chosen || chosen.has(r.id))
    .map((r) => ({
      id: r.id,
      title: r.title,
      categoryId: r.categoryId,
      categoryName: r.categoryName,
      audience: r.audience,
      format: r.format,
      postDate: r.postDate ? r.postDate.toISOString().slice(0, 10) : null,
      occasion: r.occasion,
      recommended: r.recommended,
    }));

  /*
   * Posts already written for this month stay where they are.
   *
   * Their copy was written against a date, and an approved one carries a
   * person's sign-off. Replanning works around them rather than returning them
   * to the pool, the same rule unscheduling already follows.
   */
  const kept = await database
    .select({ postDate: socialTopics.postDate })
    .from(socialTopics)
    .innerJoin(socialMonths, eq(socialMonths.id, socialTopics.monthId))
    .where(and(
      eq(socialTopics.workspaceId, ctx.workspaceId),
      eq(socialMonths.businessId, body.businessId),
      eq(socialMonths.monthKey, monthKey),
      inArray(socialTopics.status, ["written", "approved", "published"]),
    ));

  const plan = planMonth(candidates, {
    monthKey,
    ...(body.target ? { target: body.target } : {}),
    notBefore,
    occupied: kept.flatMap((k) => (k.postDate ? [k.postDate.getUTCDate()] : [])),
  });

  if (body.mode === "preview") {
    return { ok: true, monthKey, plan, available: candidates.length, kept: kept.length };
  }

  if (plan.slots.length === 0 && kept.length === 0) {
    throw new AppError(
      "validation_failed",
      "There is nothing to schedule. Generate some topics first.",
      { retryable: false },
    );
  }

  const monthId = await database.transaction(async (tx) => {
    const [month] = await tx
      .insert(socialMonths)
      .values({
        workspaceId: ctx.workspaceId,
        businessId: body.businessId,
        monthKey,
        status: "planned",
        calendarEvents: Object.fromEntries(
          plan.slots
            .filter((s) => s.occasion)
            .map((s) => [String(Number(s.date.slice(8, 10))), s.occasion!]),
        ),
      })
      /*
       * Replanning a month replaces it.
       *
       * The alternative is a second row for the same month, and two calendars
       * for October is worse than losing the first attempt.
       */
      .onConflictDoUpdate({
        target: [socialMonths.businessId, socialMonths.monthKey],
        set: { status: "planned", updatedAt: new Date() },
      })
      .returning();

    // Release what the last attempt scheduled but nobody has written yet, so a
    // replan does not leave it stranded. Written posts stay (see `kept`).
    await tx
      .update(socialTopics)
      .set({ monthId: null, status: "idea", postDate: null, updatedAt: new Date() })
      .where(and(
        eq(socialTopics.workspaceId, ctx.workspaceId),
        eq(socialTopics.monthId, month!.id),
        eq(socialTopics.status, "scheduled"),
      ));

    for (const slot of plan.slots) {
      await tx
        .update(socialTopics)
        .set({
          monthId: month!.id,
          status: "scheduled",
          postDate: new Date(`${slot.date}T12:00:00Z`),
          updatedAt: new Date(),
        })
        .where(and(
          eq(socialTopics.workspaceId, ctx.workspaceId),
          eq(socialTopics.id, slot.topicId),
        ));
    }

    return month!.id;
  });

  await repo.writeAudit(database, ctx, {
    action: "social.month_planned",
    entityType: "business",
    entityId: body.businessId,
    after: {
      monthKey,
      posts: plan.slots.length,
      anchored: plan.tally.anchored,
      warnings: plan.warnings,
    },
  });

  return { ok: true, monthKey, monthId, plan };
});

/**
 * PATCH — move posts to other days of their month.
 *
 * All moves in one request and one transaction. They come from a person
 * rearranging a month and confirming it as a whole, and half of an
 * arrangement applied is an arrangement nobody made.
 */
const moveSchema = z.object({
  moves: z.array(z.object({
    topicId: z.string().uuid(),
    /** "YYYY-MM-DD". */
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })).min(1).max(62),
});

export const PATCH = route(async (ctx, req) => {
  requireRole(ctx, "editor");
  const body = await parseBody(req, moveSchema);
  const database = db();
  const todayIso = new Date().toISOString().slice(0, 10);

  const rows = await database
    .select({
      id: socialTopics.id,
      title: socialTopics.title,
      status: socialTopics.status,
      occasion: socialTopics.occasion,
      monthKey: socialMonths.monthKey,
    })
    .from(socialTopics)
    .innerJoin(socialMonths, eq(socialMonths.id, socialTopics.monthId))
    .where(and(
      eq(socialTopics.workspaceId, ctx.workspaceId),
      inArray(socialTopics.id, body.moves.map((m) => m.topicId)),
    ));
  const byId = new Map(rows.map((r) => [r.id, r]));

  for (const move of body.moves) {
    const topic = byId.get(move.topicId);
    if (!topic) {
      throw new AppError("not_found", "One of those posts is not on a calendar in this workspace.", {
        retryable: false,
      });
    }
    const blocker = dragBlocker(topic) ?? dropBlocker(move.date, { monthKey: topic.monthKey, todayIso });
    if (blocker) {
      throw new AppError("conflict", `${topic.title}: ${blocker}`, { retryable: false });
    }
  }

  await database.transaction(async (tx) => {
    for (const move of body.moves) {
      await tx
        .update(socialTopics)
        .set({ postDate: new Date(`${move.date}T12:00:00Z`), updatedAt: new Date() })
        .where(and(eq(socialTopics.workspaceId, ctx.workspaceId), eq(socialTopics.id, move.topicId)));
    }
  });

  await repo.writeAudit(database, ctx, {
    action: "social.posts_moved",
    entityType: "social_month",
    entityId: rows[0]?.monthKey,
    after: { moves: body.moves },
  });

  return { ok: true, moved: body.moves.length };
});

/** DELETE — unschedule a month, returning its topics to the pool. */
export const DELETE = route(async (ctx, req) => {
  requireRole(ctx, "editor");
  const body = await parseBody(req, z.object({ monthId: z.string().uuid() }));
  const database = db();

  const [month] = await database
    .select({ id: socialMonths.id, monthKey: socialMonths.monthKey })
    .from(socialMonths)
    .where(and(
      eq(socialMonths.workspaceId, ctx.workspaceId),
      eq(socialMonths.id, body.monthId),
    ))
    .limit(1);

  if (!month) {
    throw new AppError("not_found", "That month is not in this workspace.", { retryable: false });
  }

  /*
   * Written or published posts are not returned to the pool.
   *
   * Their copy was written against a date. Unscheduling one would leave a
   * finished post with nowhere to go and no record of when it was meant to run.
   */
  const retained = await database.transaction(async (tx) => {
    // Serialize with month replanning, which updates this same parent row.
    await tx.select({ id: socialMonths.id }).from(socialMonths)
      .where(eq(socialMonths.id, month.id)).for("update");
    await tx.update(socialTopics)
      .set({ monthId: null, status: "idea", postDate: null, updatedAt: new Date() })
      .where(and(eq(socialTopics.workspaceId, ctx.workspaceId), eq(socialTopics.monthId, month.id),
        eq(socialTopics.status, "scheduled")));
    const remaining = await tx.select({ id: socialTopics.id }).from(socialTopics)
      .where(eq(socialTopics.monthId, month.id)).limit(1);
    if (!remaining.length) await tx.delete(socialMonths).where(eq(socialMonths.id, month.id));
    return remaining.length > 0;
  });

  await repo.writeAudit(database, ctx, {
    action: "social.month_unplanned",
    entityType: "business",
    entityId: ctx.workspaceId,
    before: { monthKey: month.monthKey },
  });

  return { ok: true, retained };
});
