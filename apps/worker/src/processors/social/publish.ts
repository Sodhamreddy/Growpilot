import { and, eq } from "drizzle-orm";
import { AppError, open } from "@ob/core";
import { businesses, integrations, repo, socialCategories, socialTopics, type PackSchedule, type SocialContentPack } from "@ob/db";
import {
  GraphError, publishBlocker, publishFacebookPhoto, publishInstagramPhoto, publishScheduled,
  readImage, instagramJpegUrl,
} from "@ob/social";
import type { WorkerContext } from "../../context.js";
import { contextFromPayload } from "../../context.js";

/**
 * Publish one scheduled social post, at its time.
 *
 * Everything is checked again here rather than trusted from when it was
 * scheduled: the copy or the picture may have been un-approved since, the
 * post moved to another time, or the Page disconnected. A job for a time the
 * post no longer has is left alone, because the new time has its own job.
 *
 * Retries publish only where the last attempt did not, so a transient
 * Instagram failure cannot post the Facebook photo a second time.
 */

export interface PublishSocialPayload {
  workspaceId: string;
  userId: string;
  correlationId: string;
  topicId: string;
  /** The schedule time this job was made for. */
  at: string;
}

interface SealedCredential {
  pages: { id: string; name: string; accessToken: string; instagramId?: string }[];
}

export async function processPublishSocialPost(
  wc: WorkerContext,
  payload: PublishSocialPayload,
): Promise<{ status: string }> {
  const ctx = contextFromPayload(payload);
  const log = wc.logger.child({ correlationId: ctx.correlationId, workspaceId: ctx.workspaceId, topicId: payload.topicId });

  const [topic] = await wc.db
    .select({
      id: socialTopics.id,
      status: socialTopics.status,
      format: socialTopics.format,
      pack: socialTopics.pack,
      businessId: socialCategories.businessId,
    })
    .from(socialTopics)
    .innerJoin(socialCategories, eq(socialCategories.id, socialTopics.categoryId))
    .where(and(eq(socialTopics.workspaceId, ctx.workspaceId), eq(socialTopics.id, payload.topicId)))
    .limit(1);

  const schedule = topic?.pack?.schedule;
  if (!topic?.pack || !schedule || schedule.at !== payload.at) {
    log.info("Skipping a publish job for a time the post no longer has");
    return { status: "stale" };
  }
  if (schedule.status === "published") return { status: "published" };

  const pack: SocialContentPack = topic.pack;
  const save = async (next: PackSchedule, published = false) => {
    await wc.db
      .update(socialTopics)
      .set({ pack: { ...pack, schedule: next }, ...(published ? { status: "published" as const } : {}), updatedAt: new Date() })
      .where(eq(socialTopics.id, topic.id));
  };
  /** Mark every unpublished network failed with one reason, and stop without retrying. */
  const failAll = async (reason: string) => {
    const results = { ...schedule.results };
    for (const n of schedule.networks) {
      if (results[n]?.status !== "published") results[n] = { status: "failed", error: reason, at: new Date().toISOString() };
    }
    const anyPublished = schedule.networks.some((n) => results[n]?.status === "published");
    await save({ ...schedule, results, status: anyPublished ? "partial" : "failed" });
    log.warn("Social post not published", { reason });
    return { status: "failed" };
  };

  // Approvals can be taken back after scheduling; publishing then would post unapproved work.
  const blocker = publishBlocker({ status: topic.status, format: topic.format, pack });
  if (blocker) return failAll(`Not published: ${blocker}`);

  const [business] = await wc.db
    .select({ metaPageId: businesses.metaPageId, name: businesses.name })
    .from(businesses)
    .where(and(eq(businesses.workspaceId, ctx.workspaceId), eq(businesses.id, topic.businessId)))
    .limit(1);
  if (!business?.metaPageId) return failAll("No Facebook Page is chosen for this client. Choose one on the Schedule step.");

  const [connection] = await wc.db
    .select({ credentialSealed: integrations.credentialSealed })
    .from(integrations)
    .where(and(eq(integrations.workspaceId, ctx.workspaceId), eq(integrations.provider, "facebook")))
    .limit(1);
  if (!connection?.credentialSealed) return failAll("Facebook is not connected. Connect it on the Schedule step.");

  let page: SealedCredential["pages"][number] | undefined;
  try {
    const credential = JSON.parse(open(connection.credentialSealed, wc.cfg.CREDENTIAL_ENCRYPTION_KEY)) as SealedCredential;
    page = credential.pages.find((p) => p.id === business.metaPageId);
  } catch {
    return failAll("The stored Facebook connection could not be read. Reconnect it on the Schedule step.");
  }
  if (!page) return failAll(`The Facebook Page chosen for ${business.name} is not reachable with this connection. Reconnect or choose it again.`);

  const image = pack.image!;
  await save({ ...schedule, status: "publishing" });

  const result = await publishScheduled(pack, schedule, {
    facebook: async (message) => {
      const file = await readImage(ctx.workspaceId, image.key);
      if (!file) throw new GraphError({ message: "The post's image is missing from storage. Upload or generate it again.", permanent: true });
      return publishFacebookPhoto(page, { message, image: file.data, mimeType: file.mimeType });
    },
    instagram: async (caption) => {
      if (!page.instagramId) {
        throw new GraphError({ message: "No Instagram professional account is linked to this Facebook Page.", permanent: true });
      }
      const imageUrl = await instagramJpegUrl(ctx.workspaceId, image.key);
      if (!imageUrl) {
        throw new GraphError({
          message: "Instagram needs the image at a public address. Set up Supabase Storage (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY).",
          permanent: true,
        });
      }
      return publishInstagramPhoto({ instagramId: page.instagramId, accessToken: page.accessToken }, { caption, imageUrl });
    },
  });

  await save(result.schedule, result.schedule.status === "published");
  await repo.writeAudit(wc.db, ctx, {
    action: `social.post_${result.schedule.status}`,
    entityType: "social_topic",
    entityId: topic.id,
    after: { results: result.schedule.results },
  });
  log.info("Social post publish attempt", { status: result.schedule.status });

  if (result.retry) {
    // Transient failures try again with backoff; networks already done are skipped.
    throw new AppError("provider_error", "A network could not be reached. Retrying.", { retryable: true });
  }
  return { status: result.schedule.status };
}
