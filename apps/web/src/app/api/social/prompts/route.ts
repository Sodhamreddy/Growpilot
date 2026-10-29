export const dynamic = "force-dynamic";

import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { AppError, requireRole } from "@ob/core";
import { businesses, repo } from "@ob/db";
import { route, parseBody } from "@/lib/api";
import { db } from "@/lib/services";

/**
 * GET /api/social/prompts · PATCH /api/social/prompts
 *
 * The customer's own steering for the three social prompts: which topics get
 * proposed, how the post is written, and what the image should look like.
 *
 * Separate from the blog's for a reason beyond tidiness. A blog cares about
 * internal links and a focus keyword; a post cares about a character ceiling,
 * a hashtag convention and an image brief. Sharing one settings blob would tie
 * two pillars together that are deliberately independent, and a change meant
 * for one would silently alter the other.
 *
 * As with the blog, these layer onto the built-in prompts rather than
 * replacing them. The rules that keep a post factual and legal are not
 * editable here.
 */

const LIMITS = { topics: 8000, post: 8000, image: 4000, reference: 20000 } as const;

export const GET = route(async (ctx) => {
  const database = db();
  const business = await repo.getPrimaryBusiness(database, ctx);

  const p = business?.prompts?.social;

  return {
    prompts: {
      topics: p?.topics ?? "",
      post: p?.post ?? "",
      image: p?.image ?? "",
      reference: p?.reference ?? "",
      wordsToAvoid: p?.wordsToAvoid ?? [],
    },
    limits: LIMITS,
    role: ctx.role,
  };
});

const schema = z.object({
  businessId: z.string().uuid(),
  topics: z.string().max(LIMITS.topics).optional(),
  post: z.string().max(LIMITS.post).optional(),
  image: z.string().max(LIMITS.image).optional(),
  reference: z.string().max(LIMITS.reference).optional(),
  /** One per line in the UI, an array here. */
  wordsToAvoid: z.array(z.string().trim().min(1).max(80)).max(60).optional(),
});

export const PATCH = route(async (ctx, req) => {
  // These change what every future post says, so it is an editor's decision.
  requireRole(ctx, "editor");
  const body = await parseBody(req, schema);
  const database = db();

  // Against the client on screen, not the workspace. See the blog route.
  const business = await repo.getBusiness(database, ctx, body.businessId);
  if (!business) {
    throw new AppError("validation_failed", "Select a client before saving instructions.", {
      retryable: false,
    });
  }

  const social = { ...(business.prompts?.social ?? {}) };

  for (const key of ["topics", "post", "image", "reference"] as const) {
    if (body[key] === undefined) continue;
    const value = body[key]!.trim();
    if (value) social[key] = value;
    else delete social[key];
  }

  if (body.wordsToAvoid !== undefined) {
    const words = [...new Set(body.wordsToAvoid.map((w) => w.trim()).filter(Boolean))];
    if (words.length) social.wordsToAvoid = words;
    else delete social.wordsToAvoid;
  }

  const prompts = { ...(business.prompts ?? {}), social };

  await database
    .update(businesses)
    .set({ prompts, updatedAt: new Date() })
    .where(and(eq(businesses.workspaceId, ctx.workspaceId), eq(businesses.id, business.id)));

  await repo.writeAudit(database, ctx, {
    action: "social.prompts_updated",
    entityType: "business",
    entityId: business.id,
    before: { social: business.prompts?.social ?? {} },
    after: { social },
  });

  return { ok: true };
});
