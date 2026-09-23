import type { JSX } from "react";
import Link from "next/link";
import { eq, and, gte, desc, sql } from "drizzle-orm";
import { requireTenant, getSession } from "@/lib/auth";
import { db } from "@/lib/services";
import {
  workspaces, businessSources, articles, aiJobs, auditLogs,
  socialTopics, socialCategories, repo,
} from "@ob/db";
import { TopBar } from "@/components/TopBar";
import {
  IconArticles, IconSocial, IconLocal, IconSpark, IconArrow, IconInbox,
  IconClock, IconCheck, IconIntegrations, IconAnalytics,
} from "@/components/Icons";
import { deriveNextAction } from "@/lib/onboarding";

/**
 * Overview.
 *
 * Three things, in the order somebody needs them: what to do next, the three
 * tools, and what has been happening. The tools carry their own colour so the
 * page reads as three products rather than one long list of statistics, which
 * is what it was.
 *
 * Every number here is real. Nothing is estimated and nothing is projected:
 * a dashboard that shows a plausible figure is worse than one that shows
 * nothing, because a person will act on it.
 */

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const ctx = await requireTenant();
  const database = db();
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const [[workspace], business] = await Promise.all([
    database.select().from(workspaces).where(eq(workspaces.id, ctx.workspaceId)).limit(1),
    repo.getPrimaryBusiness(database, ctx),
  ]);

  const [source] = business
    ? await database.select().from(businessSources)
        .where(eq(businessSources.businessId, business.id)).limit(1)
    : [];

  const [statusCounts, usage, recent, socialCounts] = await Promise.all([
    database
      .select({ status: articles.status, count: sql<string>`count(*)` })
      .from(articles)
      .where(and(
        eq(articles.workspaceId, ctx.workspaceId),
        business ? eq(articles.businessId, business.id) : sql`false`,
      ))
      .groupBy(articles.status),
    database
      .select({
        costMicros: sql<string>`coalesce(sum(${aiJobs.costMicros}), 0)`,
        calls: sql<string>`count(*)`,
      })
      .from(aiJobs)
      .where(and(eq(aiJobs.workspaceId, ctx.workspaceId), gte(aiJobs.startedAt, monthStart))),
    database
      .select({
        action: auditLogs.action, entityType: auditLogs.entityType,
        createdAt: auditLogs.createdAt, actorType: auditLogs.actorType,
      })
      .from(auditLogs)
      .where(eq(auditLogs.workspaceId, ctx.workspaceId))
      .orderBy(desc(auditLogs.createdAt))
      .limit(6),
    database
      .select({ status: socialTopics.status, count: sql<string>`count(*)` })
      .from(socialTopics)
      .innerJoin(socialCategories, eq(socialCategories.id, socialTopics.categoryId))
      .where(and(
        eq(socialTopics.workspaceId, ctx.workspaceId),
        business ? eq(socialCategories.businessId, business.id) : sql`false`,
      ))
      .groupBy(socialTopics.status),
  ]);

  const byStatus = Object.fromEntries(statusCounts.map((r) => [r.status, Number(r.count)]));
  const bySocial = Object.fromEntries(socialCounts.map((r) => [r.status, Number(r.count)]));
  const totalArticles = Object.values(byStatus).reduce((a, b) => a + b, 0);
  const socialPool = Object.entries(bySocial)
    .filter(([s]) => s !== "rejected")
    .reduce((a, [, n]) => a + n, 0);

  const spentUsd = Number(usage[0]?.costMicros ?? 0) / 1_000_000;
  const budgetUsd = (workspace?.aiBudgetMicros ?? 0) / 1_000_000;
  const budgetPct = budgetUsd > 0 ? Math.min(100, (spentUsd / budgetUsd) * 100) : 0;

  const isSeeded = business?.name === "Northside Dental";

  const next = deriveNextAction({
    hasBusiness: Boolean(business),
    crawlStatus: source?.crawlStatus ?? null,
    confirmed: Boolean(business?.confirmedAt),
    awaitingApproval: byStatus["awaiting_approval"] ?? 0,
    totalArticles,
  });

  const session = await getSession();
  const initials =
    (session?.name ?? session?.email ?? "?").split(/[\s@.]+/).filter(Boolean)
      .slice(0, 2).map((p) => p[0]!.toUpperCase()).join("") || "?";
  const firstName = (session?.name ?? session?.email ?? "").split(/[\s@]/)[0] ?? "";

  return (
    <>
      <TopBar section="Workspace" page="Overview" initials={initials} sampleData={isSeeded} />

      <div className="content">
        {/* ── Banner ── */}
        <section className="banner">
          <div className="banner-copy">
            <span className="banner-hi">
              WELCOME BACK{firstName ? `, ${firstName.toUpperCase()}` : ""} <span aria-hidden>👋</span>
            </span>
            <h1>
              Automate. Grow. <span className="banner-accent">Care.</span>
            </h1>
            <p>Create content, engage your community, and build trust, all on autopilot.</p>
            <Link className="btn primary" href={next.href}>
              {next.label} <IconArrow />
            </Link>
          </div>

          {/*
            * Three promises, as a card rather than an illustration.
            *
            * The reference has a plant graphic here. On a dashboard somebody
            * opens daily, saying what the product is for earns the space more
            * than a drawing does, and it costs no asset to maintain.
            */}
          <aside className="banner-aside" aria-hidden>
            <span>More visibility</span>
            <span>More trust</span>
            <span>More patients</span>
          </aside>
        </section>

        {/* ── The three tools ── */}
        <div className="toolgrid">
          <ToolCard
            tone="blog"
            icon={<IconArticles size={20} />}
            name="Blog Automation"
            blurb="Turn your services into SEO articles, checked and approved before they publish."
            points={["Topic ideas from your services", "Full drafts in your voice", "Publish to WordPress"]}
            stat={totalArticles > 0 ? `${totalArticles} article${totalArticles === 1 ? "" : "s"}` : null}
            href="/articles"
            cta={totalArticles > 0 ? "Open" : "Start creating"}
          />
          <ToolCard
            tone="social"
            icon={<IconSocial size={20} />}
            name="Social Media Timeline"
            blurb="A pool of topics by category, laid out into a month you can review."
            points={["Topics per category", "Calendar from the pool", "Captions and image briefs"]}
            stat={socialPool > 0 ? `${socialPool} topic${socialPool === 1 ? "" : "s"}` : null}
            href="/social"
            cta={socialPool > 0 ? "Open" : "Build the pool"}
          />
          <ToolCard
            tone="gmb"
            icon={<IconLocal size={20} />}
            name="GMB Reviews"
            blurb="Watch for new Google reviews and draft a reply in your voice."
            points={["New review alerts", "Suggested replies", "Sentiment over time"]}
            stat={null}
            href="/reviews"
            cta="Set up"
          />
        </div>

        {/*
          * Where this workspace stands, in one line.
          *
          * The reference has a green "You're all set" strip. That is only
          * worth showing when it is true, so this states the actual next
          * step when there is one and celebrates only when there is not.
          */}
        <div className={`readystrip${next.title.startsWith("Everything") ? " ok" : ""}`}>
          <span className="readystrip-ico" aria-hidden>
            {next.title.startsWith("Everything") ? <IconCheck size={16} /> : <IconSpark size={16} />}
          </span>
          <div>
            <strong>{next.title}</strong>
            <span>{next.description}</span>
          </div>
          <Link className="btn small" href={next.href}>{next.label}</Link>
        </div>

        {/* ── What needs a person ── */}
        <div className="sectionhead">
          <h2>Needs you</h2>
          <span className="note">Nothing publishes without a decision</span>
        </div>
        <div className="statgrid">
          <Stat label="Awaiting approval" value={byStatus["awaiting_approval"] ?? 0}
                sub="Ready for a decision" tone="warn"
                href="/articles?status=awaiting_approval" icon={<IconClock size={16} />} />
          <Stat label="Needs changes" value={byStatus["needs_changes"] ?? 0}
                sub="Failed a quality gate" tone="warn"
                href="/articles?status=needs_changes" icon={<IconInbox size={16} />} />
          <Stat label="Published" value={byStatus["published"] ?? 0}
                sub="Live content" tone="ok"
                href="/articles?status=published" icon={<IconCheck size={16} />} />
          <Stat label="AI spend" value={`$${spentUsd.toFixed(2)}`}
                sub={budgetUsd > 0 ? `${budgetPct.toFixed(0)}% of budget` : "No ceiling set"}
                tone={budgetPct > 90 ? "fail" : budgetPct > 70 ? "warn" : "ok"}
                href="/preferences" icon={<IconAnalytics size={16} />} />
        </div>

        {/* ── What has been happening ── */}
        <div className="sectionhead">
          <h2>Recent activity</h2>
          <span className="note">Every crawl, approval and publish</span>
        </div>
        <div className="card">
          {recent.length === 0 ? (
            <div className="empty">
              <span className="empty-ico"><IconInbox /></span>
              <strong>Nothing yet</strong>
              <span>Everything the pipeline does is recorded here as it happens.</span>
            </div>
          ) : (
            <ul className="feed">
              {recent.map((r, i) => (
                <li key={i}>
                  <span className={`dot ${r.actorType === "system" ? "sys" : ""}`} />
                  <span className="what">{humanizeAction(r.action)}</span>
                  <span className="ent">{r.entityType.replace(/_/g, " ")}</span>
                  <span className="spacer" />
                  <time>{r.createdAt.toISOString().replace("T", " ").slice(0, 16)}</time>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}

// ─── Pieces ─────────────────────────────────────────────────────────────────

/**
 * One of the three products.
 *
 * Carries a real count when there is one and nothing when there is not. The
 * alternative, a zero, reads as a broken feature rather than an unstarted one.
 */
function ToolCard({
  tone, icon, name, blurb, points, stat, href, cta,
}: {
  tone: "blog" | "social" | "gmb";
  icon: JSX.Element;
  name: string;
  blurb: string;
  points: string[];
  stat: string | null;
  href: string;
  cta: string;
}) {
  return (
    <article className={`toolcard ${tone}`}>
      <div className="toolcard-head">
        <span className="toolcard-ico">{icon}</span>
        {stat ? <span className="toolcard-stat">{stat}</span> : null}
      </div>

      <h3>{name}</h3>
      <p>{blurb}</p>

      <ul className="toolcard-points">
        {points.map((p) => (
          <li key={p}><span className="tick" aria-hidden>✓</span>{p}</li>
        ))}
      </ul>

      <Link className="toolcard-cta" href={href}>
        {cta} <IconArrow size={14} />
      </Link>
    </article>
  );
}

function Stat({
  label, value, sub, tone, href, icon,
}: {
  label: string;
  value: number | string;
  sub: string;
  tone: "ok" | "warn" | "fail";
  href: string;
  icon: JSX.Element;
}) {
  // A zero on an attention tile is the good outcome, so it stays quiet.
  const active = typeof value === "number" ? value > 0 : true;
  return (
    <Link className="statcard" href={href}>
      <span className={`statcard-ico ${active ? tone : ""}`}>{icon}</span>
      <span className="statcard-label">{label}</span>
      <span className="statcard-value">{value}</span>
      <span className="statcard-sub">{sub}</span>
    </Link>
  );
}

/** "topic.accepted" → "Topic accepted". */
function humanizeAction(action: string): string {
  const s = action.replace(/[._]/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}
