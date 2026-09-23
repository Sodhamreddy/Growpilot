import Link from "next/link";
import { eq, and } from "drizzle-orm";
import { getClient } from "@/lib/tenant";
import { requireTenant, getSession } from "@/lib/auth";
import { db } from "@/lib/services";
import { repo, businessLocations, integrations } from "@ob/db";
import { TopBar } from "@/components/TopBar";
import {
  IconLocal, IconVoiceNav, IconSettings, IconCheck, IconClock,
  IconInbox, IconAnalytics, IconArrow, IconIntegrations,
} from "@/components/Icons";

export const dynamic = "force-dynamic";

export default async function ReviewsPage() {
  const ctx = await requireTenant();
  const session = await getSession();
  const initials = (session?.name ?? session?.email ?? "?").split(/[\s@.]+/).filter(Boolean)
    .slice(0, 2).map((c) => c[0]!.toUpperCase()).join("") || "?";

  const database = db();
  const business = await getClient();
  const [locations, [gbp], voice] = await Promise.all([
    business ? database.select().from(businessLocations).where(and(
      eq(businessLocations.workspaceId, ctx.workspaceId),
      eq(businessLocations.businessId, business.id),
    )) : Promise.resolve([]),
    database.select({ status: integrations.status, displayName: integrations.displayName })
      .from(integrations).where(and(
        eq(integrations.workspaceId, ctx.workspaceId),
        eq(integrations.provider, "google_business_profile"),
      )).limit(1),
    business ? repo.getActiveVoice(database, ctx, business.id) : Promise.resolve(null),
  ]);

  const connected = gbp?.status === "connected";
  /*
   * This pillar has no backend yet.
   *
   * There is no reviews table, no /api/reviews, and the GMB worker directory
   * is empty — so nothing here can sync, draft or post. The page previously
   * counted a hardcoded `true` among its readiness steps, which let it show
   * "4 of 4 steps ready" for an automation that cannot run, and pointed four
   * Connect buttons at /integrations, which has no Google flow.
   *
   * Reaching it needs Google to approve Business Profile API access for this
   * project, which is an application rather than a setting. Until that and the
   * backend exist, the page says so instead of implying a click will help.
   */
  const AVAILABLE = false;
  const readySteps = [connected, Boolean(voice), false, connected].filter(Boolean).length;

  /*
   * A link to this client's own listing on Google.
   *
   * Syncing is not built, but the reviews themselves are public and the
   * listing is where they are actually answered today. Sending somebody to
   * their own profile is a real action on this page's subject; the hero
   * previously offered "Open Blog Automation", which is a different pillar
   * and an admission that there was nothing to do here.
   *
   * Built from the name and address already on file rather than a stored
   * URL, because no listing id is recorded yet. A search is honest about
   * being a search: it lands on the right business without pretending we know
   * its Google id.
   */
  const primaryLocation = locations[0];
  const listingQuery = [
    business?.gmbName ?? business?.name,
    primaryLocation?.streetAddress,
    primaryLocation?.locality,
    primaryLocation?.region,
  ].filter(Boolean).join(" ");
  const listingUrl = listingQuery
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(listingQuery)}`
    : null;

  return (
    <>
      <TopBar section="Automation" page="GMB Reviews" initials={initials} />
      <div className="content reviews-page">
        <section className="reviews-hero">
          <div>
            <span className="reviews-eyebrow">GMB reviews automation</span>
            <h1>Turn Reviews into Trust</h1>
            <p>Monitor new Google reviews, get AI-generated replies in your brand voice, and post once you approve.</p>
            <div className="reviews-hero-actions">
              <Link
                className="btn primary"
                href={AVAILABLE ? "/integrations" : (listingUrl ?? "/settings#business")}
                {...(AVAILABLE || !listingUrl ? {} : { target: "_blank", rel: "noreferrer" })}
              >
                <span aria-hidden>▶</span> {AVAILABLE
                  ? (connected ? "Start automation" : "Connect Google")
                  : listingUrl
                    ? `Open ${business?.name ?? "this client"} on Google`
                    : "Add an address first"}
              </Link>
              <Link className="btn" href="/settings/business"><IconSettings size={15} /> Setup guide</Link>
            </div>
          </div>
          <div className="reviews-hero-art" aria-hidden="true">
            <span className="reviews-note">Happy patients<br/>Stronger reputation<br/>More bookings!</span>
            <div className="google-review-card">
              <strong><span>G</span> ★★★★★</strong>
              <i /><i />
              <b>Auto reply</b>
            </div>
          </div>
        </section>

        {!AVAILABLE ? (
          <div className="finding warn" style={{ marginBottom: 18 }}>
            <div>
              <strong>Review syncing is not available yet.</strong> Everything below is the
              planned shape of this pillar, not live data.
            </div>
            <div className="suggestion">
              Google must approve Business Profile API access for this deployment before any
              review can be read. That is an application to Google with a review process, not a
              setting — so connecting an account here would not help yet.
            </div>
          </div>
        ) : null}

        <div className="review-metrics">
          <ReviewMetric tone="blue" icon={<IconInbox />} value="n/a" label="New reviews" note="Not syncing yet" />
          <ReviewMetric tone="green" icon={<IconCheck />} value="n/a" label="Replied" note="Not syncing yet" />
          <ReviewMetric tone="orange" icon={<IconClock />} value="n/a" label="Pending" note="Not syncing yet" />
          <ReviewMetric tone="gold" icon={<span>☆</span>} value="n/a" label="Average rating" note="Not syncing yet" />
        </div>

        <div className="reviews-workspace">
          <div className="reviews-maincol">
            <div className="review-setup-grid">
              <SetupCard
                icon={<IconLocal size={22} />}
                title="Google Business Profile"
                ready={connected}
                state={connected ? (gbp.displayName ?? "Connected") : business?.gmbName ? "Listing recorded" : "Not connected"}
                description={connected
                  ? `${locations.length} location${locations.length === 1 ? "" : "s"} available for review monitoring.`
                  : AVAILABLE
                    ? "Connect your Google Business Profile to start monitoring reviews."
                    : business?.gmbName
                      ? `Replies will be written for "${business.gmbName}". Automatic syncing waits on Google approving API access for this deployment.`
                      : "Record the listing name exactly as Google shows it, so replies use the name customers recognise. Automatic syncing waits on Google approving API access."}
                href={AVAILABLE ? "/integrations" : "/settings#business"}
                action={connected ? "Manage connection" : AVAILABLE ? "Connect GMB" : business?.gmbName ? "Edit listing name" : "Add listing name"}
              />
              <SetupCard
                icon={<IconVoiceNav size={22} />}
                title="Brand Voice"
                state={voice ? "Ready" : "Not set"}
                ready={Boolean(voice)}
                description={voice ? "Replies will follow your learned tone and language." : "Set your brand voice to generate personalized replies."}
                href="/voice"
                action={voice ? "Review voice" : "Set brand voice"}
              />
            </div>

            <section id="recent-reviews" className="recent-reviews">
              <div className="reviews-section-title"><h2>Recent Reviews</h2><span>{connected ? "Synced from Google" : "Waiting for connection"}</span></div>
              <div className="reviews-empty">
                <span className="reviews-empty-icon"><IconInbox size={24} /></span>
                <strong>{connected ? "No reviews synced yet" : AVAILABLE ? "Connect Google to see reviews" : "Review syncing is not built yet"}</strong>
                <p>{connected
                  ? "New reviews will appear here with AI reply suggestions."
                  : AVAILABLE
                    ? "Customer reviews and reply approvals will appear here after your Business Profile is connected."
                    : "Reading reviews needs Google to approve Business Profile API access for this project, which is an application with a review process rather than a setting. There is nothing to connect to until that is granted."}</p>
                {/*
                  * Until syncing exists, the useful thing is the listing
                  * itself: the reviews are public and that is where they get
                  * answered today.
                  */}
                {!connected && AVAILABLE ? (
                  <Link className="btn primary" href="/integrations">Connect Google Business Profile</Link>
                ) : !connected && listingUrl ? (
                  <Link className="btn" href={listingUrl} target="_blank" rel="noreferrer">
                    Read them on Google
                  </Link>
                ) : null}
              </div>
            </section>
          </div>

          <aside className="reviews-sidecol">
            <section className="review-sidecard automation-card">
              <div className="review-side-title"><IconSettings size={15} /><strong>Automation Status</strong><span className={`status-toggle${readySteps === 4 ? " on" : ""}`} /></div>
              <ul>
                <li className={connected ? "ready" : ""}>Monitor new reviews</li>
                <li className={voice ? "ready" : ""}>Generate AI replies</li>
                {/* Was hardcoded "ready", so this step showed a green dot for
                    an automation with no backend — and could take the panel to
                    "4 of 4 steps ready" while nothing could run. */}
                <li className={AVAILABLE ? "ready" : ""}>Notify for approval</li>
                <li className={connected ? "ready" : ""}>Post approved replies</li>
              </ul>
              <small>{readySteps} of 4 steps ready</small>
            </section>

            <section className="review-sidecard keyword-card">
              <div className="review-side-title"><IconAnalytics size={15} /><strong>Review Keywords</strong></div>
              <div className="keyword-empty">Keywords appear after reviews are synced.</div>
            </section>

            <section className="review-sidecard quick-card">
              <div className="review-side-title"><IconIntegrations size={15} /><strong>Quick Actions</strong></div>
              {AVAILABLE ? (
                <Link href="/integrations">Manage Google connection <IconArrow size={13} /></Link>
              ) : null}
              <Link href="/voice">Manage brand voice <IconArrow size={13} /></Link>
              <Link href="/settings/business">Edit business info <IconArrow size={13} /></Link>
            </section>
          </aside>
        </div>
      </div>
    </>
  );
}

function ReviewMetric({ tone, icon, value, label, note }: {
  tone: string; icon: React.ReactNode; value: string; label: string; note: string;
}) {
  return <div className="review-metric"><span className={`review-metric-icon ${tone}`}>{icon}</span><div><strong>{value}</strong><b>{label}</b><small>{note}</small></div></div>;
}

/*
 * A setup step, with its action only when one exists.
 *
 * `href`/`action` are nullable because a step can be genuinely unreachable —
 * GMB cannot be connected until Google approves API access — and a button
 * that bounces to a page which also cannot do it is worse than no button.
 */
function SetupCard({ icon, title, state, ready, description, href, action }: {
  icon: React.ReactNode; title: string; state: string; ready: boolean; description: string;
  href: string | null; action: string | null;
}) {
  return <section className="review-setup-card"><span className="setup-card-icon">{icon}</span><div><strong>{title}</strong><b className={ready ? "ready" : "blocked"}>{state}</b><p>{description}</p>{href && action ? <Link className="btn small" href={href}>{action}</Link> : null}</div></section>;
}
