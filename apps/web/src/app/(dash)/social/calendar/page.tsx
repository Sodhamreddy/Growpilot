import Link from "next/link";
import { and, asc, eq, gte, lt, ne } from "drizzle-orm";
import { getClient } from "@/lib/tenant";
import { requireTenant, getSession } from "@/lib/auth";
import { db } from "@/lib/services";
import { socialCategories, socialTopics, socialMonths } from "@ob/db";
import { monthToPlan, monthLabel } from "@ob/social";
import { TopBar } from "@/components/TopBar";
import { SocialHero } from "@/components/SocialHero";
import { SocialSteps } from "@/components/SocialSteps";
import { SocialCalendar, type CalendarPost } from "@/components/SocialCalendar";
import { isMonthKey, isMonthLong, mergeOccasions } from "@/lib/social-calendar";

/**
 * Social Media Timeline — the calendar.
 *
 * The same month the planner builds, laid out as a wall calendar: what is
 * scheduled, on which day, for whom. It opens on whichever month is next up
 * for planning, because that is the month someone coming here is working on.
 */

export const dynamic = "force-dynamic";

/** Statuses a topic reaches once a month has claimed it. */
const ON_CALENDAR = new Set(["scheduled", "written", "approved", "published"]);

export default async function SocialCalendarPage({
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
  const [y, m] = monthKey.split("-").map(Number);
  const start = new Date(Date.UTC(y!, m! - 1, 1));
  const end = new Date(Date.UTC(y!, m!, 1));

  const database = db();
  const business = await getClient();

  const [rows, audienceRows, monthRows] = await Promise.all([
    /*
     * Every dated topic in the month, not only the scheduled ones.
     *
     * An idea in the pool dated to an observance is how the planner records
     * that the observance exists. Its name belongs on the day even when the
     * post was not picked, so it is read here and only the claimed ones become
     * cards.
     */
    business
      ? database
          .select({
            id: socialTopics.id,
            title: socialTopics.title,
            hook: socialTopics.hook,
            audience: socialTopics.audience,
            format: socialTopics.format,
            imageIdea: socialTopics.imageIdea,
            occasion: socialTopics.occasion,
            dateRule: socialTopics.dateRule,
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
            ne(socialTopics.status, "rejected"),
            gte(socialTopics.postDate, start),
            lt(socialTopics.postDate, end),
          ))
          .orderBy(asc(socialTopics.postDate), asc(socialTopics.createdAt))
      : Promise.resolve([]),
    business
      ? database
          .selectDistinct({ audience: socialTopics.audience })
          .from(socialTopics)
          .innerJoin(socialCategories, eq(socialCategories.id, socialTopics.categoryId))
          .where(and(
            eq(socialTopics.workspaceId, ctx.workspaceId),
            eq(socialCategories.businessId, business.id),
          ))
      : Promise.resolve([]),
    business
      ? database
          .select({
            calendarEvents: socialMonths.calendarEvents,
            monthLongObservances: socialMonths.monthLongObservances,
          })
          .from(socialMonths)
          .where(and(
            eq(socialMonths.workspaceId, ctx.workspaceId),
            eq(socialMonths.businessId, business.id),
            eq(socialMonths.monthKey, monthKey),
          ))
          .limit(1)
      : Promise.resolve([]),
  ]);

  const month = monthRows[0] ?? null;

  const posts: CalendarPost[] = rows
    .filter((r) => r.postDate && ON_CALENDAR.has(r.status))
    .map((r) => ({
      id: r.id,
      day: r.postDate!.getUTCDate(),
      title: r.title,
      hook: r.hook,
      audience: r.audience,
      format: r.format,
      imageIdea: r.imageIdea,
      occasion: r.occasion,
      dateRule: r.dateRule,
      status: r.status,
      categoryName: r.categoryName,
      caption: r.pack?.caption || null,
      hashtags: r.pack?.hashtags ?? [],
    }));

  /*
   * Observance labels stay on the observance's own day.
   *
   * Posts can be dragged, so a scheduled post's date is wherever a person put
   * it, and a label read from it would follow it onto the wrong day. The month
   * row holds each observance at the day the planner anchored it to, so that
   * wins; a post only supplies a label the month row does not already have.
   * Month-long observances belong to no one day and go in the "All month"
   * strip instead.
   */
  const monthLongNames = rows
    .filter((r) => isMonthLong(r.occasion, r.dateRule))
    .map((r) => r.occasion!);
  const isWholeMonth = new Set(monthLongNames.map((n) => n.toLowerCase()));
  const saved = new Set(
    Object.values(month?.calendarEvents ?? {}).flatMap((v) => mergeOccasions(v)).map((n) => n.toLowerCase()),
  );
  const topicOccasions = new Map<number, string[]>();
  for (const r of rows) {
    if (!r.postDate || !r.occasion) continue;
    if (ON_CALENDAR.has(r.status) && saved.has(r.occasion.toLowerCase())) continue;
    const day = r.postDate.getUTCDate();
    topicOccasions.set(day, [...(topicOccasions.get(day) ?? []), r.occasion]);
  }
  const occasions: Record<number, string[]> = {};
  const lastDay = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  for (let day = 1; day <= lastDay; day++) {
    const names = mergeOccasions(month?.calendarEvents[String(day)], ...(topicOccasions.get(day) ?? []))
      .filter((n) => !isWholeMonth.has(n.toLowerCase()));
    if (names.length) occasions[day] = names;
  }
  const monthLong = mergeOccasions(...(month?.monthLongObservances ?? []), ...monthLongNames);

  const monthName = monthLabel(monthKey).split(" ")[0];
  const emptyNote = !business
    ? <>Add your business first. The calendar fills from the topic pool, and the pool is built from your business profile. <Link href="/settings/business">Add business details</Link></>
    : posts.length > 0
      ? null
      : monthKey < currentMonthKey
        ? <>Nothing was scheduled for {monthName}.</>
        : <>Nothing is scheduled for {monthName} yet. Build the month from the topic pool and its posts appear here. <Link href="/social">Go to the Topic Pool</Link></>;

  return (
    <>
      <TopBar section="Automation" page="Social Calendar" initials={initials} />
      <div className="content social-page">
        <SocialHero />
        <SocialSteps current={2} monthKey={monthKey} />
        <SocialCalendar
          monthKey={monthKey}
          currentMonthKey={currentMonthKey}
          todayIso={now.toISOString().slice(0, 10)}
          planned={Boolean(month)}
          posts={posts}
          occasions={occasions}
          monthLong={monthLong}
          audiences={audienceRows.map((r) => r.audience)}
          emptyNote={emptyNote}
          canEdit={ctx.role === "owner" || ctx.role === "admin" || ctx.role === "editor"}
        />
      </div>
    </>
  );
}
