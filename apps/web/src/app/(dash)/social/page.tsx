import { eq, and, asc } from "drizzle-orm";
import { getClient } from "@/lib/tenant";
import { requireTenant, getSession } from "@/lib/auth";
import { db } from "@/lib/services";
import { repo, socialCategories, socialTopics, socialMonths } from "@ob/db";
import { monthToPlan, monthLabel, daysLeftInMonth } from "@ob/social";
import { TopBar } from "@/components/TopBar";
import { SocialHero } from "@/components/SocialHero";
import { SocialSteps } from "@/components/SocialSteps";
import { SocialTopicPool, type PoolCategory } from "@/components/SocialTopicPool";
import { PlanMonthBanner } from "@/components/PlanMonthBanner";

/**
 * Social Media Timeline — the topic pool.
 *
 * The pool comes before the calendar. Nine categories, sixteen topics each,
 * generated a category at a time and curated by a person; a month's calendar
 * is then an editorial choice drawn from stock rather than a fresh generation
 * every month.
 *
 * Networks are not connected and nothing publishes yet. That is stated where
 * it matters rather than mocked with a disabled button.
 */

export const dynamic = "force-dynamic";

/**
 * "Sep 7 · Labor Day", or just the date when there is no occasion.
 *
 * Formatted in UTC deliberately. The date was chosen by the planner as a
 * calendar day, not an instant, and rendering it in the server's local zone
 * would shift it by one for anyone west of UTC.
 */
function dateLabel(date: Date | null, occasion: string | null): string | null {
  if (!date) return occasion || null;
  const day = date.toLocaleDateString("en-US", {
    month: "short", day: "numeric", timeZone: "UTC",
  });
  return occasion ? `${day} · ${occasion}` : day;
}

export default async function SocialPage() {
  const ctx = await requireTenant();
  const session = await getSession();
  const initials =
    (session?.name ?? session?.email ?? "?").split(/[\s@.]+/).filter(Boolean)
      .slice(0, 2).map((c) => c[0]!.toUpperCase()).join("") || "?";

  const database = db();
  const canEdit = ctx.role === "owner" || ctx.role === "admin" || ctx.role === "editor";

  const business = await getClient();

  const [cats, topics, facts] = await Promise.all([
    business
      ? database
          .select()
          .from(socialCategories)
          .where(eq(socialCategories.businessId, business.id))
          .orderBy(asc(socialCategories.position))
      : Promise.resolve([]),
    business
      ? database
          .select()
          .from(socialTopics)
          .where(eq(socialTopics.workspaceId, ctx.workspaceId))
          .orderBy(asc(socialTopics.createdAt))
      : Promise.resolve([]),
    business ? repo.listFacts(database, ctx, business.id) : Promise.resolve([]),
  ]);

  const sp = business?.prompts?.social;
  const hasServices = facts.some((fact) => fact.key === "service");

  /*
   * Which month to plan, and whether it already is.
   *
   * From the 24th this is next month: planning starts in the last week so
   * there is time to review and write before the 1st.
   */
  const now = new Date();
  const planKey = monthToPlan(now);
  const monthStart = new Date(`${planKey}-01T00:00:00Z`);
  const daysUntil = Math.ceil((monthStart.getTime() - now.getTime()) / 86_400_000);

  const planned = business
    ? await database
        .select({ id: socialMonths.id })
        .from(socialMonths)
        .where(and(
          eq(socialMonths.businessId, business.id),
          eq(socialMonths.monthKey, planKey),
        ))
        .limit(1)
    : [];

  const byCategory = new Map<string, typeof topics>();
  for (const t of topics) {
    const list = byCategory.get(t.categoryId) ?? [];
    list.push(t);
    byCategory.set(t.categoryId, list);
  }

  const categories: PoolCategory[] = cats.map((c) => ({
    id: c.id,
    name: c.name,
    description: c.description,
    targetCount: c.targetCount,
    topics: (byCategory.get(c.id) ?? []).map((t) => ({
      id: t.id,
      title: t.title,
      hook: t.hook,
      audience: t.audience,
      format: t.format,
      imageIdea: t.imageIdea,
      status: t.status,
      dateLabel: dateLabel(t.postDate, t.occasion),
      dateRule: t.dateRule,
      recommended: t.recommended,
      recommendedWhy: t.recommendedWhy,
    })),
  }));

  /*
   * Why generation cannot run, if it cannot.
   *
   * One specific sentence naming the thing to go and fix, rather than a
   * disabled button a person has to guess at.
   */
  const blockedReason = !business
    ? "Add your website and run a crawl first. Topics are built from your business profile."
    : !business.confirmedAt
      ? "Confirm your business profile first. Topics are only as good as the facts behind them."
      : cats.length === 0
        ? "No categories are set up for this business yet."
        : null;

  const emptyState = !business
    ? {
        title: "Connect your business before building the topic pool",
        description: "Add a website or business details so every category is grounded in what you actually offer.",
        canCreate: false,
        actionHref: "/settings/business",
        actionLabel: "Add business details",
      }
    : !business.confirmedAt
      ? {
          title: "Confirm your business profile first",
          description: "Review the extracted facts before using them to shape your social content categories.",
          canCreate: false,
          actionHref: "/business",
          actionLabel: "Review business profile",
        }
      : !hasServices
        ? {
            title: "Add at least one service to continue",
            description: "Categories are created from your confirmed services, so the topic pool stays relevant to the business.",
            canCreate: false,
            actionHref: "/settings#services",
            actionLabel: "Add services",
          }
        : {
            title: "Set up your content categories",
            description: "Turn your confirmed services into reusable categories, then generate focused topic ideas for each one.",
            canCreate: canEdit,
            actionHref: "/settings#services",
            actionLabel: canEdit ? "Review services" : "View services",
          };

  return (
    <>
      <TopBar section="Automation" page="Social" initials={initials} />
      <div className="content social-page">
        <SocialHero />
        <SocialSteps current={1} monthKey={planKey} />

        {business && cats.length > 0 ? (
          <PlanMonthBanner
            businessId={business.id}
            monthKey={planKey}
            monthName={monthLabel(planKey)}
            daysUntil={daysUntil}
            daysLeft={daysLeftInMonth(planKey, now)}
            alreadyPlanned={planned.length > 0}
            /*
             * The month's id, so the banner can unschedule it.
             *
             * The page already queried this row and threw the id away, keeping
             * only a boolean. That left the unschedule route unreachable, and
             * because rejecting a scheduled topic tells you to "remove it from
             * the calendar first", a bad topic in a committed month could not
             * be rejected at all.
             */
            plannedMonthId={planned[0]?.id ?? null}
            canEdit={canEdit}
          />
        ) : null}

        <div className="sectionhead social-sectionhead">
          <div><h2>Topic Pool <span className="topic-total">{topics.filter((t) => t.status !== "rejected").length} topics</span></h2>
          <span className="note">Generate a category, read the content, and add it to your calendar.</span></div>
        </div>

        <SocialTopicPool
          categories={categories}
          canEdit={canEdit}
          blockedReason={blockedReason}
          emptyState={emptyState}
          businessId={business?.id ?? null}
          monthKey={planKey}
          prompts={{
            topics: sp?.topics ?? "",
            post: sp?.post ?? "",
            image: sp?.image ?? "",
            reference: sp?.reference ?? "",
            wordsToAvoid: sp?.wordsToAvoid ?? [],
          }}
        />
      </div>
    </>
  );
}
