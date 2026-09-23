export const dynamic = "force-dynamic";

import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { AppError, requireRole } from "@ob/core";
import { businesses, repo } from "@ob/db";
import { route, parseBody } from "@/lib/api";
import { db } from "@/lib/services";

/**
 * GET /api/blog/prompts · PATCH /api/blog/prompts
 *
 * The customer's own steering for the two blog prompts: what topics get
 * proposed, and how the article that follows is written.
 *
 * These are layered onto the built-in prompts, never substituted for them. The
 * rules that keep a draft grounded — only propose topics for services this
 * business actually sells, never invent a URL, never claim a location they do
 * not serve — are not editable here, because a customer cannot be expected to
 * know that deleting one sentence would let the model start making things up.
 * What is editable is editorial judgement, which is the part they are actually
 * the authority on.
 *
 * Blog-only by design. Social and GMB will want their own steering with their
 * own shape, and a shared "prompts" blob would quietly couple three pillars
 * that are meant to stay separate.
 */

/*
 * Room for a real prompt.
 *
 * These started at 2000 and immediately clipped a customer's working prompt
 * mid-word — the kind of damage that is invisible until a draft comes back
 * subtly wrong, because the instructions still *look* present. Sized now for
 * what people actually paste: a full editorial brief, not a one-line hint.
 */
const LIMITS = { topics: 8000, article: 8000, reference: 20000 } as const;

export const GET = route(async (ctx) => {
  const database = db();
  const business = await repo.getPrimaryBusiness(database, ctx);

  const p = business?.prompts?.blog;

  return {
    prompts: {
      topics: p?.topics ?? "",
      article: p?.article ?? "",
      reference: p?.reference ?? "",
    },
    limits: LIMITS,
    role: ctx.role,
  };
});

const schema = z.object({
  topics: z.string().max(LIMITS.topics).optional(),
  article: z.string().max(LIMITS.article).optional(),
  reference: z.string().max(LIMITS.reference).optional(),
});

export const PATCH = route(async (ctx, req) => {
  // These change what every future draft says, so it is an editor's decision.
  requireRole(ctx, "editor");
  const body = await parseBody(req, schema);
  const database = db();

  /*
   * Written against the client on screen, not the workspace.
   *
   * An agency runs several clients from one login and they are rarely in the
   * same trade. Storing these per workspace meant a pharmacy's instructions
   * were being applied to a marketing agency's articles.
   */
  const business = await repo.getPrimaryBusiness(database, ctx);
  if (!business) {
    throw new AppError("validation_failed", "Select a client before saving instructions.", {
      retryable: false,
    });
  }

  const blog = { ...(business.prompts?.blog ?? {}) };
  for (const key of ["topics", "article", "reference"] as const) {
    if (body[key] === undefined) continue;
    const value = body[key]!.trim();
    // An emptied box means "back to the default", so the key is removed rather
    // than stored as "" and rendered as an empty fenced block in the prompt.
    if (value) blog[key] = value;
    else delete blog[key];
  }

  const prompts = { ...(business.prompts ?? {}), blog };

  await database
    .update(businesses)
    .set({ prompts, updatedAt: new Date() })
    .where(and(eq(businesses.workspaceId, ctx.workspaceId), eq(businesses.id, business.id)));

  /*
   * Audited for the same reason the rest is: this is the least visible way to
   * change what gets published. A draft that reads differently next month is
   * otherwise indistinguishable from the model behaving differently.
   */
  await repo.writeAudit(database, ctx, {
    action: "blog.prompts_updated",
    entityType: "business",
    entityId: business.id,
    before: { blog: business.prompts?.blog ?? {} },
    after: { blog },
  });

  return { ok: true };
});
