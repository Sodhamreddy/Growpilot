import type { PackSchedule, SocialContentPack, SocialNetworkId } from "@ob/db";
import { markdownToPlain } from "./text.js";
import { GraphError, type PublishResult } from "./meta.js";

/**
 * Step 5: publishing an approved post to Facebook and Instagram.
 *
 * The rules for what may publish live here, used by the schedule page to say
 * why a post cannot be scheduled and by the worker to check again at the
 * moment of publishing, because approvals can be taken back in between.
 */

/**
 * Formats that are one picture and a caption, which is all a post can carry
 * today. A carousel needs every slide as an image and a reel needs a video;
 * posting their cover alone would publish something that is not the post.
 */
export const PUBLISHABLE_FORMATS = ["Static Image", "Quote", "Q and A", "Poll/Quiz", "GIF"];

/** Why this post cannot be published yet, or null when it can. */
export function publishBlocker(post: { status: string; format: string; pack: SocialContentPack | null }): string | null {
  if (post.status === "published") return "Already published.";
  if (post.status !== "approved" || !post.pack) return "Approve the copy in step 3 first.";
  if (!post.pack.image) return "Make or upload its image in step 4 first.";
  if (post.pack.image.status !== "approved") return "Approve its image in step 4 first.";
  if (!PUBLISHABLE_FORMATS.includes(post.format)) {
    return post.format === "Carousel"
      ? "Carousels need every slide as an image, and only the cover exists. Publish it by hand, or change the format."
      : `A ${post.format.toLowerCase()} post needs its media, which this tool does not make yet. Publish it by hand, or change the format.`;
  }
  return null;
}

/**
 * Why a post's copy and picture cannot change, because of its schedule.
 *
 * A scheduled post publishes what was approved when it was scheduled, so the
 * approvals stay put until it is taken off the schedule. Once any network has
 * it, it is out in the world and stays as it went. A schedule that failed
 * outright published nothing and holds nothing back.
 */
export function scheduleLock(pack: SocialContentPack | null): string | null {
  const schedule = pack?.schedule;
  if (!schedule) return null;
  if (Object.values(schedule.results).some((r) => r?.status === "published")) {
    return "Part of this post is already published, so it can no longer change.";
  }
  if (schedule.status === "failed") return null;
  return "This post is scheduled to publish. Unschedule it in step 5 before changing it.";
}

/**
 * The text a network receives: the shared caption as plain text, then the
 * hashtags. Both networks take the long caption; Instagram caps it at 2,200
 * characters and 30 hashtags, which the content rules keep well inside.
 */
export function postText(pack: SocialContentPack): string {
  const caption = markdownToPlain(pack.caption);
  const tags = pack.hashtags.slice(0, 30).join(" ");
  return tags ? `${caption}\n\n${tags}` : caption;
}

export interface PublishDeps {
  facebook: (message: string) => Promise<PublishResult>;
  instagram: (caption: string) => Promise<PublishResult>;
  checkpoint?: (schedule: PackSchedule) => Promise<void>;
  now?: () => Date;
}

/**
 * Publish to each network the schedule names that has not already succeeded.
 *
 * Returns the schedule with every network's outcome recorded. A network that
 * already published is skipped, so a retry after a partial success cannot
 * post the same photo twice. A failure on one network does not stop the
 * other: a Page post that went out should not be undone by Instagram.
 *
 * `retry` is true when some failure was transient (a timeout, a rate limit),
 * so the caller can try again later; permanent ones (a missing permission)
 * are not retried, because waiting will not grant them.
 */
export async function publishScheduled(
  pack: SocialContentPack,
  schedule: PackSchedule,
  deps: PublishDeps,
): Promise<{ schedule: PackSchedule; retry: boolean }> {
  const now = () => (deps.now?.() ?? new Date()).toISOString();
  const text = postText(pack);
  const results = { ...schedule.results };
  let retry = false;

  for (const network of schedule.networks) {
    if (results[network]?.status === "published") continue;
    try {
      const res = await (network === "facebook" ? deps.facebook(text) : deps.instagram(text));
      results[network] = { status: "published", id: res.id, url: res.url, at: now() };
    } catch (err) {
      if (err instanceof GraphError && err.outcomeUnknown) {
        results[network] = { status: "failed", error: err.message, at: now() };
        const uncertain: PackSchedule = { ...schedule, results, status: "publishing" };
        await deps.checkpoint?.(uncertain);
        return { schedule: uncertain, retry: false };
      }
      const permanent = err instanceof GraphError ? err.permanent : false;
      if (!permanent) retry = true;
      results[network] = {
        status: "failed",
        error: err instanceof Error ? err.message : "Publishing failed.",
        at: now(),
      };
    }
    // A persistence failure must stop before the next network is called.
    await deps.checkpoint?.({ ...schedule, results: { ...results }, status: "publishing" });
  }

  const outcomes = schedule.networks.map((n: SocialNetworkId) => results[n]?.status);
  const status: PackSchedule["status"] = outcomes.every((s) => s === "published")
    ? "published"
    : outcomes.some((s) => s === "published") ? "partial" : "failed";
  return { schedule: { ...schedule, results, status }, retry };
}
