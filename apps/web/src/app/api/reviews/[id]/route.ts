export const dynamic = "force-dynamic";

import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { AppError, config, requireRole } from "@ob/core";
import { gmbReviews, repo, type ReviewReplyDraft } from "@ob/db";
import { REPLY_CHAR_LIMIT, draftReplyFor, googleCredentials, normaliseReply, postReply } from "@ob/gmb";
import { route, parseBody } from "@/lib/api";
import { db, getGateway } from "@/lib/services";

/**
 * PATCH /api/reviews/:id — work on one review's reply.
 *
 *   draft        generate (or regenerate) the reply
 *   save         keep a person's edits
 *   post         post it to Google (Business Profile reviews only)
 *   posted       record that it was posted on Google by hand
 *
 * Nothing reaches Google without a person pressing post: there is no
 * approve-and-forget, because a reply is public the moment it lands.
 */

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("draft") }),
  z.object({ action: z.literal("save"), body: z.string().max(REPLY_CHAR_LIMIT) }),
  z.object({ action: z.literal("post"), body: z.string().min(1).max(REPLY_CHAR_LIMIT) }),
  z.object({ action: z.literal("posted"), body: z.string().min(1).max(REPLY_CHAR_LIMIT) }),
]);

export const PATCH = route(
  async (ctx, req) => {
    requireRole(ctx, "editor");
    const id = new URL(req.url).pathname.split("/").filter(Boolean).pop() ?? "";
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new AppError("not_found", "That review is not in this workspace.", { retryable: false });
    const body = await parseBody(req, schema);
    const database = db();

    if (body.action === "draft") {
      const draft = await draftReplyFor(database, getGateway(), ctx, id);
      return { ok: true, draft };
    }

    if (body.action === "save") {
      const [review] = await database.select({ draft: gmbReviews.draft }).from(gmbReviews)
        .where(and(eq(gmbReviews.workspaceId, ctx.workspaceId), eq(gmbReviews.id, id))).limit(1);
      if (!review) throw new AppError("not_found", "That review is not in this workspace.", { retryable: false });
      if (review.draft?.status === "posted" || review.draft?.status === "posted_by_hand") {
        throw new AppError("conflict", "This reply is already posted. Edit it on Google.", { retryable: false });
      }
      const now = new Date().toISOString();
      const draft: ReviewReplyDraft = {
        ...(review.draft ?? { status: "draft", requiresHumanEdit: false, withheldReason: null, createdAt: now }),
        body: normaliseReply(body.body), edited: true, updatedAt: now,
      } as ReviewReplyDraft;
      await database.update(gmbReviews).set({ draft, updatedAt: new Date() }).where(eq(gmbReviews.id, id));
      return { ok: true, draft };
    }

    const result = await postReply(database, ctx, id, body.body, googleCredentials(config()), { byHand: body.action === "posted" });
    await repo.writeAudit(database, ctx, {
      action: body.action === "post" ? "reviews.reply_posted" : "reviews.reply_posted_by_hand",
      entityType: "gmb_review", entityId: id, after: { length: result.draft.body.length },
    });
    return { ok: true, ...result };
  },
  { rateLimit: { limit: 120, windowSeconds: 3600 } },
);
