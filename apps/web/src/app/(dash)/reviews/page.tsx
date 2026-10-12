import Link from "next/link";
import { and, desc, eq } from "drizzle-orm";
import { config } from "@ob/core";
import { gmbReviews, integrations, repo } from "@ob/db";
import { GBP_PROVIDER, googleCredentials } from "@ob/gmb";
import { getClient } from "@/lib/tenant";
import { requireTenant, getSession } from "@/lib/auth";
import { db } from "@/lib/services";
import { TopBar } from "@/components/TopBar";
import { IconSettings } from "@/components/Icons";
import { ReviewsWorkspace, type ReviewItem } from "@/components/ReviewsWorkspace";

/**
 * GMB Reviews: read a client's Google reviews, draft replies in the brand
 * voice, and post them once a person approves.
 *
 * Two sources, and the page is plain about which is in use. Business Profile
 * (after Google approves API access for the Cloud project) reads every review
 * and posts replies. Until then the Places API reads the listing's rating and
 * latest five reviews, and replies are copied onto Google by hand.
 */

export const dynamic = "force-dynamic";

const NOTICES: Record<string, { tone: "ok" | "warn" | "error"; text: string }> = {
  connected: { tone: "ok", text: "Google connected. Choose the listing below if it was not picked for you." },
  pending: {
    tone: "warn",
    text: "Google connected, but Google has not approved Business Profile API access for this Cloud project yet. Reviews are read through the Places API until it does, and replies are posted by hand.",
  },
  disabled: {
    tone: "warn",
    text: "Google connected, but the Business Profile APIs are turned off in this Cloud project. Turn on My Business Account Management API, My Business Business Information API and Google My Business API.",
  },
  cancelled: { tone: "error", text: "Google sign-in was cancelled. Nothing was connected." },
  state_mismatch: { tone: "error", text: "That connection attempt could not be verified. Please try again." },
  wrong_workspace: { tone: "error", text: "That connection was started from a different workspace. Try again from this one." },
  not_configured: { tone: "error", text: "Google is not set up on this server: GOOGLE_GBP_CLIENT_ID and GOOGLE_GBP_CLIENT_SECRET are missing from .env." },
  exchange_failed: { tone: "error", text: "Google would not complete the sign-in. Check the OAuth client's redirect URI, then try again." },
  scope_declined: { tone: "error", text: "The Business Profile permission was unticked on Google's screen, so nothing can be read. Connect again and leave it ticked." },
  no_refresh_token: { tone: "error", text: "Google did not return a lasting connection. Remove GrowPilot's access at myaccount.google.com/permissions, then connect again." },
  failed: { tone: "error", text: "The connection did not complete. Please try again." },
};

const STOP = new Set(("about after again also always amazing and are back been before being best but came can come could did does doing done each even ever every experience feel felt from good got great had has have here highly just know like made make more most much never nice only other our out over place really recommend service should some staff still than thank thanks that the their them then there they thing this time very visit was way well went were what when which while will with would your you yours they're it's i'm we've").split(" "));

/** The words reviewers use most, for the keyword panel. */
function keywords(comments: (string | null)[]): { word: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const c of comments) {
    if (!c) continue;
    const seen = new Set<string>();
    for (const w of c.toLowerCase().match(/\p{L}[\p{L}']{3,}/gu) ?? []) {
      if (STOP.has(w) || seen.has(w)) continue;
      seen.add(w);
      counts.set(w, (counts.get(w) ?? 0) + 1);
    }
  }
  return [...counts].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([word, count]) => ({ word, count }));
}

export default async function ReviewsPage({
  searchParams,
}: { searchParams: Promise<{ google?: string; google_error?: string }> }) {
  const ctx = await requireTenant();
  const session = await getSession();
  const initials = (session?.name ?? session?.email ?? "?").split(/[\s@.]+/).filter(Boolean)
    .slice(0, 2).map((c) => c[0]!.toUpperCase()).join("") || "?";
  const params = await searchParams;

  const database = db();
  const business = await getClient();
  const creds = googleCredentials(config());
  const [[gbp], voice, rows] = await Promise.all([
    database.select({ status: integrations.status, displayName: integrations.displayName, lastError: integrations.lastError })
      .from(integrations)
      .where(and(eq(integrations.workspaceId, ctx.workspaceId), eq(integrations.provider, GBP_PROVIDER))).limit(1),
    business ? repo.getActiveVoice(database, ctx, business.id) : Promise.resolve(null),
    business
      ? database.select().from(gmbReviews)
          .where(and(eq(gmbReviews.workspaceId, ctx.workspaceId), eq(gmbReviews.businessId, business.id)))
          .orderBy(desc(gmbReviews.publishedAt)).limit(300)
      : Promise.resolve([]),
  ]);

  // Business Profile's reviews once there are any; Places' are then duplicates under other ids.
  // The best source with any reviews: Business Profile, then Places, then the Maps page.
  const source = (["gbp", "places", "maps"] as const).find((s) => rows.some((r) => r.source === s)) ?? "places";
  const reviews: ReviewItem[] = rows.filter((r) => r.source === source).map((r) => ({
    id: r.id,
    source: r.source,
    authorName: r.authorName,
    authorPhotoUrl: r.authorPhotoUrl,
    authorUrl: r.authorUrl,
    rating: r.rating,
    comment: r.comment,
    reviewUrl: r.reviewUrl,
    publishedAt: r.publishedAt.toISOString(),
    googleReply: r.googleReply ?? null,
    draft: r.draft ?? null,
  }));

  const listing = business?.googleListing ?? null;
  const notice = params.google_error
    ? NOTICES[params.google_error] ?? NOTICES.failed!
    : params.google ? NOTICES[params.google] ?? null : null;
  const canEdit = ctx.role === "owner" || ctx.role === "admin" || ctx.role === "editor";

  return (
    <>
      <TopBar section="Automation" page="GMB Reviews" initials={initials} />
      <div className="content reviews-page">
        {notice ? (
          <div className={`finding ${notice.tone === "ok" ? "info" : notice.tone}`} style={{ marginBottom: 14 }} role="status">
            {notice.text}
          </div>
        ) : null}

        <section className="reviews-hero">
          <div>
            <span className="reviews-eyebrow">GMB reviews automation</span>
            <h1>Turn Reviews into Trust</h1>
            <p>Monitor new Google reviews, get AI-generated replies in your brand voice, and post once you approve.</p>
            <div className="reviews-hero-actions">
              {listing?.mapsUri ? (
                <a className="btn" href={listing.mapsUri} target="_blank" rel="noreferrer">
                  Open {listing.title || business?.name} on Google
                </a>
              ) : null}
              <Link className="btn" href="/settings/business"><IconSettings size={15} /> Business info</Link>
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

        {business ? (
          <ReviewsWorkspace
            businessName={business.name}
            listing={listing}
            reviews={reviews}
            source={reviews.length ? source : listing?.source ?? null}
            google={{
              configured: Boolean(creds.clientId && creds.clientSecret),
              connected: gbp?.status === "connected",
              account: gbp?.displayName ?? null,
              note: gbp?.lastError ?? null,
            }}
            placesConfigured={Boolean(creds.mapsKey)}
            crawlerConfigured={Boolean(creds.crawlerUrl)}
            hasVoice={Boolean(voice)}
            keywords={keywords(reviews.map((r) => r.comment))}
            canEdit={canEdit}
            canConnect={ctx.role === "owner" || ctx.role === "admin"}
          />
        ) : (
          <div className="reviews-empty">
            <strong>Add a client first</strong>
            <p>Reviews belong to a client&apos;s Google listing. Add the business, then come back here.</p>
          </div>
        )}
      </div>
    </>
  );
}
