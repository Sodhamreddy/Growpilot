import Link from "next/link";
import { and, asc, eq, gte, inArray } from "drizzle-orm";
import { getSession, requireTenant } from "@/lib/auth";
import { getClient } from "@/lib/tenant";
import { db } from "@/lib/services";
import { integrations, metricSnapshots } from "@ob/db";
import { TopBar } from "@/components/TopBar";
import { MetaTokenConnect } from "@/components/MetaTokenConnect";
import { MetaPagePicker } from "@/components/MetaPagePicker";
import { metaLoginBlocked } from "@/lib/meta-login";
import { SocialInsightsChart, type SocialChartPoint } from "@/components/SocialInsightsChart";
import { SocialDateFilter } from "@/components/SocialDateFilter";

export const dynamic = "force-dynamic";

const CHANNELS = [
  { id: "facebook", label: "Facebook", mark: "f" },
  { id: "instagram", label: "Instagram", mark: "◎" },
  { id: "linkedin", label: "LinkedIn", mark: "in" },
  { id: "x", label: "X", mark: "𝕏" },
] as const;
const METRICS = ["reach", "impressions", "engagement", "likes", "comments", "shares", "followers"];

type MetricRow = { source: string; metric: string; date: Date; value: number; dimensions: Record<string, string> };

const compact = (value: number) => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
const total = (rows: MetricRow[], metric: string) => rows.filter((row) => row.metric === metric).reduce((sum, row) => sum + row.value, 0);
const latest = (rows: MetricRow[], metric: string) => {
  const bySource = new Map<string, MetricRow>();
  for (const row of rows.filter((item) => item.metric === metric)) {
    const saved = bySource.get(row.source);
    if (!saved || row.date > saved.date) bySource.set(row.source, row);
  }
  return [...bySource.values()].reduce((sum, row) => sum + row.value, 0);
};
function change(current: number, previous: number): string {
  if (!previous) return current ? "New" : "—";
  const value = ((current - previous) / previous) * 100;
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function chartData(rows: MetricRow[], days: number, rangeStart: Date): SocialChartPoint[] {
  const start = new Date(rangeStart);
  start.setUTCHours(0, 0, 0, 0);
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + index);
    const key = date.toISOString().slice(0, 10);
    const forDate = rows.filter((row) => row.date.toISOString().slice(0, 10) === key);
    return { date: key, reach: total(forDate, "reach"), engagement: total(forDate, "engagement"), likes: total(forDate, "likes") };
  });
}

export default async function SocialInsightsPage({ searchParams }: { searchParams: Promise<{ channel?: string; days?: string; period?: string; from?: string; to?: string; meta?: string; meta_error?: string }> }) {
  const ctx = await requireTenant();
  const session = await getSession();
  const business = await getClient();
  const params = await searchParams;
  const presetDays = [30, 90, 180].includes(Number(params.days)) ? Number(params.days) : 30;
  const now = new Date();
  const period = ["this_month", "last_month", "custom"].includes(params.period ?? "") ? params.period! : `${presetDays}`;
  let rangeEnd = new Date(now);
  let rangeStart = new Date(now);
  if (period === "this_month") rangeStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  else if (period === "last_month") {
    rangeStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    rangeEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  } else if (period === "custom" && params.from && params.to) {
    rangeStart = new Date(`${params.from}T00:00:00.000Z`);
    rangeEnd = new Date(`${params.to}T23:59:59.999Z`);
  } else rangeStart = new Date(now.getTime() - presetDays * 86_400_000);
  const rangeMs = Math.max(86_400_000, rangeEnd.getTime() - rangeStart.getTime());
  const previousStart = new Date(rangeStart.getTime() - rangeMs);
  const chartDays = Math.min(180, Math.max(1, Math.ceil(rangeMs / 86_400_000)));
  const channel = CHANNELS.some((item) => item.id === params.channel) ? params.channel! : "all";
  const since = previousStart;
  const database = db();
  const providers = CHANNELS.map((item) => item.id);

  const [connectionRows, rawRows] = await Promise.all([
    database.select({ provider: integrations.provider, status: integrations.status, displayName: integrations.displayName })
      .from(integrations).where(and(eq(integrations.workspaceId, ctx.workspaceId), inArray(integrations.provider, providers))),
    database.select({ source: metricSnapshots.source, metric: metricSnapshots.metric, date: metricSnapshots.date,
      value: metricSnapshots.value, dimensions: metricSnapshots.dimensions })
      .from(metricSnapshots).where(and(eq(metricSnapshots.workspaceId, ctx.workspaceId),
        inArray(metricSnapshots.source, providers), inArray(metricSnapshots.metric, METRICS), gte(metricSnapshots.date, since)))
      .orderBy(asc(metricSnapshots.date)),
  ]);

  const scoped = rawRows.filter((row) => (channel === "all" || row.source === channel) &&
    (!business || !row.dimensions.businessId || row.dimensions.businessId === business.id));
  const current = scoped.filter((row) => row.date >= rangeStart && row.date <= rangeEnd);
  const previous = scoped.filter((row) => row.date >= previousStart && row.date < rangeStart);
  const connected = new Map(connectionRows.map((row) => [row.provider, row]));
  const loginBlocked = metaLoginBlocked();
  const initials = (session?.name ?? session?.email ?? "?").split(/[\s@.]+/).filter(Boolean)
    .slice(0, 2).map((part) => part[0]!.toUpperCase()).join("") || "?";
  const cards = [["reach", "Reach"], ["engagement", "Engagement"], ["likes", "Likes"],
    ["comments", "Comments"], ["shares", "Shares"]] as const;

  const postMap = new Map<string, { id: string; source: string; title: string; imageUrl?: string; url?: string; date: Date; values: Record<string, number> }>();
  for (const row of current) {
    const postId = row.dimensions.postId || row.dimensions.externalPostId;
    if (!postId) continue;
    const key = `${row.source}:${postId}`;
    const post = postMap.get(key) ?? { id: postId, source: row.source,
      title: row.dimensions.title || row.dimensions.caption || "Social post", imageUrl: row.dimensions.imageUrl,
      url: row.dimensions.url, date: row.date, values: {} };
    post.values[row.metric] = (post.values[row.metric] ?? 0) + row.value;
    if (row.date > post.date) post.date = row.date;
    postMap.set(key, post);
  }
  const posts = [...postMap.values()].sort((a, b) => b.date.getTime() - a.date.getTime());
  const reach = total(current, "reach");
  const engagement = total(current, "engagement");
  const dailyChart = chartData(current, chartDays, rangeStart);
  const followers = latest(current, "followers");
  const previousFollowers = latest(previous, "followers");
  const highestReach = posts.reduce<typeof posts[number] | undefined>((best, post) => !best || (post.values.reach ?? 0) > (best.values.reach ?? 0) ? post : best, undefined);
  const boostCandidate = posts.reduce<typeof posts[number] | undefined>((best, post) => !best || (post.values.engagement ?? 0) > (best.values.engagement ?? 0) ? post : best, undefined);
  const topPosts = [...posts].sort((a, b) => (b.values.reach ?? 0) - (a.values.reach ?? 0)).slice(0, 5);
  const queryFor = (extra: Record<string, string>) => new URLSearchParams({ ...(channel !== "all" ? { channel } : {}), ...extra }).toString();

  /*
   * What the connect flow said on its way back.
   *
   * The callback redirects with a short code rather than rendering its own
   * page, because the useful next step is always here. Each message says what
   * happened in terms a customer can act on: most of these are our
   * configuration or Meta's review process, not something they did wrong.
   */
  const META_MESSAGES: Record<string, string> = {
    cancelled: "Facebook sign-in was cancelled. Nothing was connected.",
    state_mismatch: "That connection attempt could not be verified. Please try again.",
    wrong_workspace: "That connection was started from a different workspace. Try again from this one.",
    no_code: "Facebook did not complete the connection. Please try again.",
    not_configured: "Facebook and Instagram are not set up on this server yet. A Meta app has to be registered and META_APP_ID / META_APP_SECRET added to the environment before any channel can be connected.",
    exchange_failed: "Facebook would not issue an access token. Please try again.",
    no_pages: "That Facebook account does not administer any Pages, so there are no insights to read.",
    graph_error: "Meta refused the request. If this app is still in App Review, insights are not available yet.",
    failed: "The connection did not complete. Please try again.",
  };
  const notice = params.meta_error
    ? { tone: "error", text: META_MESSAGES[params.meta_error] ?? META_MESSAGES.failed! }
    : params.meta === "connected"
      ? { tone: "ok", text: "Connected. The first sync runs shortly; numbers appear once it finishes." }
      : null;

  return <>
    <TopBar section="Analytics" page="Social Insights" initials={initials} />
    <div className="content social-insights-page">
      {notice ? (
        <div className={`finding ${notice.tone === "ok" ? "info" : "error"}`} style={{ marginBottom: 16 }} role="status">
          {notice.text}
        </div>
      ) : null}
      <section className="si-hero"><div><span className="social-eyebrow">Cross-channel analytics</span><h1>Social Media Insights</h1>
        <p>Track reach, engagement, audience growth, and post performance from every connected channel.</p></div>
        <div style={{ display: "grid", gap: 10, justifyItems: "end" }}>
          {loginBlocked
            ? <p className="metalogin-note">{loginBlocked}</p>
            : <a className="btn primary" href="/api/integrations/meta/start">Connect Facebook &amp; Instagram</a>}
          {/*
            * The fallback, under the button it falls back from.
            *
            * Meta refuses `localhost` as an App Domain, so the OAuth redirect
            * cannot complete against a local dev server. This is the same
            * credential obtained by hand.
            */}
          <MetaTokenConnect
            connected={connected.get("facebook")?.status === "connected"}
            pageNames={connected.get("facebook")?.displayName ?? null}
            defaultOpen={!!loginBlocked}
            offerToken={!!loginBlocked}
          />
          {/*
            * Which of the connection's pages is this client's.
            *
            * Only meaningful once connected, and only meaningful per client —
            * one Meta login reaches every page the agency administers.
            */}
          {connected.has("facebook") ? (
            <MetaPagePicker businessName={business?.name ?? null} />
          ) : null}
        </div></section>

      <section className="si-connections" aria-label="Social channel connections">{CHANNELS.map((item) => {
        const connection = connected.get(item.id);
        return <Link key={item.id} href={`/social-insights?channel=${item.id}&days=${presetDays}`} className={`si-channel ${channel === item.id ? "active" : ""}`}>
          <span className={`si-channel-mark ${item.id}`}>{item.mark}</span><span><strong>{item.label}</strong>
          <small>{connection?.status === "connected" ? connection.displayName || "Connected" : "Not connected"}</small></span>
          <i className={connection?.status === "connected" ? "connected" : ""}/></Link>;
      })}</section>

      <div className="si-toolbar"><nav aria-label="Channel filter"><Link className={channel === "all" ? "active" : ""} href={`/social-insights?days=${presetDays}`}>All</Link>
        {CHANNELS.map((item) => <Link key={item.id} className={channel === item.id ? "active" : ""} href={`/social-insights?channel=${item.id}&days=${presetDays}`}>{item.label}</Link>)}</nav>
        <nav className="si-date-presets" aria-label="Date range">
          <Link className={period === "this_month" ? "active" : ""} href={`/social-insights?${queryFor({ period: "this_month" })}`}>This month</Link>
          <Link className={period === "last_month" ? "active" : ""} href={`/social-insights?${queryFor({ period: "last_month" })}`}>Last month</Link>
          {[30, 90, 180].map((value) => <Link key={value} className={period === `${value}` ? "active" : ""} href={`/social-insights?${queryFor({ days: `${value}` })}`}>{value}d</Link>)}
          <SocialDateFilter active={period}/>
        </nav></div>

      {current.length ? <>
        <section className="si-metrics">{cards.map(([key, label]) => { const now = total(current, key); const before = total(previous, key); return <article key={key}><span>{label}</span><strong>{compact(now)}</strong><small className={now >= before ? "up" : "down"}>{change(now, before)} vs previous</small></article>; })}
          <article><span>Engagement rate</span><strong>{reach ? ((engagement / reach) * 100).toFixed(1) : "0.0"}%</strong><small>{compact(engagement)} interactions</small></article></section>
        <div className="si-performance-grid"><section className="si-chart-card"><div className="si-card-head"><div><h2>Performance trend</h2><p>Daily performance across selected channels</p></div><div className="si-chart-legend"><i className="reach"/>Reach<i className="engagement"/>Engagement<i className="likes"/>Likes</div></div>
          <SocialInsightsChart data={dailyChart}/></section>
          <section className="si-audience-card"><div className="si-card-head"><div><h2>Audience growth</h2><p>Latest followers across channels</p></div></div><strong>{compact(followers)}</strong><small>{change(followers, previousFollowers)} vs previous period</small>
            <div className="si-audience-bars">{[.42,.58,.73,1].map((height,index)=><span key={index} style={{height:`${height*100}%`}}><i>{["Jan","Feb","Mar","Apr"][index]}</i></span>)}</div></section>
        <section className="si-highlights">
          <article><span>Highest reach</span><strong>{highestReach ? compact(highestReach.values.reach ?? 0) : "—"}</strong><p>{highestReach?.title ?? "No post data in this period"}</p>{highestReach?.url ? <a href={highestReach.url} target="_blank" rel="noreferrer">View top post →</a> : null}</article>
          <article className="boost"><span>Boost candidate</span><strong>{boostCandidate ? compact(boostCandidate.values.engagement ?? 0) : "—"} interactions</strong><p>{boostCandidate?.title ?? "Connect post insights to get a recommendation"}</p>{boostCandidate?.url ? <a href={boostCandidate.url} target="_blank" rel="noreferrer">Open post to boost →</a> : null}</article>
          <article><span>Period comparison</span><strong>{change(engagement, total(previous, "engagement"))}</strong><p>Engagement compared with the immediately preceding period.</p></article>
        </section></div>
        <div className="si-content-grid">
        <section className="si-posts-gallery"><div className="si-gallery-head"><div><span className="si-gallery-icon">▥</span><div><h2>{channel === "all" ? "Social" : CHANNELS.find((item) => item.id === channel)?.label} content</h2><p>{posts.length} posts with synced performance</p></div></div><span className="si-sync-pill">● Performance sync active</span></div>
          {posts.length ? <div className="si-post-grid">{posts.map((post) => <article className="si-post-card" key={`${post.source}:${post.id}`}><div className={`si-post-media ${post.source}`}>{post.imageUrl ? <img src={post.imageUrl} alt=""/> : <div className="si-post-media-fallback"><b>{CHANNELS.find((item)=>item.id===post.source)?.mark ?? "↗"}</b><span>View original post</span></div>}<span className="si-post-network">{post.source}</span>{post.url ? <a href={post.url} target="_blank" rel="noreferrer" aria-label="Open original post">↗</a> : null}<time>{post.date.toLocaleDateString("en-US", { month:"short", day:"2-digit", year:"numeric" })}</time></div><div className="si-post-body"><h3>{post.title}</h3><div className="si-post-stats"><span><small>Reach</small><b>{compact(post.values.reach ?? 0)}</b></span><span><small>Engaged</small><b>{compact(post.values.engagement ?? 0)}</b></span></div><div className="si-post-actions"><span>♡ {compact(post.values.likes ?? 0)}</span><span>○ {compact(post.values.comments ?? 0)}</span><span>↗ {compact(post.values.shares ?? 0)}</span>{post.url ? <a href={post.url} target="_blank" rel="noreferrer">View post</a> : null}</div></div></article>)}</div> : <div className="si-inline-empty">Post media is syncing. Keep the worker running, then refresh this page.</div>}</section>
        <aside className="si-top-posts"><div className="si-card-head"><div><h2>Top performing posts</h2><p>Ranked by reach</p></div></div>{topPosts.map((post, index) => <a key={`${post.source}:${post.id}`} href={post.url || "#"} target={post.url ? "_blank" : undefined} rel="noreferrer"><b>{index + 1}</b>{post.imageUrl ? <img src={post.imageUrl} alt=""/> : <span className={`si-rank-placeholder ${post.source}`}>{CHANNELS.find((item)=>item.id===post.source)?.mark}</span>}<span><strong>{post.title}</strong><small>{post.date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</small></span><em>{compact(post.values.reach ?? 0)}</em></a>)}</aside></div>
        <section className="si-posts-card si-posts-table-legacy"><div className="si-card-head"><div><h2>Post performance</h2><p>{posts.length} posts with synced insights</p></div></div>
          {posts.length ? <div className="tablewrap"><table><thead><tr><th>Post</th><th>Channel</th><th>Reach</th><th>Engagement</th><th>Likes</th><th>Comments</th><th>Shares</th><th>Action</th></tr></thead><tbody>{posts.map((post) => <tr key={`${post.source}:${post.id}`}><td><div className="si-post-cell">{post.imageUrl ? <img src={post.imageUrl} alt=""/> : <span className={`si-post-placeholder ${post.source}`}>{CHANNELS.find((item)=>item.id===post.source)?.mark ?? "↗"}</span>}<span><strong>{post.title}</strong><small>{post.date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</small></span></div></td><td><span className="badge neutral">{post.source}</span></td><td>{compact(post.values.reach ?? 0)}</td><td>{compact(post.values.engagement ?? 0)}</td><td>{compact(post.values.likes ?? 0)}</td><td>{compact(post.values.comments ?? 0)}</td><td>{compact(post.values.shares ?? 0)}</td><td>{post.url ? <a className="btn small" href={post.url} target="_blank" rel="noreferrer">View</a> : "—"}</td></tr>)}</tbody></table></div>
          : <div className="si-inline-empty">Aggregate insights are available, but no post-level records have been synced yet.</div>}</section>
      </> : <section className="si-empty"><span className="si-empty-icon">↗</span><div><span className="social-eyebrow">Insights setup</span><h2>Connect a social channel to see real performance</h2>
        <p>Once Facebook, Instagram, LinkedIn, or X is connected, this page will show account growth and every synced post’s reach and engagement.</p></div>
        {loginBlocked ? null : <a className="btn primary" href="/api/integrations/meta/start">Connect Facebook &amp; Instagram</a>}</section>}
    </div>
  </>;
}
