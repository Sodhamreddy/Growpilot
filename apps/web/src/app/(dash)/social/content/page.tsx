import { getClient } from "@/lib/tenant";
import { requireTenant, getSession } from "@/lib/auth";
import { db } from "@/lib/services";
import { monthToPlan, monthLabel } from "@ob/social";
import { TopBar } from "@/components/TopBar";
import { SocialHero } from "@/components/SocialHero";
import { SocialSteps } from "@/components/SocialSteps";
import { SocialMonthNav } from "@/components/SocialMonthNav";
import { SocialContentPacks } from "@/components/SocialContentPacks";
import { isMonthKey } from "@/lib/social-calendar";
import { loadMonthPosts } from "@/lib/social-posts";

/**
 * Social Media Timeline — step 3, content packs.
 *
 * Every post the month's calendar holds, with its written copy. The month is
 * the unit here as on the calendar, because a set of posts is reviewed as a
 * set: the same opening twice in one week is only visible side by side.
 */

export const dynamic = "force-dynamic";

export default async function SocialContentPage({
  searchParams,
}: { searchParams: Promise<{ month?: string; write?: string }> }) {
  const ctx = await requireTenant();
  const session = await getSession();
  const initials =
    (session?.name ?? session?.email ?? "?").split(/[\s@.]+/).filter(Boolean)
      .slice(0, 2).map((c) => c[0]!.toUpperCase()).join("") || "?";

  const params = await searchParams;
  const now = new Date();
  const currentMonthKey = now.toISOString().slice(0, 7);
  const monthKey = isMonthKey(params.month) ? params.month : monthToPlan(now);
  const database = db();
  const business = await getClient();
  const canEdit = ctx.role === "owner" || ctx.role === "admin" || ctx.role === "editor";
  const posts = await loadMonthPosts(database, ctx, business, monthKey);

  const blockedReason = !business
    ? "Add your business first. Posts are written from your business profile."
    : !business.confirmedAt
      ? "Confirm your business profile first. Copy is only as good as the facts behind it."
      : null;

  return (
    <>
      <TopBar section="Automation" page="Content Packs" initials={initials} />
      <div className="content social-page">
        <SocialHero />
        <SocialSteps current={3} monthKey={monthKey} />
        <SocialMonthNav monthKey={monthKey} currentMonthKey={currentMonthKey} basePath="/social/content" />
        <SocialContentPacks
          posts={posts}
          canEdit={canEdit}
          blockedReason={blockedReason}
          monthName={monthLabel(monthKey).split(" ")[0]!}
          monthKey={monthKey}
          /* Arriving from "Confirm calendar" on step 2 starts the writing. */
          autoWrite={params.write === "all"}
        />
      </div>
    </>
  );
}
