"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { GoogleListing, ReviewReplyDraft, ReviewSource } from "@ob/db";
import {
  IconLocal, IconVoiceNav, IconSettings, IconCheck, IconClock, IconInbox, IconAnalytics, IconArrow, IconIntegrations,
} from "./Icons";

/**
 * Everything on the reviews page below the hero.
 *
 * The page never posts on its own. A reply is drafted, a person reads and
 * edits it, and a person presses Post (or, for reviews read through the Places
 * API, pastes it on Google and marks it posted). Edits are kept here per
 * review, apart from what the server sends, so a refresh while drafts land
 * never throws away what someone is typing.
 */

export interface ReviewItem {
  id: string;
  source: ReviewSource;
  authorName: string;
  authorPhotoUrl: string | null;
  authorUrl: string | null;
  rating: number;
  comment: string | null;
  reviewUrl: string | null;
  publishedAt: string;
  googleReply: { comment: string; updatedAt: string } | null;
  draft: ReviewReplyDraft | null;
}

interface GoogleState {
  configured: boolean;
  connected: boolean;
  account: string | null;
  /** Why Business Profile cannot be used yet, from the last attempt. */
  note: string | null;
}

interface PlaceRow { placeId: string; title: string; address: string | null; rating: number | null; reviewCount: number | null }
interface GbpRow { name: string; title: string; address: string | null }

type Filter = "all" | "open" | "drafted" | "replied";

const posted = (r: ReviewItem) => r.draft?.status === "posted" || r.draft?.status === "posted_by_hand";
const replied = (r: ReviewItem) => posted(r) || Boolean(r.googleReply);
const drafted = (r: ReviewItem) => !replied(r) && Boolean(r.draft && (r.draft.body || r.draft.requiresHumanEdit));
const stars = (n: number) => "★★★★★".slice(0, n) + "☆☆☆☆☆".slice(0, 5 - n);

async function call<T>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) throw new Error(json.error?.message ?? "That did not work.");
  return json;
}

function Ago({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} suppressHydrationWarning>
      {new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
    </time>
  );
}

export function ReviewsWorkspace({
  businessName, listing, reviews: initial, source, google, placesConfigured, hasVoice, keywords, canEdit, canConnect,
}: {
  businessName: string;
  listing: GoogleListing | null;
  reviews: ReviewItem[];
  source: ReviewSource | null;
  google: GoogleState;
  placesConfigured: boolean;
  hasVoice: boolean;
  keywords: { word: string; count: number }[];
  canEdit: boolean;
  canConnect: boolean;
}) {
  const router = useRouter();
  const [reviews, setReviews] = useState(initial);
  useEffect(() => setReviews(initial), [initial]);
  const [filter, setFilter] = useState<Filter>("open");
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const [picking, setPicking] = useState(!listing?.placeId && !listing?.gbpLocation);
  /** Refreshes left while the worker drafts replies. */
  const [polls, setPolls] = useState(0);

  useEffect(() => {
    if (polls <= 0) return;
    const t = window.setTimeout(() => { router.refresh(); setPolls((n) => n - 1); }, 5000);
    return () => window.clearTimeout(t);
  }, [polls, router]);

  const gbpReady = source === "gbp" && google.connected && listing?.gbpStatus === "ok";
  const counts = {
    open: reviews.filter((r) => !replied(r)).length,
    drafted: reviews.filter(drafted).length,
    replied: reviews.filter(replied).length,
  };
  const shown = reviews.filter((r) =>
    filter === "all" ? true : filter === "open" ? !replied(r) : filter === "drafted" ? drafted(r) : replied(r));

  async function sync() {
    setSyncing(true);
    setSyncNote(null);
    try {
      const res = await call<{ added: number; source: ReviewSource | null; drafting: boolean; listing: GoogleListing }>("/api/reviews/sync", "POST");
      setSyncNote(res.source
        ? `${res.added ? `${res.added} new review${res.added === 1 ? "" : "s"}` : "No new reviews"}${res.drafting && res.added ? ". Drafting replies…" : "."}`
        : res.listing.lastError ?? "Nothing could be read.");
      if (res.drafting) setPolls(6);
      router.refresh();
    } catch (err) {
      setSyncNote(err instanceof Error ? err.message : "Could not reach the server.");
    } finally {
      setSyncing(false);
    }
  }

  const update = (id: string, patch: Partial<ReviewItem>) => {
    setReviews((all) => all.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    // A posted reply leaves "Need a reply"; say where it went rather than let it vanish.
    const st = patch.draft?.status;
    if (st === "posted" || st === "posted_by_hand") {
      const who = reviews.find((r) => r.id === id)?.authorName ?? "the reviewer";
      setSyncNote(`Reply to ${who} ${st === "posted" ? "posted to Google" : "marked as posted"}. It is under Replied.`);
    }
  };

  const steps = [
    { label: "Listing chosen", ready: Boolean(listing?.placeId || listing?.gbpLocation) },
    { label: "Reading reviews", ready: Boolean(source) },
    { label: "Replies in brand voice", ready: hasVoice },
    { label: "Posting replies from here", ready: gbpReady },
  ];

  return (
    <>
      <div className="review-metrics">
        <Metric tone="blue" icon={<IconInbox />} value={source ? String(counts.open) : "n/a"} label="Need a reply"
                note={source ? `of ${reviews.length} read` : "Not reading yet"} />
        <Metric tone="green" icon={<IconCheck />} value={source ? String(counts.replied) : "n/a"} label="Replied"
                note={source === "places" ? "Places cannot see replies made on Google" : source ? "On Google" : "Not reading yet"} />
        <Metric tone="orange" icon={<IconClock />} value={source ? String(counts.drafted) : "n/a"} label="Drafts to check" note="Waiting for a person" />
        <Metric tone="gold" icon={<span>☆</span>}
                value={typeof listing?.rating === "number" ? listing.rating.toFixed(1) : "n/a"} label="Average rating"
                note={typeof listing?.reviewCount === "number" ? `${listing.reviewCount} reviews on Google` : "Not reading yet"} />
      </div>

      <div className="reviews-workspace">
        <div className="reviews-maincol">
          <div className="review-setup-grid">
            <GoogleCard google={google} listing={listing} canConnect={canConnect} />
            <section className="review-setup-card">
              <span className="setup-card-icon"><IconVoiceNav size={22} /></span>
              <div>
                <strong>Brand Voice</strong>
                <b className={hasVoice ? "ready" : "blocked"}>{hasVoice ? "Ready" : "Not set"}</b>
                <p>{hasVoice ? "Replies follow the learned tone and words to avoid." : "Without a voice, replies are warm and plain. Set one for replies that sound like the business."}</p>
                <Link className="btn small" href="/voice">{hasVoice ? "Review voice" : "Set brand voice"}</Link>
              </div>
            </section>
          </div>

          <ListingPanel
            businessName={businessName}
            listing={listing}
            googleConnected={google.connected}
            placesConfigured={placesConfigured}
            canEdit={canEdit}
            open={picking}
            onOpen={setPicking}
            onChosen={(drafting) => { setPicking(false); if (drafting) setPolls(6); router.refresh(); }}
          />

          <section id="recent-reviews" className="recent-reviews">
            <div className="reviews-section-title rv-titlebar">
              <h2>Reviews</h2>
              <span>
                {source === "gbp" ? "From Google Business Profile" : source === "places" ? "Latest 5, from Google Maps (Places API)" : "Not reading yet"}
                {listing?.syncedAt ? <> · synced <Ago iso={listing.syncedAt} /></> : null}
              </span>
              {canEdit && (listing?.placeId || listing?.gbpLocation) ? (
                <button type="button" className="btn small" disabled={syncing} onClick={() => void sync()}>
                  {syncing ? "Syncing…" : "Sync now"}
                </button>
              ) : null}
            </div>
            {syncNote ? <p className="rv-note" role="status">{syncNote}{polls > 0 ? " Checking for drafts…" : ""}</p> : null}
            {listing?.lastError && !source ? <p className="rv-error">{listing.lastError}</p> : null}
            {source === "places" ? (
              <p className="rv-hint">
                Until Google approves Business Profile API access, Google only shares a listing&apos;s latest 5 reviews, and cannot say
                whether they were already answered. Replies are copied here and pasted on Google.
              </p>
            ) : null}

            {reviews.length ? (
              <>
                <div className="rv-filters" role="tablist" aria-label="Filter reviews">
                  {([["open", `Need a reply (${counts.open})`], ["drafted", `Drafts (${counts.drafted})`], ["replied", `Replied (${counts.replied})`], ["all", `All (${reviews.length})`]] as const).map(([key, label]) => (
                    <button key={key} type="button" role="tab" aria-selected={filter === key} className={filter === key ? "on" : ""} onClick={() => setFilter(key)}>
                      {label}
                    </button>
                  ))}
                </div>
                <ul className="rv-list">
                  {shown.map((r) => (
                    <ReviewCard key={r.id} review={r} canEdit={canEdit} canPost={gbpReady && r.source === "gbp"}
                                mapsUri={listing?.mapsUri ?? null} onChange={(patch) => update(r.id, patch)} />
                  ))}
                  {shown.length === 0 ? <li className="rv-none">Nothing here.</li> : null}
                </ul>
              </>
            ) : (
              <div className="reviews-empty">
                <span className="reviews-empty-icon"><IconInbox size={24} /></span>
                <strong>{listing?.placeId || listing?.gbpLocation ? "No reviews read yet" : "Choose the Google listing first"}</strong>
                <p>{listing?.placeId || listing?.gbpLocation
                  ? "Press Sync now to read them. New reviews get a reply drafted automatically."
                  : `Find ${businessName} on Google above. Its reviews appear here with a reply drafted for each.`}</p>
              </div>
            )}
          </section>
        </div>

        <aside className="reviews-sidecol">
          <section className="review-sidecard automation-card">
            <div className="review-side-title"><IconSettings size={15} /><strong>Automation Status</strong>
              <span className={`status-toggle${steps.every((s) => s.ready) ? " on" : ""}`} /></div>
            <ul>{steps.map((s) => <li key={s.label} className={s.ready ? "ready" : ""}>{s.label}</li>)}</ul>
            <small>{steps.filter((s) => s.ready).length} of {steps.length} ready · synced every 6 hours</small>
          </section>

          <section className="review-sidecard keyword-card">
            <div className="review-side-title"><IconAnalytics size={15} /><strong>Review Keywords</strong></div>
            {keywords.length ? (
              <ul className="rv-keywords">{keywords.map((k) => <li key={k.word}>{k.word} <b>{k.count}</b></li>)}</ul>
            ) : (
              <div className="keyword-empty">Words reviewers repeat appear here once a few reviews are read.</div>
            )}
          </section>

          <section className="review-sidecard quick-card">
            <div className="review-side-title"><IconIntegrations size={15} /><strong>Quick Actions</strong></div>
            {listing?.mapsUri ? <a href={listing.mapsUri} target="_blank" rel="noreferrer">Open listing on Google <IconArrow size={13} /></a> : null}
            <Link href="/voice">Manage brand voice <IconArrow size={13} /></Link>
            <Link href="/settings/business">Edit business info <IconArrow size={13} /></Link>
          </section>
        </aside>
      </div>
    </>
  );
}

function Metric({ tone, icon, value, label, note }: { tone: string; icon: React.ReactNode; value: string; label: string; note: string }) {
  return <div className="review-metric"><span className={`review-metric-icon ${tone}`}>{icon}</span><div><strong>{value}</strong><b>{label}</b><small>{note}</small></div></div>;
}

function GoogleCard({ google, listing, canConnect }: { google: GoogleState; listing: GoogleListing | null; canConnect: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const pending = listing?.gbpStatus === "pending" || /not approved/i.test(google.note ?? "");
  const state = !google.connected ? "Not connected" : pending ? "Waiting for Google approval" : "Connected";
  const text = !google.configured
    ? "Add GOOGLE_GBP_CLIENT_ID and GOOGLE_GBP_CLIENT_SECRET to .env to connect."
    : !google.connected
      ? "Connect the Google account that manages this listing, to read every review and post replies from here."
      : pending
        ? `Connected as ${google.account}. Google has not approved Business Profile API access for this Cloud project yet; until then reviews come from Google Maps and replies are posted by hand.`
        : listing?.gbpStatus === "error" && listing.gbpError
          ? listing.gbpError
          : listing?.gbpLocation
            ? `Connected as ${google.account}. Replies post straight to ${listing.gbpTitle ?? "the listing"}.`
            : `Connected as ${google.account}. Choose the listing below.`;

  async function disconnect() {
    setBusy(true);
    try {
      await call("/api/integrations/google-business", "DELETE");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="review-setup-card">
      <span className="setup-card-icon"><IconLocal size={22} /></span>
      <div>
        <strong>Google Business Profile</strong>
        <b className={google.connected && !pending ? "ready" : "blocked"}>{state}</b>
        <p>{text}</p>
        {canConnect && google.configured ? (
          <div className="rv-card-actions">
            <a className={`btn small${google.connected ? "" : " primary"}`} href="/api/integrations/google-business/start">
              {google.connected ? "Reconnect" : "Connect Google"}
            </a>
            {google.connected ? <button type="button" className="btn small" disabled={busy} onClick={() => void disconnect()}>Disconnect</button> : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function ListingPanel({
  businessName, listing, googleConnected, placesConfigured, canEdit, open, onOpen, onChosen,
}: {
  businessName: string;
  listing: GoogleListing | null;
  googleConnected: boolean;
  placesConfigured: boolean;
  canEdit: boolean;
  open: boolean;
  onOpen: (open: boolean) => void;
  onChosen: (drafting: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const [places, setPlaces] = useState<PlaceRow[] | null>(null);
  const [gbp, setGbp] = useState<GbpRow[] | null>(null);
  const [gbpError, setGbpError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function search(q: string) {
    setBusy("search");
    setError(null);
    try {
      const res = await call<{ query: string; places: PlaceRow[] }>(`/api/reviews/listing?q=${encodeURIComponent(q)}`, "GET");
      setPlaces(res.places);
      if (!q) setQuery(res.query);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not search Google.");
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    if (!open) return;
    if (placesConfigured && places === null) void search("");
    if (googleConnected && gbp === null) {
      void call<{ locations: GbpRow[] }>("/api/reviews/listing?source=gbp", "GET")
        .then((r) => setGbp(r.locations))
        .catch((err: unknown) => { setGbp([]); setGbpError(err instanceof Error ? err.message : null); });
    }
    // Only when the panel opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function choose(body: { placeId: string } | { gbpLocation: string }) {
    setBusy("choose");
    setError(null);
    try {
      const res = await call<{ drafting: boolean }>("/api/reviews/listing", "PATCH", body);
      onChosen(res.drafting);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save that.");
    } finally {
      setBusy(null);
    }
  }

  const chosen = listing?.placeId || listing?.gbpLocation;
  const name = useMemo(() => listing?.gbpTitle || listing?.title || null, [listing]);

  if (!open) {
    return chosen ? (
      <div className="rv-listing">
        <div>
          <span className="rv-listing-label">Google listing</span>
          <strong>{name ?? businessName}</strong>
          {listing?.address ? <small>{listing.address}</small> : null}
        </div>
        {canEdit ? <button type="button" className="btn small" onClick={() => onOpen(true)}>Change</button> : null}
      </div>
    ) : null;
  }

  return (
    <section className="rv-picker" aria-label="Choose the Google listing">
      <div className="rv-picker-head">
        <div>
          <h3>Which Google listing is {businessName}&apos;s?</h3>
          <p>Pick it yourself: names are shared, and a reply to the wrong business&apos;s review is public.</p>
        </div>
        {chosen ? <button type="button" className="socal-pop-close" aria-label="Close" onClick={() => onOpen(false)}>×</button> : null}
      </div>
      {error ? <p className="rv-error">{error}</p> : null}

      {googleConnected ? (
        <div className="rv-picker-group">
          <span className="rv-listing-label">From your Google account</span>
          {gbp === null ? <p className="rv-hint">Loading…</p>
            : gbp.length ? (
              <ul className="rv-options">
                {gbp.map((l) => (
                  <li key={l.name}>
                    <div><strong>{l.title}</strong>{l.address ? <small>{l.address}</small> : null}</div>
                    <button type="button" className="btn small primary" disabled={!canEdit || !!busy} onClick={() => void choose({ gbpLocation: l.name })}>This one</button>
                  </li>
                ))}
              </ul>
            ) : <p className="rv-hint">{gbpError ?? "This Google account manages no listings."}</p>}
        </div>
      ) : null}

      <div className="rv-picker-group">
        <span className="rv-listing-label">Search Google Maps</span>
        {placesConfigured ? (
          <>
            <form className="rv-search" onSubmit={(e) => { e.preventDefault(); void search(query.trim()); }}>
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Business name and town" aria-label="Search Google Maps" />
              <button type="submit" className="btn small" disabled={!!busy || !query.trim()}>{busy === "search" ? "Searching…" : "Search"}</button>
            </form>
            {places?.length ? (
              <ul className="rv-options">
                {places.map((p) => (
                  <li key={p.placeId}>
                    <div>
                      <strong>{p.title}</strong>
                      {p.address ? <small>{p.address}</small> : null}
                      {typeof p.rating === "number" ? <small className="rv-stars-small">{p.rating.toFixed(1)} ★ · {p.reviewCount ?? 0} reviews</small> : null}
                    </div>
                    <button type="button" className="btn small primary" disabled={!canEdit || !!busy} onClick={() => void choose({ placeId: p.placeId })}>
                      {busy === "choose" ? "Reading…" : "This one"}
                    </button>
                  </li>
                ))}
              </ul>
            ) : places ? <p className="rv-hint">No listings found. Try the name as it appears on Google, with the town.</p> : null}
          </>
        ) : (
          <p className="rv-hint">Add <code>GOOGLE_MAPS_API_KEY</code> to .env (a Google Cloud key with Places API (New) turned on) to search and read public reviews.</p>
        )}
      </div>
    </section>
  );
}

function ReviewCard({ review, canEdit, canPost, mapsUri, onChange }: {
  review: ReviewItem;
  canEdit: boolean;
  canPost: boolean;
  mapsUri: string | null;
  onChange: (patch: Partial<ReviewItem>) => void;
}) {
  const [text, setText] = useState(review.draft?.body ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Google's photo links expire; a dead one falls back to the initial.
  const [photoOk, setPhotoOk] = useState(true);
  // A draft that lands from the worker fills the box, unless someone has typed.
  useEffect(() => { setText((t) => (t.trim() ? t : review.draft?.body ?? "")); }, [review.draft?.body]);

  const done = posted(review);
  const dirty = text.trim() !== (review.draft?.body ?? "").trim();

  async function act(action: "draft" | "save" | "post" | "posted") {
    setBusy(action);
    setError(null);
    try {
      const res = await call<{ draft: ReviewReplyDraft; googleReply?: ReviewItem["googleReply"] }>(
        `/api/reviews/${review.id}`, "PATCH", action === "draft" ? { action } : { action, body: text },
      );
      if (action === "draft") setText(res.draft.body);
      onChange({ draft: res.draft, ...(res.googleReply !== undefined ? { googleReply: res.googleReply } : {}) });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reach the server.");
    } finally {
      setBusy(null);
    }
  }

  async function copyAndOpen() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch { /* the box is still there to copy from */ }
    window.open(review.reviewUrl ?? mapsUri ?? "https://business.google.com/reviews", "_blank", "noopener");
  }

  return (
    <li className={`rv-card rating-${review.rating}`}>
      <div className="rv-head">
        <span className="rv-avatar" aria-hidden>
          {review.authorPhotoUrl && photoOk
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={review.authorPhotoUrl} alt="" referrerPolicy="no-referrer" onError={() => setPhotoOk(false)} />
            : review.authorName.slice(0, 1).toUpperCase()}
        </span>
        <div className="rv-who">
          {review.authorUrl ? <a href={review.authorUrl} target="_blank" rel="noreferrer">{review.authorName}</a> : <strong>{review.authorName}</strong>}
          <span><span className="rv-stars" aria-label={`${review.rating} of 5 stars`}>{stars(review.rating)}</span> · <Ago iso={review.publishedAt} /></span>
        </div>
        <span className={`rv-state ${done || review.googleReply ? "replied" : review.draft?.requiresHumanEdit ? "human" : review.draft ? "drafted" : "open"}`}>
          {done ? (review.draft?.status === "posted" ? "Reply posted" : "Posted on Google")
            : review.googleReply ? "Replied on Google"
            : review.draft?.requiresHumanEdit ? "Needs a personal reply"
            : review.draft ? "Draft ready" : "Needs a reply"}
        </span>
      </div>

      <p className={`rv-text${review.comment ? "" : " empty"}`}>{review.comment ?? "Left a rating without a comment."}</p>

      {review.googleReply && !done ? (
        <div className="rv-existing"><b>Reply on Google</b><p>{review.googleReply.comment}</p></div>
      ) : null}

      {done ? (
        <div className="rv-existing mine"><b>{review.draft?.status === "posted" ? "Posted from GrowPilot" : "Posted on Google by hand"}</b><p>{review.draft?.body}</p></div>
      ) : canEdit && !review.googleReply ? (
        <div className="rv-reply">
          {review.draft?.requiresHumanEdit ? <p className="rv-withheld">{review.draft.withheldReason}</p> : null}
          {!review.draft ? (
            <button type="button" className="btn small primary" disabled={!!busy} onClick={() => void act("draft")}>
              {busy === "draft" ? "Drafting…" : "Draft a reply"}
            </button>
          ) : (
            <>
              <textarea
                rows={Math.min(8, Math.max(3, Math.ceil(text.length / 90)))}
                value={text}
                placeholder={review.draft.requiresHumanEdit ? "Write the reply yourself…" : "The reply…"}
                disabled={!!busy}
                onChange={(e) => setText(e.target.value)}
                aria-label={`Reply to ${review.authorName}`}
              />
              <div className="rv-actions">
                <span className="rv-count">{text.trim().split(/\s+/).filter(Boolean).length} words</span>
                {!review.draft.requiresHumanEdit ? (
                  <button type="button" className="btn small" disabled={!!busy} onClick={() => void act("draft")}>
                    {busy === "draft" ? "Drafting…" : "Redraft"}
                  </button>
                ) : null}
                {dirty ? <button type="button" className="btn small" disabled={!!busy} onClick={() => void act("save")}>{busy === "save" ? "Saving…" : "Save"}</button> : null}
                {canPost ? (
                  <button type="button" className="btn small primary" disabled={!!busy || !text.trim()} onClick={() => void act("post")}>
                    {busy === "post" ? "Posting…" : "Post reply"}
                  </button>
                ) : (
                  <>
                    <button type="button" className="btn small primary" disabled={!text.trim()} onClick={() => void copyAndOpen()}>
                      {copied ? "Copied. Paste it on Google" : "Copy & open on Google"}
                    </button>
                    <button type="button" className="btn small" disabled={!!busy || !text.trim()} onClick={() => void act("posted")}>
                      {busy === "posted" ? "Saving…" : "Mark as posted"}
                    </button>
                  </>
                )}
              </div>
            </>
          )}
          {error ? <p className="rv-error">{error}</p> : null}
        </div>
      ) : null}
    </li>
  );
}
