export const dynamic = "force-dynamic";

import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { AppError, requireRole, type TenantContext } from "@ob/core";
import {
  repo, businessSources, socialCategories, socialTopics,
  type Database, type PackImage, type SocialContentPack,
} from "@ob/db";
import { generatePostImage, scheduleLock } from "@ob/social";
import { route, parseBody } from "@/lib/api";
import { db, getGateway } from "@/lib/services";
import { saveImage, deleteImage, imageUrl } from "@/lib/image-store";

/**
 * Post images — step 4 of the social flow.
 *
 * POST (JSON)       generate the image from the approved copy
 * POST (multipart)  upload one instead: "file" and "topicId"
 * PATCH             approve the image, or take the approval back
 *
 * Nothing happens here until the post's copy is approved. The image prints
 * the image text on it, so making one from copy still under review would
 * mean making it again after every edit.
 */

const generateSchema = z.object({
  topicId: z.string().uuid(),
  /** Extra direction for this attempt only. */
  direction: z.string().trim().max(600).optional(),
});

const reviewSchema = z.object({
  topicId: z.string().uuid(),
  action: z.enum(["approve", "unapprove"]),
});

async function loadTopic(database: Database, ctx: TenantContext, topicId: string) {
  const [topic] = await database
    .select({
      id: socialTopics.id,
      status: socialTopics.status,
      format: socialTopics.format,
      pack: socialTopics.pack,
      businessId: socialCategories.businessId,
    })
    .from(socialTopics)
    .innerJoin(socialCategories, eq(socialCategories.id, socialTopics.categoryId))
    .where(and(eq(socialTopics.workspaceId, ctx.workspaceId), eq(socialTopics.id, topicId)))
    .limit(1);
  if (!topic) throw new AppError("not_found", "That post is not in this workspace.", { retryable: false });
  return topic;
}

/** The pack, once its copy is approved. Refuses otherwise, saying why. */
function approvedPack(topic: { status: string; pack: SocialContentPack | null }): SocialContentPack {
  if (topic.status === "published") {
    throw new AppError("conflict", "This post is published and its image can no longer change.", { retryable: false });
  }
  if (topic.status !== "approved" || !topic.pack) {
    throw new AppError(
      "conflict",
      "Approve the content in step 3 first. The image is made from the approved text.",
      { retryable: false },
    );
  }
  const lock = scheduleLock(topic.pack);
  if (lock) throw new AppError("conflict", lock, { retryable: false });
  return topic.pack;
}

/** Store a new image on the pack, replacing and removing the previous one. */
async function storeImage(
  database: Database,
  ctx: TenantContext,
  topicId: string,
  pack: SocialContentPack,
  image: PackImage,
) {
  const next: SocialContentPack = { ...pack, image };
  await database
    .update(socialTopics)
    .set({ pack: next, imageUrl: imageUrl(image.key), updatedAt: new Date() })
    .where(eq(socialTopics.id, topicId));
  if (pack.image && pack.image.key !== image.key) await deleteImage(ctx.workspaceId, pack.image.key);
  return next;
}

export const POST = route(
  async (ctx, req) => {
    requireRole(ctx, "editor");
    const database = db();

    // ── Upload ──
    if (req.headers.get("content-type")?.startsWith("multipart/form-data")) {
      const form = await req.formData();
      const topicId = z.string().uuid().safeParse(form.get("topicId"));
      const file = form.get("file");
      if (!topicId.success || !(file instanceof File)) {
        throw new AppError("validation_failed", "Choose an image to upload.", { retryable: false });
      }
      const topic = await loadTopic(database, ctx, topicId.data);
      const pack = approvedPack(topic);
      const saved = await saveImage(ctx.workspaceId, topic.id, new Uint8Array(await file.arrayBuffer()));
      const next = await storeImage(database, ctx, topic.id, pack, {
        key: saved.key, mimeType: saved.mimeType, source: "uploaded", status: "draft",
        createdAt: new Date().toISOString(),
      });
      await repo.writeAudit(database, ctx, {
        action: "social.image_uploaded", entityType: "social_topic", entityId: topic.id,
      });
      return { ok: true, pack: next, url: imageUrl(saved.key) };
    }

    // ── Generate ──
    const body = await parseBody(req, generateSchema);
    const topic = await loadTopic(database, ctx, body.topicId);
    const pack = approvedPack(topic);
    const business = await repo.getBusiness(database, ctx, topic.businessId);
    const [source] = await database
      .select({ brandColors: businessSources.brandColors })
      .from(businessSources)
      .where(and(
        eq(businessSources.workspaceId, ctx.workspaceId),
        eq(businessSources.businessId, business.id),
        eq(businessSources.crawlStatus, "succeeded"),
      ))
      .orderBy(desc(businessSources.createdAt))
      .limit(1);

    const result = await generatePostImage(getGateway(), ctx, {
      businessName: business.name,
      format: topic.format,
      imageText: pack.imageText ?? "",
      imageBrief: pack.imageBrief,
      brandColors: (source?.brandColors ?? []).slice(0, 4).map((c) => `${c.hex} (${c.role})`),
      ...(body.direction ? { direction: body.direction } : {}),
    });

    const saved = await saveImage(ctx.workspaceId, topic.id, result.data);
    const next = await storeImage(database, ctx, topic.id, pack, {
      key: saved.key, mimeType: saved.mimeType, source: "generated", status: "draft",
      createdAt: new Date().toISOString(), prompt: result.prompt, model: result.model,
    });
    await repo.writeAudit(database, ctx, {
      action: "social.image_generated", entityType: "social_topic", entityId: topic.id,
      after: { model: result.model, provider: result.provider },
    });
    return { ok: true, pack: next, url: imageUrl(saved.key) };
  },
  // Every generation is a paid model call against the workspace budget.
  { rateLimit: { limit: 30, windowSeconds: 3600 } },
);

export const PATCH = route(async (ctx, req) => {
  requireRole(ctx, "editor");
  const body = await parseBody(req, reviewSchema);
  const database = db();
  const topic = await loadTopic(database, ctx, body.topicId);
  const pack = approvedPack(topic);
  if (!pack.image) {
    throw new AppError("validation_failed", "There is no image to review yet. Generate or upload one first.", {
      retryable: false,
    });
  }

  const next: SocialContentPack = {
    ...pack,
    image: { ...pack.image, status: body.action === "approve" ? "approved" : "draft" },
  };
  await database.update(socialTopics).set({ pack: next, updatedAt: new Date() }).where(eq(socialTopics.id, topic.id));
  await repo.writeAudit(database, ctx, {
    action: body.action === "approve" ? "social.image_approved" : "social.image_unapproved",
    entityType: "social_topic",
    entityId: topic.id,
  });
  return { ok: true, pack: next };
});
