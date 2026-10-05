import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";
import type { TenantContext } from "@ob/core";
import { repo, socialCategories, socialTopics, type Database } from "@ob/db";
import { packWarnings, overlayText } from "@ob/social";
import type { PackPost } from "@/components/SocialPackParts";

/**
 * A month's posts with their packs, for the steps that work on the copy
 * (step 3) and on the picture (step 4).
 *
 * Only posts a month has claimed: scheduled onwards, dated inside the month.
 * Warnings are worked out here, on the server, where the brand's banned
 * words are known.
 */
export async function loadMonthPosts(
  database: Database,
  ctx: TenantContext,
  business: { id: string; prompts?: { social?: { wordsToAvoid?: string[] } } | null } | null,
  monthKey: string,
): Promise<PackPost[]> {
  if (!business) return [];
  const [y, m] = monthKey.split("-").map(Number);
  const start = new Date(Date.UTC(y!, m! - 1, 1));
  const end = new Date(Date.UTC(y!, m!, 1));

  const [rows, voice] = await Promise.all([
    database
      .select({
        id: socialTopics.id,
        title: socialTopics.title,
        hook: socialTopics.hook,
        audience: socialTopics.audience,
        format: socialTopics.format,
        occasion: socialTopics.occasion,
        status: socialTopics.status,
        postDate: socialTopics.postDate,
        pack: socialTopics.pack,
        categoryName: socialCategories.name,
      })
      .from(socialTopics)
      .innerJoin(socialCategories, eq(socialCategories.id, socialTopics.categoryId))
      .where(and(
        eq(socialTopics.workspaceId, ctx.workspaceId),
        eq(socialCategories.businessId, business.id),
        inArray(socialTopics.status, ["scheduled", "written", "approved", "published"]),
        gte(socialTopics.postDate, start),
        lt(socialTopics.postDate, end),
      ))
      .orderBy(asc(socialTopics.postDate), asc(socialTopics.createdAt)),
    repo.getActiveVoice(database, ctx, business.id),
  ]);

  const bannedTerms = [...new Set([
    ...(voice?.bannedTerms ?? []),
    ...(business.prompts?.social?.wordsToAvoid ?? []),
  ])];

  return rows.map((r) => ({
    id: r.id,
    date: r.postDate!.toISOString().slice(0, 10),
    title: r.title,
    hook: r.hook,
    audience: r.audience,
    format: r.format,
    occasion: r.occasion,
    categoryName: r.categoryName,
    status: r.status as PackPost["status"],
    // Packs written before imageText existed carry it only inside the brief.
    pack: r.pack ? { ...r.pack, imageText: r.pack.imageText ?? overlayText(r.pack.imageBrief) } : null,
    warnings: r.pack ? packWarnings(r.pack, { format: r.format, bannedTerms }) : [],
  }));
}
