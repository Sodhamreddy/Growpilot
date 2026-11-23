import { eq, and, inArray } from "drizzle-orm";
import { requireTenant } from "@/lib/auth";
import { db } from "@/lib/services";
import { repo, integrations, publishJobs } from "@ob/db";
import { isWaitingOn, teamReviewStage } from "@ob/pipeline";
import { loadSignOffs, loadTeamSetup, reviewProcessFor } from "@/lib/team-review-server";
import type { TeamStageName } from "@/lib/team-review-view";
import { BlogQueue } from "@/components/BlogQueue";
import { TopBar } from "@/components/TopBar";
import { getSession } from "@/lib/auth";
import { currentBlogAccess } from "@/lib/blog-access-server";
import { BLOG_HOME } from "@/lib/blog-access";

export const dynamic = "force-dynamic";

export default async function ArticlesPage({
  searchParams,
}: { searchParams: Promise<{ status?: string }> }) {
  const ctx = await requireTenant();
  const initials = await avatarInitials();
  const params = await searchParams;

  const database = db();
  const canEdit = ctx.role === "owner" || ctx.role === "admin" || ctx.role === "editor";

  /*
   * Everything that does not depend on the business, in one trip.
   *
   * These ran as four sequential awaits. Only `facts` genuinely needs the
   * business id; the workspace settings and the WordPress integration are both
   * keyed on the workspace and could always have gone in the first batch.
   * Against a database ~120ms away each unnecessary step is a visible pause,
   * and the settings query was the one I added last — put in the wrong place.
   */
  const [business, cmsRows, reviewProcess] = await Promise.all([
    repo.getPrimaryBusiness(database, ctx),
    database
      .select({ scopeKey: integrations.scopeKey, provider: integrations.provider, status: integrations.status })
      .from(integrations)
      .where(and(
        eq(integrations.workspaceId, ctx.workspaceId),
        eq(integrations.provider, "wordpress"),
      ))
      ,
    reviewProcessFor(database, ctx),
  ]);

  const [rows, allRows, facts] = await Promise.all([
    business ? repo.listArticles(database, ctx, {
      businessId: business.id,
      ...(params.status ? { status: [params.status] as never } : {}),
      limit: 100,
    }) : Promise.resolve([]),
    /*
     * Every article, for the chip counts and the stage cards.
     *
     * Counting the filtered set would make each chip show the number already
     * on screen, which tells a person nothing about where else to look.
     */
    params.status
      ? business
        ? repo.listArticles(database, ctx, { businessId: business.id, limit: 200 })
        : Promise.resolve([])
      : Promise.resolve(null),
    business ? repo.listFacts(database, ctx, business.id) : Promise.resolve([]),
  ]);

  const blogPrompts = business?.prompts?.blog;
  // When no filter is applied the two are the same query, so it is not run twice.
  const everything = allRows ?? rows;
  // Only meaningful once there is a business to publish for, matching the
  // previous behaviour where the query was skipped entirely without one.
  const cms = business ? cmsRows.find((r) => r.scopeKey === business?.id) : undefined;

  const serviceCount = facts.filter((f) => f.key === "service").length;

  /*
   * The team review: each article's level and whether it is waiting on the
   * person looking. Worked out from the same rules the approve and publish
   * routes enforce, so "Waiting on you" only lists what they can act on.
   */
  let team: Record<string, { stage: TeamStageName; mine: boolean }> | null = null;
  if (reviewProcess === "team" && everything.length) {
    const setup = await loadTeamSetup(database, ctx);
    if (setup.process === "team") {
      const ids = everything.map((article) => article.id);
      const approvedIds = everything.filter((article) => article.status === "approved" || article.status === "scheduled").map((article) => article.id);
      const [signOffs, sent] = await Promise.all([
        loadSignOffs(database, ctx, ids),
        approvedIds.length ? database.select({ articleId: publishJobs.entityId, version: publishJobs.articleVersion }).from(publishJobs)
          .where(and(eq(publishJobs.workspaceId, ctx.workspaceId), eq(publishJobs.entityType, "article"), eq(publishJobs.status, "succeeded"),
            inArray(publishJobs.entityId, approvedIds))) : Promise.resolve([]),
      ]);
      const delivered = new Set(sent.map((job) => `${job.articleId}:${job.version}`));
      const actor = { userId: ctx.userId, role: ctx.role };
      team = Object.fromEntries(everything.map((article) => {
        const stage = teamReviewStage(article, signOffs.filter((signOff) => signOff.articleId === article.id), { delivered: delivered.has(`${article.id}:${article.version}`) });
        return [article.id, { stage, mine: isWaitingOn(stage, actor, setup.roster) }];
      }));
    }
  }

  /*
   * Why topic suggestion cannot run, if it cannot.
   *
   * Stated as one specific sentence rather than a disabled button: a customer
   * looking at a dead control needs to know which thing to go and fix.
   */
  const setupReason = !business
    ? "Add your website and run a crawl first — topics are built from your business profile."
    : !business.confirmedAt
      ? "Confirm your business profile first. Suggestions are only as good as the facts behind them."
      : serviceCount === 0
        ? "Add at least one service in Settings → Business info. Topics are built from what you sell."
        : null;
  // A blog-only team member cannot open the business settings, so say who can fix it.
  const access = await currentBlogAccess();
  const blockedReason = setupReason && access.blogOnly
    ? `${setupReason} Ask a workspace admin to do this; it is outside Blog Automation.` : setupReason;

  return <>
    <TopBar section="Automation" page="Blog" initials={initials} homeHref={access.blogOnly ? BLOG_HOME : "/home"}
      teamRole={access.teamLabel ? { label: access.teamLabel, duty: access.teamDuty } : null} />
    <BlogQueue articles={rows} allArticles={everything} activeStatus={params.status ?? ""}
      businessId={business?.id ?? null} businessName={business?.name ?? ""} canEdit={canEdit}
      blockedReason={blockedReason} connected={cms?.status === "connected"} team={team}
      prompts={{ topics: blogPrompts?.topics ?? "", article: blogPrompts?.article ?? "", reference: blogPrompts?.reference ?? "" }} />
  </>;
}

/** Initials for the top-bar avatar. */
async function avatarInitials(): Promise<string> {
  const session = await getSession();
  return (
    (session?.name ?? session?.email ?? "?")
      .split(/[\s@.]+/).filter(Boolean).slice(0, 2)
      .map((p) => p[0]!.toUpperCase()).join("") || "?"
  );
}
