export const dynamic = "force-dynamic";

import { eq, and, desc } from "drizzle-orm";
import { repo, businessSources } from "@ob/db";
import { route } from "@/lib/api";
import { db } from "@/lib/services";

/**
 * GET /api/business/colors
 *
 * Returns the brand colours the crawler read out of the customer's own markup.
 *
 * Detection happens during the crawl, not here: colour lives in style
 * attributes and style blocks, and `source_pages` stores extracted text with
 * all of that already stripped out. Reading the stored text could only ever
 * find colours a site happens to mention in prose, which is why this endpoint
 * used to return nothing for every site.
 *
 * An empty list means "could not detect" and the caller must say so — never a
 * fabricated palette.
 */
export const GET = route(async (ctx) => {
  const database = db();
  const business = await repo.getPrimaryBusiness(database, ctx);
  if (!business) return { colors: [], logoUrl: null, reason: "no-business" };

  const [source] = await database
    .select({
      brandColors: businessSources.brandColors,
      crawlStatus: businessSources.crawlStatus,
    })
    .from(businessSources)
    .where(and(
      eq(businessSources.workspaceId, ctx.workspaceId),
      eq(businessSources.businessId, business.id),
    ))
    .orderBy(desc(businessSources.createdAt))
    .limit(1);

  if (!source) return { colors: [], logoUrl: business.logoUrl, reason: "no-crawl" };
  if (source.crawlStatus !== "succeeded") {
    return { colors: [], logoUrl: business.logoUrl, reason: `crawl-${source.crawlStatus}` };
  }

  const colors = source.brandColors.map((c) => ({ hex: c.hex, role: c.role }));

  return {
    colors,
    logoUrl: business.logoUrl,
    ...(colors.length === 0 ? { reason: "no-colors-in-markup" } : {}),
  };
});
