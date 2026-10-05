export const dynamic = "force-dynamic";

import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { AppError, requireRole, type TenantContext } from "@ob/core";
import {
  repo, businessLocations, businessSources, socialCategories, socialTopics,
  type Database, type SocialContentPack,
} from "@ob/db";
import { writeContentPack, packWarnings, overlayText, scheduleLock } from "@ob/social";
import { route, parseBody } from "@/lib/api";
import { db, getGateway } from "@/lib/services";

/**
 * Content packs — step 3 of the social flow.
 *
 * POST   write (or rewrite) the pack for one scheduled post
 * PATCH  save edits, approve, or take an approval back
 *
 * One post per request, like topic generation. The page writes a month by
 * calling this once per post, so a person watches posts arrive and can stop
 * after the first if the voice is wrong, instead of paying for all of them.
 *
 * Status carries the review: `written` has copy nobody has signed off,
 * `approved` has a person's sign-off. Editing an approved pack returns it to
 * `written`, because the approval was for words that no longer exist.
 */

const writeSchema = z.object({ topicId: z.string().uuid() });

const editSchema = z.object({
  topicId: z.string().uuid(),
  action: z.enum(["save", "approve", "unapprove"]),
  /** Only read for `save`. */
  pack: z.object({
    caption: z.string().max(6000),
    shortCaption: z.string().max(600),
    hashtags: z.array(z.string().trim().min(2).max(80)).max(30),
    imageBrief: z.string().max(3000),
    altText: z.string().max(600),
    formatExtra: z.string().max(6000),
    imageText: z.string().max(2000),
  }).partial().optional(),
});

async function loadTopic(database: Database, ctx: TenantContext, topicId: string) {
  const [topic] = await database
    .select({
      id: socialTopics.id,
      title: socialTopics.title,
      hook: socialTopics.hook,
      audience: socialTopics.audience,
      format: socialTopics.format,
      occasion: socialTopics.occasion,
      dateRule: socialTopics.dateRule,
      imageIdea: socialTopics.imageIdea,
      postDate: socialTopics.postDate,
      monthId: socialTopics.monthId,
      status: socialTopics.status,
      pack: socialTopics.pack,
      categoryName: socialCategories.name,
      businessId: socialCategories.businessId,
    })
    .from(socialTopics)
    .innerJoin(socialCategories, eq(socialCategories.id, socialTopics.categoryId))
    .where(and(eq(socialTopics.workspaceId, ctx.workspaceId), eq(socialTopics.id, topicId)))
    .limit(1);
  if (!topic) {
    throw new AppError("not_found", "That post is not in this workspace.", { retryable: false });
  }
  return topic;
}

/**
 * Say what a failed model call means for the person waiting on it.
 *
 * The gateway's own message promises "the job will be retried", which is true
 * in the worker and false here: this request writes one post while someone
 * watches, and nothing retries it. A rate limit in particular needs naming,
 * because on a free tier it is usually the day's quota and waiting a minute
 * will not help.
 */
function explainProviderFailure(err: unknown): never {
  if (err instanceof AppError && (err.code === "provider_error" || err.code === "provider_timeout")) {
    const limited = String(err.details["summary"] ?? "").includes("rate_limited");
    throw new AppError(
      err.code,
      limited
        ? "The AI provider is rate limiting this key, so nothing was written. On a free tier that usually " +
          "means the day's request quota is used up. Try again later, or raise the key's quota."
        : "The AI provider could not write this post right now, so nothing was changed. Try again in a minute.",
      { details: err.details, retryable: true, cause: err },
    );
  }
  throw err;
}

/**
 * Carry a post's picture onto its new copy, back in draft.
 *
 * The picture prints the image text, so an approval given against the old
 * copy is not an approval of the new one. It is kept rather than dropped,
 * because often the words it carries did not change.
 */
function withStaleImage(next: SocialContentPack, previous: SocialContentPack | null): SocialContentPack {
  const image = previous?.image;
  return image ? { ...next, image: { ...image, status: "draft" } } : next;
}

/** Words the brand avoids: the active voice's list plus the social settings'. */
async function bannedTerms(database: Database, ctx: TenantContext, businessId: string, extra: string[]) {
  const voice = await repo.getActiveVoice(database, ctx, businessId);
  return [...new Set([...(voice?.bannedTerms ?? []), ...extra])];
}

export const POST = route(
  async (ctx, req) => {
    requireRole(ctx, "editor");
    const body = await parseBody(req, writeSchema);
    const database = db();
    const topic = await loadTopic(database, ctx, body.topicId);

    if (!topic.monthId || !topic.postDate) {
      throw new AppError(
        "validation_failed",
        "Put this topic on the calendar first. A pack is written for a date.",
        { retryable: false },
      );
    }
    if (topic.status === "approved" || topic.status === "published") {
      throw new AppError(
        "conflict",
        topic.status === "approved"
          ? "This pack is approved. Take the approval back before rewriting it."
          : "This post is published and its copy can no longer change.",
        { retryable: false },
      );
    }

    const business = await repo.getBusiness(database, ctx, topic.businessId);
    if (!business.confirmedAt) {
      throw new AppError(
        "validation_failed",
        "Confirm the business profile before writing posts. Copy is only as good as the facts behind it.",
        { retryable: false },
      );
    }

    const social = business.prompts?.social;
    const [facts, locationRows, [source], voice] = await Promise.all([
      repo.listFacts(database, ctx, business.id),
      database
        .select({ label: businessLocations.label, locality: businessLocations.locality })
        .from(businessLocations)
        .where(and(
          eq(businessLocations.workspaceId, ctx.workspaceId),
          eq(businessLocations.businessId, business.id),
        )),
      database
        .select({ brandColors: businessSources.brandColors })
        .from(businessSources)
        .where(and(
          eq(businessSources.workspaceId, ctx.workspaceId),
          eq(businessSources.businessId, business.id),
          eq(businessSources.crawlStatus, "succeeded"),
        ))
        .orderBy(desc(businessSources.createdAt))
        .limit(1),
      repo.getActiveVoice(database, ctx, business.id),
    ]);

    const result = await writeContentPack(getGateway(), ctx, {
      business: {
        name: business.name,
        industry: business.industry,
        audience: business.audience,
        usp: business.usp,
        description: business.description,
      },
      facts,
      locations: locationRows.map((l) => [l.label, l.locality].filter(Boolean).join(", ")).filter(Boolean),
      voice: voice
        ? {
            profile: voice.profile,
            bannedTerms: voice.bannedTerms,
            preferredTerms: voice.preferredTerms,
            samples: voice.samples,
          }
        : null,
      post: {
        title: topic.title,
        hook: topic.hook,
        audience: topic.audience,
        format: topic.format,
        occasion: topic.occasion,
        dateRule: topic.dateRule,
        date: topic.postDate.toISOString().slice(0, 10),
        imageIdea: topic.imageIdea,
        categoryName: topic.categoryName,
      },
      prompts: {
        post: social?.post ?? "",
        image: social?.image ?? "",
        reference: social?.reference ?? "",
        wordsToAvoid: social?.wordsToAvoid ?? [],
      },
      brandColors: (source?.brandColors ?? []).slice(0, 4).map((c) => `${c.hex} (${c.role})`),
    }).catch(explainProviderFailure);

    // A picture made earlier stays, back in draft: new copy may change its words.
    const pack = withStaleImage(result.pack, topic.pack);
    await database
      .update(socialTopics)
      .set({ pack, status: "written", updatedAt: new Date() })
      .where(eq(socialTopics.id, topic.id));

    await repo.writeAudit(database, ctx, {
      action: topic.pack ? "social.pack_rewritten" : "social.pack_written",
      entityType: "social_topic",
      entityId: topic.id,
      after: { warnings: result.warnings.length },
    });

    return { ok: true, status: "written", pack, warnings: result.warnings };
  },
  // Each call is a model request against the workspace budget.
  { rateLimit: { limit: 60, windowSeconds: 3600 } },
);

export const PATCH = route(async (ctx, req) => {
  requireRole(ctx, "editor");
  const body = await parseBody(req, editSchema);
  const database = db();
  const topic = await loadTopic(database, ctx, body.topicId);

  if (topic.status === "published") {
    throw new AppError("conflict", "This post is published and its copy can no longer change.", {
      retryable: false,
    });
  }
  const lock = scheduleLock(topic.pack);
  if (lock) throw new AppError("conflict", lock, { retryable: false });
  if (!topic.pack) {
    throw new AppError("validation_failed", "There is no copy to review yet. Write the pack first.", {
      retryable: false,
    });
  }

  let pack: SocialContentPack = topic.pack;
  let status: "written" | "approved";

  if (body.action === "save") {
    if (!body.pack) throw new AppError("validation_failed", "Nothing to change.", { retryable: false });
    pack = withStaleImage({
      ...topic.pack,
      ...body.pack,
      ...(body.pack.hashtags
        ? { hashtags: body.pack.hashtags.map((t) => (t.startsWith("#") ? t : `#${t}`)) }
        : {}),
    }, topic.pack);
    status = "written";
  } else if (body.action === "approve") {
    if (topic.status !== "written") {
      throw new AppError("conflict", "Only written copy can be approved.", { retryable: false });
    }
    status = "approved";
  } else {
    if (topic.status !== "approved") {
      throw new AppError("conflict", "This pack is not approved.", { retryable: false });
    }
    status = "written";
  }

  await database
    .update(socialTopics)
    .set({ pack, status, updatedAt: new Date() })
    .where(eq(socialTopics.id, topic.id));

  if (body.action !== "save") {
    await repo.writeAudit(database, ctx, {
      action: body.action === "approve" ? "social.pack_approved" : "social.pack_unapproved",
      entityType: "social_topic",
      entityId: topic.id,
    });
  }

  const business = await repo.getBusiness(database, ctx, topic.businessId);
  const banned = await bannedTerms(database, ctx, topic.businessId, business.prompts?.social?.wordsToAvoid ?? []);
  return {
    ok: true,
    status,
    // Packs written before imageText existed carry it only inside the brief.
    pack: { ...pack, imageText: pack.imageText ?? overlayText(pack.imageBrief) },
    warnings: packWarnings(pack, { format: topic.format, bannedTerms: banned }),
  };
});
