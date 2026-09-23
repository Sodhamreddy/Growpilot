import Link from "next/link";
import { eq, and } from "drizzle-orm";
import { requireTenant } from "@/lib/auth";
import { db } from "@/lib/services";
import { repo, integrations, workspaces } from "@ob/db";
import {
  IconArticles, IconSpark, IconCheck, IconInbox, IconEdit,
} from "@/components/Icons";
import { BlogHeaderActions } from "@/components/BlogHeaderActions";
import { tone } from "@/components/ScoreGauge";
import { TopBar } from "@/components/TopBar";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, "ok" | "warn" | "fail" | "neutral"> = {
  published: "ok", approved: "ok",
  awaiting_approval: "warn", needs_changes: "warn",
  failed: "fail",
  draft: "neutral", generating: "neutral", qa: "neutral", scheduled: "neutral",
};

const FILTERS: { label: string; status?: string }[] = [
  { label: "All" },
  { label: "Awaiting approval", status: "awaiting_approval" },
  { label: "Needs changes", status: "needs_changes" },
  { label: "Approved", status: "approved" },
  { label: "Published", status: "published" },
  { label: "Failed", status: "failed" },
];

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
  const [business, cmsRows] = await Promise.all([
    repo.getPrimaryBusiness(database, ctx),
    database
      .select({ provider: integrations.provider, status: integrations.status })
      .from(integrations)
      .where(and(
        eq(integrations.workspaceId, ctx.workspaceId),
        eq(integrations.provider, "wordpress"),
      ))
      .limit(1),
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
  const cms = business ? cmsRows[0] : undefined;

  const serviceCount = facts.filter((f) => f.key === "service").length;

  /*
   * Why topic suggestion cannot run, if it cannot.
   *
   * Stated as one specific sentence rather than a disabled button: a customer
   * looking at a dead control needs to know which thing to go and fix.
   */
  const blockedReason = !business
    ? "Add your website and run a crawl first — topics are built from your business profile."
    : !business.confirmedAt
      ? "Confirm your business profile first. Suggestions are only as good as the facts behind them."
      : serviceCount === 0
        ? "Add at least one service in Settings → Business info. Topics are built from what you sell."
        : null;

  /*
   * The four stages, with the live count in each.
   *
   * Each one also filters the list below it. They already corresponded to a
   * filter chip, so leaving them inert made a person read the count and then
   * go hunting for the matching chip — the icon and the link close that gap.
   * WordPress has no single status of its own, so it does not link.
   */
  const stages = [
    {
      n: "01", label: "Topics generated", icon: <IconSpark size={17} />, tone: "idea",
      count: everything.filter((a) => a.status === "draft").length,
      note: "Suggested, not yet written", filter: null,
    },
    {
      n: "02", label: "In writing", icon: <IconEdit size={17} />, tone: "writing",
      count: everything.filter((a) => a.status === "generating" || a.status === "qa").length,
      note: "Being written and checked", filter: null,
    },
    {
      n: "03", label: "Awaiting approval", icon: <IconInbox size={17} />, tone: "review",
      count: everything.filter((a) => a.status === "awaiting_approval").length,
      note: "Needs your review", filter: "awaiting_approval",
    },
    {
      n: "04", label: "Published", icon: <IconCheck size={17} />, tone: "live",
      count: everything.filter((a) => a.status === "published").length,
      note: cms?.status === "connected" ? "Live on WordPress" : "WordPress not connected",
      filter: "published",
    },
  ];

  return (
    <>
      <TopBar section="Automation" page="Blog" initials={initials} />
      <div className="content blog-page">
      {/* ── Hero ── */}
      <section className="toolhero blog">
        <div className="toolhero-copy">
          <span className="toolhero-eyebrow">BLOG AUTOMATION</span>
          <h1>
            Create high-impact blogs, <span className="toolhero-accent">automatically</span>
          </h1>
          <p>
            SEO articles built from your services and locations, written in your brand voice.
            Review, approve, and publish to WordPress in one place.
          </p>

          <BlogHeaderActions
            businessId={business?.id ?? null}
            canEdit={canEdit}
            blockedReason={blockedReason}
            prompts={{
              topics: blogPrompts?.topics ?? "",
              article: blogPrompts?.article ?? "",
              reference: blogPrompts?.reference ?? "",
            }}
          />
        </div>

        {/*
          * The pipeline, as words.
          *
          * The reference draws this as an illustration. Four labels say the
          * same thing, stay legible at any width, and do not need an asset
          * kept in step with what the pipeline actually does.
          */}
        <aside className="toolhero-flow" aria-hidden>
          <span>Ideas</span>
          <span>Content</span>
          <span>Approval</span>
          <span>Published</span>
        </aside>
      </section>

      <div className="stagegrid">
        {stages.map((s) => {
          const inner = (
            <>
              <span className={`stagecard-ico ${s.tone}`} aria-hidden>{s.icon}</span>
              <span className="stagecard-value">{s.count}</span>
              <span className="stagecard-label">{s.label}</span>
              <span className="stagecard-note">{s.note}</span>
            </>
          );
          return s.filter ? (
            <Link className={`stagecard ${s.tone}`} key={s.n} href={`/articles?status=${s.filter}`}>
              {inner}
            </Link>
          ) : (
            <div className={`stagecard ${s.tone}`} key={s.n}>{inner}</div>
          );
        })}
      </div>

      {/*
        * No "Start here" block.
        *
        * Both of its cards are now buttons in the page header, and their
        * output renders there. A heading over nothing is worse than no
        * heading.
        */}
      <div className="sectionhead">
        <h2>Articles</h2>
        <span className="note">Everything in this workspace, newest first</span>
      </div>

      <div className="toolbar">
        <div className="filters">
          {/*
            * Counts on the chips.
            *
            * A filter that leads to an empty list is a wasted click, and the
            * number is the only way to know before taking it. Counted across
            * every article rather than the filtered set, which would always
            * read as the number already on screen.
            */}
          {FILTERS.map((f) => {
            const n = f.status
              ? everything.filter((a) => a.status === f.status).length
              : everything.length;
            return (
              <Link
                key={f.label}
                href={f.status ? `/articles?status=${f.status}` : "/articles"}
                className="filterlink"
                aria-current={(params.status ?? "") === (f.status ?? "") ? "true" : undefined}
              >
                {f.label} <span className="filtercount">{n}</span>
              </Link>
            );
          })}
        </div>
        <div className="spacer" />
        <span className="small muted">{rows.length} shown</span>
      </div>

      <div className="card">
        {rows.length === 0 ? (
          <div className="empty">
            <span className="empty-ico"><IconArticles size={22} /></span>
            <strong>{params.status ? "Nothing in this state" : "No articles yet"}</strong>
            <span>
              {params.status
                ? "Try another filter, or clear it to see everything."
                : "Generate topics above and pick one to write."}
            </span>
          </div>
        ) : (
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Title</th>
                  <th style={{ width: 130 }}>Status</th>
                  <th style={{ width: 130 }}>SEO score</th>
                  <th style={{ width: 70 }} className="num">Voice</th>
                  <th style={{ width: 70 }} className="num">Words</th>
                  <th style={{ width: 120 }}>Updated</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <Link href={`/articles/${a.id}`}><strong>{a.title}</strong></Link>
                      <div className="mono muted" style={{ fontSize: 11 }}>/{a.slug} · v{a.version}</div>
                    </td>
                    <td>
                      <span className={`badge ${STATUS_TONE[a.status] ?? "neutral"}`}>
                        {a.status.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td>
                      {a.seoScore === null ? (
                        <span className="muted small">not scored</span>
                      ) : (
                        <div className="conf">
                          <div className="track" style={{ width: 54 }}>
                            <i className={tone(a.seoScore) === "ok" ? "hi" : tone(a.seoScore) === "warn" ? "mid" : "lo"}
                               style={{ width: `${a.seoScore}%` }} />
                          </div>
                          <span>{a.seoScore.toFixed(0)}</span>
                        </div>
                      )}
                    </td>
                    <td className="num">{a.voiceScore === null ? "—" : a.voiceScore.toFixed(0)}</td>
                    <td className="num">{a.wordCount || "—"}</td>
                    <td className="muted small">{a.updatedAt.toISOString().slice(0, 16).replace("T", " ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      </div>
    </>
  );
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
