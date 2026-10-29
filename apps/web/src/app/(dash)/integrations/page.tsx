import { measurementWindow } from "@ob/blog";
import { PublishRecovery } from "@/components/PublishRecovery";
import { getClient } from "@/lib/tenant";
import { MeasurementSettings } from "@/components/MeasurementSettings";
import Link from "next/link";
import { eq, desc, and, sql, gte, lte } from "drizzle-orm";
import { requireTenant, getSession } from "@/lib/auth";
import { db } from "@/lib/services";
import { integrations, publishJobs, metricSnapshots, articles } from "@ob/db";
import { TopBar } from "@/components/TopBar";
import {
  IconIntegrations, IconArticles, IconAnalytics, IconLocal, IconSocial,
} from "@/components/Icons";

/**
 * Integrations — spec §11.
 *
 * Shows the real connection state per provider from the `integrations` table.
 * OAuth flows need client credentials per provider, which are not configured,
 * so each card reports what it needs rather than offering a Connect button
 * that would fail.
 */

export const dynamic = "force-dynamic";

/*
 * What a person can actually do with each provider today.
 *
 * "available" means a connect flow exists and works. Everything else is
 * listed because the publish queue and credential storage already support it,
 * but there is no way to authorise it yet — and a card that only says what it
 * "needs" reads as an invitation to click something. Saying which is which,
 * on the card, is the difference between a roadmap and a dead end.
 */
const CATALOGUE = [
  { provider: "wordpress", name: "WordPress", group: "CMS publishing", icon: <IconArticles />,
    needs: "An application password for the target site. No OAuth client required.",
    spec: "§11", available: true, href: "/settings#wordpress" },
  { provider: "webflow", name: "Webflow", group: "CMS publishing", icon: <IconArticles />,
    needs: "A Webflow site API token.", spec: "§11" },
  { provider: "ghost", name: "Ghost", group: "CMS publishing", icon: <IconArticles />,
    needs: "An Admin API key for the Ghost instance.", spec: "§11" },
  { provider: "webhook", name: "Custom webhook", group: "CMS publishing", icon: <IconIntegrations />,
    needs: "A URL and shared secret. No OAuth required.", spec: "§11" },
  { provider: "google_search_console", name: "Search Console", group: "Measurement", icon: <IconAnalytics />,
    needs: "A service account with read access to this property.", spec: "§16", available: true, href: "#measurement" },
  { provider: "google_analytics", name: "Google Analytics 4", group: "Measurement", icon: <IconAnalytics />,
    needs: "A service account with read access to this property.", spec: "§16", available: true, href: "#measurement" },
  { provider: "google_business_profile", name: "Google Business Profile", group: "Local", icon: <IconLocal />,
    needs: "Google OAuth with business.manage scope.", spec: "§8", available: true, href: "/reviews" },
  { provider: "linkedin", name: "LinkedIn", group: "Social", icon: <IconSocial />,
    needs: "LinkedIn app credentials.", spec: "§9" },
  { provider: "facebook", name: "Facebook", group: "Social", icon: <IconSocial />,
    needs: "Meta app credentials.", spec: "§9", available: true, href: "/social" },
  { provider: "instagram", name: "Instagram", group: "Social", icon: <IconSocial />,
    needs: "A Meta app and an Instagram professional account.", spec: "§9", available: true, href: "/social" },
  { provider: "x", name: "X (Twitter)", group: "Social", icon: <IconSocial />,
    needs: "X developer app credentials with analytics access.", spec: "§9" },
];

const GROUPS = ["CMS publishing", "Measurement", "Local", "Social"];

export default async function IntegrationsPage() {
  const ctx = await requireTenant();
  const session = await getSession();
  const initials =
    (session?.name ?? session?.email ?? "?").split(/[\s@.]+/).filter(Boolean)
      .slice(0, 2).map((c) => c[0]!.toUpperCase()).join("") || "?";

  const business = await getClient();
  const database = db();
  const connected = await database
    .select()
    .from(integrations)
    .where(eq(integrations.workspaceId, ctx.workspaceId));

  const window = measurementWindow();
  const measurement = business ? await database.select({ metric: metricSnapshots.metric, value: sql<string>`sum(${metricSnapshots.value})` })
    .from(metricSnapshots).where(and(eq(metricSnapshots.workspaceId, ctx.workspaceId), sql`${metricSnapshots.dimensions}->>'businessId' = ${business.id}`,
      gte(metricSnapshots.date, window.start), lte(metricSnapshots.date, window.end), sql`${metricSnapshots.metric} not like 'search_query_%'`, sql`${metricSnapshots.source} in ('google_search_console', 'google_analytics')`)).groupBy(metricSnapshots.metric) : [];
  const recentPublishes = await database
    .select({
      id: publishJobs.id, title: articles.title, provider: publishJobs.provider, status: publishJobs.status,
      createdAt: publishJobs.createdAt, externalUrl: publishJobs.externalUrl,
      lastError: publishJobs.lastError,
    })
    .from(publishJobs)
    .innerJoin(articles, eq(articles.id, publishJobs.entityId))
    .where(and(eq(publishJobs.workspaceId, ctx.workspaceId), business ? eq(articles.businessId, business.id) : sql`false`))
    .orderBy(desc(publishJobs.createdAt))
    .limit(8);

  const byProvider = new Map(connected.filter(c => c.scopeKey === "workspace" ? c.provider !== "wordpress" : c.scopeKey === business?.id).map((c) => [c.provider, c]));

  return (
    <>
      <TopBar section="Configure" page="Integrations" initials={initials} />
      <div className="content">
        {business && (ctx.role === "admin" || ctx.role === "owner") ? <div id="measurement"><MeasurementSettings businessId={business.id} /></div> : null}
        {measurement.length ? <section className="card"><h2>Recent search and website performance</h2><p>Last 28 available days, ending three days ago. Daily updates may revise recent figures.</p><dl>{measurement.map(row => <div key={row.metric}><dt>{row.metric.replaceAll("_", " ")}</dt><dd>{Number(row.value).toLocaleString()}</dd></div>)}</dl></section> : null}
        <div className="pagehead">
          <h1>Integrations</h1>
          <p>
            Where approved content goes and where measurement comes from. Stored credentials are encrypted at rest and are never returned to the browser.
          </p>
        </div>

        <div className="specs" style={{ marginBottom: 22 }}>
          <div className="spec"><span className="k">Connected</span><span className="v">{connected.length}</span></div>
          <div className="spec"><span className="k">Available</span><span className="v">{CATALOGUE.length}</span></div>
          <div className="spec"><span className="k">Publish jobs</span><span className="v">{recentPublishes.length}</span></div>
        </div>

        {GROUPS.map((group) => (
          <div key={group} id={group === "Social" ? "social" : undefined}>
            <div className="sectionhead"><h2>{group}</h2></div>
            <div className="grid cols-3" style={{ marginBottom: 22 }}>
              {CATALOGUE.filter((c) => c.group === group).map((c) => {
                const live = byProvider.get(c.provider);
                return (
                  <div className="card" key={c.provider}>
                    <div className="row" style={{ marginBottom: 8 }}>
                      <span className="tile-ico">{c.icon}</span>
                      <strong style={{ fontSize: 14 }}>{c.name}</strong>
                      <div className="spacer" />
                      <span className={`badge ${live ? (live.status === "connected" ? "ok" : "fail") : c.available ? "warn" : "neutral"}`}>
                        {live?.status ?? (c.available ? "not connected" : "not available yet")}
                      </span>
                    </div>
                    {live ? (
                      <div className="small muted">
                        {live.displayName ?? live.externalAccountId ?? "Connected"}
                        {live.lastError ? (
                          <div className="error" style={{ marginTop: 5 }}>{live.lastError}</div>
                        ) : null}
                      </div>
                    ) : (
                      <div className="small muted">
                        Needs: {c.needs}
                        {/*
                          * A link only where one leads somewhere.
                          *
                          * WordPress connects with an application password and
                          * its form already exists on Settings — but this page
                          * showed it as "not connected" with no route to the
                          * one control that would change that. The rest have no
                          * flow at all, and say so rather than implying a click
                          * that goes nowhere.
                          */}
                        {c.available && c.href ? (
                          <div style={{ marginTop: 8 }}>
                            <Link className="btn small" href={c.href}>Connect {c.name}</Link>
                          </div>
                        ) : (
                          <div className="mono" style={{ marginTop: 5, fontSize: 11 }}>spec {c.spec}</div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}

        {recentPublishes.length > 0 ? (
          <>
            <div className="sectionhead">
              <h2>Publish activity</h2>
              <span className="note">Queued work, results and recovery</span>
            </div>
            <div className="card" style={{ marginBottom: 22 }}>
              <div className="tablewrap">
                <table>
                  <thead>
                    <tr><th>Provider</th><th>Status</th><th>Result</th><th>When</th></tr>
                  </thead>
                  <tbody>
                    {recentPublishes.map((p, i) => (
                      <tr key={i}>
                        <td><strong>{p.provider}</strong><div className="small muted">{p.title}</div></td>
                        <td>
                          <span className={`badge ${p.status === "succeeded" ? "ok" : p.status === "failed" ? "fail" : "neutral"}`}>
                            {p.status}
                          </span>
                        </td>
                        <td className="small muted">
                          {p.externalUrl ?? p.lastError ?? "—"}
                          {p.provider === "wordpress" && ["running", "failed", "succeeded"].includes(p.status) && (ctx.role === "admin" || ctx.role === "owner") ? <PublishRecovery id={p.id} status={p.status} /> : null}
                        </td>
                        <td className="muted small">{p.createdAt.toISOString().slice(0, 16).replace("T", " ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        ) : null}

        <div className="card">
          <h3>What can be connected today</h3>
          <p className="small muted" style={{ margin: 0, maxWidth: "70ch" }}>
            WordPress creates drafts for the selected client. Meta and Google Business Profile use
            their existing connection flows. Search Console and GA4 can be connected above using
            a service account with access to the selected client's property.
          </p>
          <p className="small muted" style={{ margin: "10px 0 0", maxWidth: "70ch" }}>
            <strong>Google Business Profile</strong> needs more than credentials. Its API requires
            Google to approve access to your project before any review can be read, which is an
            application with a review process rather than a setting. Reviews cannot be synced
            until that is granted.
          </p>
          <p className="small muted" style={{ margin: "10px 0 0", maxWidth: "70ch" }}>
            Only providers marked available have a connection flow. Other providers require an additional connector before credentials can be used.
          </p>
        </div>
      </div>
    </>
  );
}
