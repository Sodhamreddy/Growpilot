import { and, eq } from "drizzle-orm";
import { integrations } from "@ob/db";
import { getClient } from "@/lib/tenant";
import { requireTenant, getSession } from "@/lib/auth";
import { db } from "@/lib/services";
import { monthToPlan, monthLabel, publishBlocker } from "@ob/social";
import { TopBar } from "@/components/TopBar";
import { SocialHero } from "@/components/SocialHero";
import { SocialSteps } from "@/components/SocialSteps";
import { SocialMonthNav } from "@/components/SocialMonthNav";
import { SocialSchedule } from "@/components/SocialSchedule";
import { isMonthKey } from "@/lib/social-calendar";
import { loadMonthPosts } from "@/lib/social-posts";
import { loadConnection } from "@/lib/social-connection";
import { metaLoginBlocked } from "@/lib/meta-login";

/**
 * Social Media Timeline — step 5, scheduling.
 *
 * Posts whose copy and picture are both approved are given a time and the
 * networks to go to, and the worker publishes them then. The Meta connection
 * is shown first, network by network, because it decides what can be
 * scheduled at all.
 */

export const dynamic = "force-dynamic";

/** What a connect attempt came back with, in words. The codes are the callback's. */
const META_MESSAGES: Record<string, string> = {
  cancelled: "Facebook sign-in was cancelled. Nothing changed.",
  state_mismatch: "That connection attempt could not be verified. Please try again.",
  wrong_workspace: "That connection was started from a different workspace. Try again from this one.",
  no_code: "Facebook did not complete the connection. Please try again.",
  not_configured: "Facebook and Instagram are not set up on this server yet: META_APP_ID and META_APP_SECRET are missing.",
  exchange_failed: "Facebook would not issue an access token. Please try again.",
  no_pages: "That Facebook account does not manage any Pages, so there is nowhere to post.",
  graph_error: "Meta refused the request. If the app is still in App Review, posting works only for people with a role on the app.",
  failed: "The connection did not complete. Please try again.",
};

export default async function SocialSchedulePage({
  searchParams,
}: { searchParams: Promise<{ month?: string; meta?: string; meta_error?: string }> }) {
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

  const [posts, connection, [facebookRow]] = await Promise.all([
    loadMonthPosts(database, ctx, business, monthKey),
    loadConnection(database, ctx, business ? { name: business.name, metaPageId: business.metaPageId } : null),
    database
      .select({ status: integrations.status, displayName: integrations.displayName })
      .from(integrations)
      .where(and(eq(integrations.workspaceId, ctx.workspaceId), eq(integrations.provider, "facebook")))
      .limit(1),
  ]);

  // Worked out here: the rules live with the publisher, which the browser cannot load.
  const blockers = Object.fromEntries(posts.map((p) => [p.id, publishBlocker(p)]));

  const notice = params.meta_error
    ? { tone: "error", text: META_MESSAGES[params.meta_error] ?? META_MESSAGES.failed! }
    : params.meta === "connected"
      ? { tone: "ok", text: "Connected. Check below which networks are ready to post." }
      : null;

  return (
    <>
      <TopBar section="Automation" page="Schedule" initials={initials} />
      <div className="content social-page">
        {notice ? (
          <div className={`finding ${notice.tone === "ok" ? "info" : "error"}`} style={{ marginBottom: 16 }} role="status">
            {notice.text}
          </div>
        ) : null}
        <SocialHero />
        <SocialSteps current={5} monthKey={monthKey} />
        <SocialMonthNav monthKey={monthKey} currentMonthKey={currentMonthKey} basePath="/social/schedule" />
        <SocialSchedule
          posts={posts}
          blockers={blockers}
          connection={connection}
          businessName={business?.name ?? null}
          tokenConnected={facebookRow?.status === "connected"}
          tokenPages={facebookRow?.displayName ?? null}
          loginBlocked={metaLoginBlocked()}
          canEdit={canEdit}
          canConnect={ctx.role === "owner" || ctx.role === "admin"}
          monthName={monthLabel(monthKey).split(" ")[0]!}
          monthKey={monthKey}
        />
      </div>
    </>
  );
}
