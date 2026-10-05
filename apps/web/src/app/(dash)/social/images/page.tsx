import { getClient } from "@/lib/tenant";
import { requireTenant, getSession } from "@/lib/auth";
import { db } from "@/lib/services";
import { monthToPlan, monthLabel } from "@ob/social";
import { TopBar } from "@/components/TopBar";
import { SocialHero } from "@/components/SocialHero";
import { SocialSteps } from "@/components/SocialSteps";
import { SocialMonthNav } from "@/components/SocialMonthNav";
import { SocialImagePacks } from "@/components/SocialImagePacks";
import { isMonthKey } from "@/lib/social-calendar";
import { loadMonthPosts } from "@/lib/social-posts";

/**
 * Social Media Timeline — step 4, image packs.
 *
 * The month's posts again, this time for their pictures. A post's picture is
 * made from its approved copy, so posts still in review are shown but wait.
 */

export const dynamic = "force-dynamic";

export default async function SocialImagesPage({
  searchParams,
}: { searchParams: Promise<{ month?: string }> }) {
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

  return (
    <>
      <TopBar section="Automation" page="Image Packs" initials={initials} />
      <div className="content social-page">
        <SocialHero />
        <SocialSteps current={4} monthKey={monthKey} />
        <SocialMonthNav monthKey={monthKey} currentMonthKey={currentMonthKey} basePath="/social/images" />
        <SocialImagePacks
          posts={posts}
          canEdit={canEdit}
          monthName={monthLabel(monthKey).split(" ")[0]!}
          monthKey={monthKey}
        />
      </div>
    </>
  );
}
