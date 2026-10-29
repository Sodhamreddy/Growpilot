export const dynamic = "force-dynamic";

import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { AppError, requireRole } from "@ob/core";
import { workspaces, businesses, repo } from "@ob/db";
import { route, parseBody } from "@/lib/api";
import { db } from "@/lib/services";

/**
 * POST /api/onboarding/step — spec §2.2 "Autosave every completed step".
 *
 * Each call patches one step's answer into `workspaces.settings.onboarding` and
 * records the step as completed, so a refresh or a back-navigation resumes
 * exactly where the customer left off rather than restarting the flow.
 */

const schema = z.object({
  step: z.enum(["discovery", "goals", "source", "detecting", "confirm", "colors", "pillars"]),
  /** Omitted when the customer skipped an optional step. */
  heardFrom: z.string().max(60).nullable().optional(),
  goals: z.array(z.enum(["articles", "local", "social"])).max(3).optional(),
  brandColors: z.array(z.object({ hex: z.string().regex(/^#[0-9a-fA-F]{6}$/), role: z.string().max(20) })).max(6).optional(),
  logoUrl: z.union([
    z.string().url().startsWith("https://").max(2000),
    z.string().max(7_100_000).regex(
      /^data:image\/(?:png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/,
      "Choose a valid PNG, JPG, WEBP or SVG logo.",
    ),
  ]).nullable().optional(),
  contentPillars: z.array(z.string().max(40)).max(6).optional(),
  tone: z.enum(["professional", "casual", "witty", "inspirational", "educational", "bold"]).optional(),
  platforms: z.array(z.string().max(20)).max(6).optional(),
  /** Marks the step complete without recording an answer. */
  skipped: z.boolean().optional(),
});

export const POST = route(
  async (ctx, req) => {
    requireRole(ctx, "admin");
    const body = await parseBody(req, schema, { maxBytes: 8 * 1024 * 1024 });
    if (body.step === "goals" && !body.goals?.length) throw new AppError("validation_failed", "Choose at least one goal.");
    if (body.step === "pillars" && new Set(body.contentPillars).size < 2) throw new AppError("validation_failed", "Choose at least two content themes.");
    if (body.skipped && !["discovery", "colors"].includes(body.step)) throw new AppError("validation_failed", "This step cannot be skipped.");
    const database = db();

    const [ws] = await database
      .select({ settings: workspaces.settings })
      .from(workspaces)
      .where(eq(workspaces.id, ctx.workspaceId))
      .limit(1);

    const onboarding = { ...(ws?.settings.onboarding ?? {}) };

    if (body.heardFrom !== undefined) {
      if (body.heardFrom === null) delete onboarding.heardFrom;
      else onboarding.heardFrom = body.heardFrom;
    }
    if (body.goals !== undefined) onboarding.goals = body.goals;
    if (body.brandColors !== undefined) onboarding.brandColors = body.brandColors;
    if (body.contentPillars !== undefined) onboarding.contentPillars = body.contentPillars;
    if (body.tone !== undefined) onboarding.tone = body.tone;
    if (body.platforms !== undefined) onboarding.platforms = body.platforms;

    const completed = new Set(onboarding.completedSteps ?? []);
    completed.add(body.step);
    onboarding.completedSteps = [...completed];

    await database
      .update(workspaces)
      .set({
        settings: { ...(ws?.settings ?? {}), onboarding },
        onboardingStep: body.step,
        updatedAt: new Date(),
      })
      .where(eq(workspaces.id, ctx.workspaceId));

    if (body.logoUrl !== undefined) {
      const business = await repo.getPrimaryBusiness(database, ctx);
      if (business) {
        await database
          .update(businesses)
          .set({ logoUrl: body.logoUrl, updatedAt: new Date() })
          .where(and(eq(businesses.workspaceId, ctx.workspaceId), eq(businesses.id, business.id)));
      }
    }

    return { ok: true, completedSteps: onboarding.completedSteps };
  },
  // Autosave fires on every step, so the limit has to accommodate a customer
  // moving back and forth through the flow.
  { rateLimit: { limit: 120, windowSeconds: 3600 } },
);

/** POST /api/onboarding/complete — marks the flow finished. */
export const PUT = route(async (ctx) => {
  requireRole(ctx, "admin");
  const database = db();
  const [ws] = await database.select().from(workspaces).where(eq(workspaces.id, ctx.workspaceId)).limit(1);
  if (ws?.onboardingCompletedAt) return { ok: true };
  const setup = ws?.settings.onboarding;
  const required = ["discovery", "goals", "source", "detecting", "confirm", "colors", "pillars"];
  if (!setup?.goals?.length || new Set(setup.contentPillars).size < 2 || required.some((step) => !setup?.completedSteps?.includes(step))) {
    throw new AppError("validation_failed", "Complete the remaining setup steps before continuing.");
  }
  const business = await repo.getPrimaryBusiness(database, ctx);
  if (!business?.confirmedAt) throw new AppError("validation_failed", "Review and confirm your business first.");
  /*
   * Finishing setup does not start writing.
   *
   * This used to queue keyword research, which chained into a content plan,
   * which drafted the top few articles. A customer who had only confirmed
   * their profile arrived at a dashboard holding content they never asked for,
   * already needing changes, each piece having cost a model call.
   *
   * Research is still one click away on the Keywords page, and topic
   * suggestions do not need it: they are built from services and locations.
   */
  await database
    .update(workspaces)
    .set({ onboardingCompletedAt: new Date(), onboardingStep: "done", updatedAt: new Date() })
    .where(eq(workspaces.id, ctx.workspaceId));
  return { ok: true };
});
