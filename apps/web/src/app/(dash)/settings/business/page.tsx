import { eq, and, desc } from "drizzle-orm";
import { requireTenant, getSession } from "@/lib/auth";
import { db } from "@/lib/services";
import { repo, businessLocations, businessSources, integrations, workspaces } from "@ob/db";
import { assessCompleteness } from "@ob/pipeline";
import { TopBar } from "@/components/TopBar";
import { IconBusiness, IconAlert } from "@/components/Icons";
import { ClientSetupPanel } from "@/components/ClientSetupPanel";
import {
  BrandSection, ServicesSection, LocationsSection, SocialSection, WordPressSection,
} from "@/components/BusinessInfoForms";

/**
 * Business info — everything onboarding may have skipped.
 *
 * Onboarding lets a customer skip steps, and the crawler cannot find some
 * things at all: a logo is rarely in the markup in usable form, the Google
 * Business Profile name lives on Google, and social handles are usually just an
 * icon row. So most workspaces arrive with real gaps, and nothing tells the
 * customer which ones matter.
 *
 * The check at the top is the point of this page. It leads with consequences
 * rather than a completion percentage: "no services, so no plan can be built"
 * is something a person can act on, where "72% complete" is not.
 */

export const dynamic = "force-dynamic";

export default async function BusinessSettingsPage() {
  const ctx = await requireTenant();
  const session = await getSession();
  const initials =
    (session?.name ?? session?.email ?? "?").split(/[\s@.]+/).filter(Boolean)
      .slice(0, 2).map((c) => c[0]!.toUpperCase()).join("") || "?";

  const database = db();
  const canEdit = ctx.role === "owner" || ctx.role === "admin" || ctx.role === "editor";
  const canManage = ctx.role === "owner" || ctx.role === "admin";

  const business = await repo.getPrimaryBusiness(database, ctx);

  const [facts, locations, sources, connections, workspaceRow] = await Promise.all([
    business ? repo.listFacts(database, ctx, business.id) : Promise.resolve([]),
    business
      ? database.select().from(businessLocations).where(and(
          eq(businessLocations.workspaceId, ctx.workspaceId),
          eq(businessLocations.businessId, business.id),
        ))
      : Promise.resolve([]),
    business
      ? database.select({
          id: businessSources.id,
          url: businessSources.canonicalUrl,
          status: businessSources.crawlStatus,
          pagesDiscovered: businessSources.pagesDiscovered,
          pagesFetched: businessSources.pagesFetched,
          lastCrawledAt: businessSources.lastCrawledAt,
          lastError: businessSources.lastError,
        }).from(businessSources).where(and(
          eq(businessSources.workspaceId, ctx.workspaceId),
          eq(businessSources.businessId, business.id),
        )).orderBy(desc(businessSources.createdAt)).limit(1)
      : Promise.resolve([]),
    database.select().from(integrations).where(eq(integrations.workspaceId, ctx.workspaceId)),
    database
      .select({ settings: workspaces.settings })
      .from(workspaces)
      .where(eq(workspaces.id, ctx.workspaceId))
      .limit(1),
  ]);

  const services = facts
    .filter((f) => f.key === "service")
    .map((f) => ({ id: f.id, value: f.value, verified: f.verified, sourceUrl: f.sourceUrl }));

  const connectedProviders = connections
    .filter((c) => c.status === "connected")
    .map((c) => c.provider);

  const report = assessCompleteness({
    business: business
      ? {
          name: business.name,
          industry: business.industry,
          audience: business.audience,
          description: business.description,
          usp: business.usp,
          websiteUrl: business.websiteUrl,
          logoUrl: business.logoUrl,
          gmbName: business.gmbName,
          socialProfiles: business.socialProfiles,
          confirmedAt: business.confirmedAt,
        }
      : null,
    serviceCount: services.length,
    locations,
    connectedProviders,
    goals: workspaceRow[0]?.settings.onboarding?.goals ?? [],
  });

  const wordpress = connections.find((c) => c.provider === "wordpress") ?? null;
  const sourceActive = sources[0]?.status === "pending" || sources[0]?.status === "running";

  return (
    <>
      <TopBar section="Settings" page="Business info" initials={initials} />
      <div className="content">
        <div className="pagehead">
          <h1>Business info</h1>
          <p>
            Everything the pipeline needs to know about {business?.name ?? "your business"}.
            Anything onboarding skipped, or the crawler could not find, is listed below.
          </p>
        </div>

        {!business ? (
          <div className="empty">
            <span className="empty-ico"><IconBusiness size={22} /></span>
            <strong>No business yet</strong>
            <span>Add your website and run a crawl to get started.</span>
          </div>
        ) : (
          <>
            <ClientSetupPanel
              businessId={business.id}
              businessName={business.name}
              websiteUrl={business.websiteUrl}
              confirmed={Boolean(business.confirmedAt)}
              initialSource={sources[0] ? {
                ...sources[0],
                lastCrawledAt: sources[0].lastCrawledAt?.toISOString() ?? null,
              } : null}
              canManage={canManage}
            />

            {!sourceActive ? <>
            {/* ── The check ── */}
            <div className="sectionhead">
              <h2>What is still missing</h2>
              <span className="note">
                {report.outstanding === 0
                  ? "Nothing outstanding"
                  : `${report.outstanding} item${report.outstanding === 1 ? "" : "s"} to fill in`}
              </span>
            </div>

            <div
              className="card"
              style={{
                marginBottom: 22,
                borderColor: report.blocking.length > 0 ? "var(--danger)" : undefined,
              }}
            >
              {report.blocking.length === 0 && report.recommended.length === 0 ? (
                <p className="small" style={{ margin: 0 }}>
                  Everything the pipeline needs is present. Anything left is optional.
                </p>
              ) : (
                <>
                  {report.blocking.map((item) => (
                    <div className="finding" key={item.id}>
                      <div>
                        <span className="badge warn" style={{ marginRight: 8 }}>blocks work</span>
                        <strong>{item.label}</strong>
                      </div>
                      <div className="suggestion">{item.consequence} → {item.action}</div>
                    </div>
                  ))}
                  {report.recommended.map((item) => (
                    <div className="finding" key={item.id} style={{ opacity: 0.85 }}>
                      <div>
                        <span className="badge neutral" style={{ marginRight: 8 }}>worth adding</span>
                        <strong>{item.label}</strong>
                      </div>
                      <div className="suggestion">{item.consequence} → {item.action}</div>
                    </div>
                  ))}
                </>
              )}
            </div>

            {report.blocking.length > 0 ? (
              <div className="card" style={{ marginBottom: 22, borderColor: "var(--warn)" }}>
                <div className="row" style={{ alignItems: "flex-start" }}>
                  <span className="tile-ico warn"><IconAlert /></span>
                  <div>
                    <strong style={{ fontSize: 14 }}>Generation is blocked</strong>
                    <p className="muted small" style={{ margin: "4px 0 0", maxWidth: "68ch" }}>
                      The items marked above are not preferences — the pipeline cannot run without
                      them. Filling them in is what unblocks keyword research and drafting.
                    </p>
                  </div>
                </div>
              </div>
            ) : null}
            </> : null}

            {/* ── Brand ── */}
            <div className="sectionhead">
              <h2>Brand</h2>
              <span className="note">Logo and how Google lists you</span>
            </div>
            <BrandSection
              businessId={business.id}
              canEdit={canEdit}
              initialLogoUrl={business.logoUrl}
              initialGmbName={business.gmbName}
            />

            {/* ── Services ── */}
            <div className="sectionhead">
              <h2>Services</h2>
              <span className="note">{services.length} listed · keyword research works from these</span>
            </div>
            <ServicesSection businessId={business.id} canEdit={canEdit} initial={services} />

            {/* ── Locations ── */}
            <div className="sectionhead">
              <h2>Locations</h2>
              <span className="note">{locations.length} listed · needed for local content</span>
            </div>
            <LocationsSection
              businessId={business.id}
              canEdit={canEdit}
              initial={locations.map((l) => ({
                id: l.id, label: l.label, streetAddress: l.streetAddress,
                locality: l.locality, region: l.region, postalCode: l.postalCode,
                country: l.country, phone: l.phone,
              }))}
            />

            {/* ── Social ── */}
            <div className="sectionhead">
              <h2>Social channels</h2>
              <span className="note">{business.socialProfiles.length} listed</span>
            </div>
            <SocialSection
              businessId={business.id}
              canEdit={canEdit}
              initial={business.socialProfiles}
            />

            {/* ── WordPress ── */}
            <div className="sectionhead">
              <h2>WordPress</h2>
              <span className="note">Where approved articles are published</span>
            </div>
            <WordPressSection
              canEdit={ctx.role === "owner" || ctx.role === "admin"}
              connected={wordpress ? { displayName: wordpress.displayName, status: wordpress.status } : null}
            />

            {/* ── Other integrations ── */}
            <div className="sectionhead">
              <h2>Other connections</h2>
              <span className="note">Manage them in Integrations</span>
            </div>
            <div className="card">
              {connections.length === 0 ? (
                <p className="small muted" style={{ margin: 0 }}>
                  Nothing connected yet. Google Business Profile and the social networks each need
                  OAuth credentials, which are set up in Integrations.
                </p>
              ) : (
                <div className="tablewrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Provider</th>
                        <th>Account</th>
                        <th style={{ width: 130 }}>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {connections.map((c) => (
                        <tr key={c.id}>
                          <td><strong>{c.provider}</strong></td>
                          <td className="muted small">{c.displayName ?? "—"}</td>
                          <td>
                            <span className={`badge ${c.status === "connected" ? "ok" : "warn"}`}>
                              {c.status}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}
