"use client";

import Link from "next/link";
import { SocialPublishRecovery } from "./SocialPublishRecovery";
import { useEffect, useRef, useState } from "react";
import type { PackSchedule, SocialContentPack, SocialNetworkId } from "@ob/db";
import { pictureRatio } from "@ob/social/text";
import { Section, PinIcon, dateOf, weekday, chipDate, type PackPost } from "./SocialPackParts";
import { MetaPagePicker } from "./MetaPagePicker";
import { MetaTokenConnect } from "./MetaTokenConnect";
import { markdownToPlain } from "@/lib/social-text";
import type { ConnectionSummary } from "@/lib/social-connection";

/**
 * Step 5: approved posts get a time and the networks to go to.
 *
 * The page schedules; the worker publishes, at the time, whether or not this
 * page is open. So the connection is shown first, network by network: a post
 * can only be scheduled where the connection can actually post, and a reason
 * found here is one found before the morning the post was meant to go out.
 *
 * Posts are scheduled one request at a time, "schedule all" included, and
 * that stops at the first failure, which is nearly always the same for every
 * post after it (a permission, a connection).
 */

const NETWORKS: { id: SocialNetworkId; label: string; mark: string }[] = [
  { id: "facebook", label: "Facebook", mark: "f" },
  { id: "instagram", label: "Instagram", mark: "IG" },
];
const NAME: Record<SocialNetworkId, string> = { facebook: "Facebook", instagram: "Instagram" };
/** The time of day a post goes out unless someone picks another. */
const DEFAULT_TIME = "10:00";

type CardState = "blocked" | "ready" | "scheduled" | "publishing" | "published" | "partial" | "failed";

const STATE_LABEL: Record<CardState, string> = {
  blocked: "Not ready",
  ready: "Ready",
  scheduled: "Scheduled",
  publishing: "Publishing…",
  published: "Published",
  partial: "Partly published",
  failed: "Failed",
};

function stateOf(p: PackPost, blocker: string | null): CardState {
  const s = p.pack?.schedule;
  if (s) return s.status;
  return blocker ? "blocked" : "ready";
}

const imageUrl = (key: string) => `/api/social/images/${key}`;
const cssRatio = (format: string) => pictureRatio(format).replace(":", " / ");
const pad = (n: number) => String(n).padStart(2, "0");

/** A local date and time as the ISO instant the server stores. */
function toIso(date: string, time: string): string | null {
  const d = new Date(`${date}T${time}`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
/** An ISO instant as the local date and time the inputs show. */
function toLocal(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
}
/** The next quarter hour at least five minutes away, for a post whose own date has gone. */
function soonest(): { date: string; time: string } {
  const d = new Date(Date.now() + 5 * 60_000);
  d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
  return toLocal(d.toISOString());
}
function defaultWhen(p: PackPost): { date: string; time: string } {
  // A post waiting to go out keeps its time; one that already tried starts afresh.
  if (p.pack?.schedule?.status === "scheduled") return toLocal(p.pack.schedule.at);
  const iso = toIso(p.date, DEFAULT_TIME);
  return iso && Date.parse(iso) > Date.now() + 2 * 60_000 ? { date: p.date, time: DEFAULT_TIME } : soonest();
}

/** Written in the viewer's time zone, which the server cannot know, so only after hydration. */
function When({ iso, withDay = true }: { iso: string; withDay?: boolean }) {
  return (
    <time dateTime={iso} suppressHydrationWarning>
      {new Date(iso).toLocaleString("en-US", {
        ...(withDay ? { weekday: "short", month: "short", day: "numeric" } : {}),
        hour: "numeric", minute: "2-digit",
      })}
    </time>
  );
}

function postText(pack: SocialContentPack | null): string {
  if (!pack) return "";
  const caption = markdownToPlain(pack.caption);
  const tags = pack.hashtags.slice(0, 30).join(" ");
  return tags ? `${caption}\n\n${tags}` : caption;
}

async function send(method: "POST" | "DELETE", body: Record<string, unknown>) {
  const res = await fetch("/api/social/schedule", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { pack?: SocialContentPack; error?: { message?: string } };
  if (!res.ok) throw new Error(json.error?.message ?? "That did not work.");
  return json;
}

export function SocialSchedule({
  posts: initial,
  blockers,
  connection,
  businessName,
  tokenConnected,
  tokenPages,
  loginBlocked,
  canEdit,
  canConnect,
  monthName,
  monthKey,
}: {
  posts: PackPost[];
  blockers: Record<string, string | null>;
  connection: ConnectionSummary;
  businessName: string | null;
  tokenConnected: boolean;
  tokenPages: string | null;
  /** Why Facebook sign-in cannot finish on this server, if it cannot. */
  loginBlocked: string | null;
  canEdit: boolean;
  canConnect: boolean;
  monthName: string;
  monthKey: string;
}) {
  const [posts, setPosts] = useState(initial);
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null);
  const stop = useRef(false);

  // The server refreshes the list after a connect or a Page change; follow it.
  useEffect(() => setPosts(initial), [initial]);

  const available = NETWORKS.filter((n) => connection[n.id].ok).map((n) => n.id);

  const setSchedule = (id: string, pack: SocialContentPack | undefined, status?: PackPost["status"]) =>
    setPosts((all) => all.map((p) => (p.id === id ? { ...p, pack: pack ?? p.pack, status: status ?? p.status } : p)));
  const entry = (id: string, value: string | null) => (m: Record<string, string>) => {
    const next = { ...m };
    if (value) next[id] = value; else delete next[id];
    return next;
  };

  async function run(id: string, what: string, action: () => Promise<{ pack?: SocialContentPack }>): Promise<boolean> {
    setBusy(entry(id, what));
    setErrors(entry(id, null));
    try {
      const res = await action();
      setSchedule(id, res.pack);
      return true;
    } catch (err) {
      setErrors(entry(id, err instanceof Error ? err.message : "Could not reach the server."));
      return false;
    } finally {
      setBusy(entry(id, null));
    }
  }

  const schedule = (id: string, at: string | null, networks: SocialNetworkId[]) =>
    run(id, at ? "schedule" : "now", () => send("POST", { topicId: id, networks, ...(at ? { at } : {}) }));
  const unschedule = (id: string) => run(id, "unschedule", () => send("DELETE", { topicId: id }));

  /*
   * Follow posts that are publishing, or about to.
   *
   * The worker writes the outcome to the post; this reads it back every few
   * seconds while one is due, so a person who pressed "Publish now" sees it
   * land (or fail, and why) without reloading. Idle otherwise.
   */
  const latest = useRef(posts);
  latest.current = posts;
  useEffect(() => {
    const timer = window.setInterval(async () => {
      const due = latest.current.filter((p) => {
        const s = p.pack?.schedule;
        return s && (s.status === "publishing" || (s.status === "scheduled" && Date.parse(s.at) <= Date.now() + 60_000));
      });
      if (!due.length || document.hidden) return;
      try {
        const res = await fetch(`/api/social/schedule?ids=${due.map((p) => p.id).join(",")}`);
        if (!res.ok) return;
        const body = (await res.json()) as { posts: { id: string; status: PackPost["status"]; schedule: PackSchedule | null }[] };
        setPosts((all) => all.map((p) => {
          const fresh = body.posts.find((f) => f.id === p.id);
          if (!fresh || !p.pack) return p;
          const pack = { ...p.pack };
          if (fresh.schedule) pack.schedule = fresh.schedule; else delete pack.schedule;
          return { ...p, status: fresh.status, pack };
        }));
      } catch {
        // The next tick tries again; a missed read changes nothing.
      }
    }, 5000);
    return () => window.clearInterval(timer);
  }, []);

  const states = posts.map((p) => stateOf(p, blockers[p.id] ?? null));
  const count = (s: CardState) => states.filter((x) => x === s).length;
  const ready = posts.filter((_, i) => states[i] === "ready");
  const openPost = posts.find((p) => p.id === openId) ?? null;

  async function scheduleAll(time: string, networks: SocialNetworkId[]) {
    setBulkOpen(false);
    const queue = ready
      .map((p) => ({ id: p.id, at: toIso(p.date, time) }))
      .filter((q): q is { id: string; at: string } => !!q.at && Date.parse(q.at) > Date.now() + 60_000);
    stop.current = false;
    setBulk({ done: 0, total: queue.length });
    for (const [i, q] of queue.entries()) {
      if (stop.current) break;
      const ok = await schedule(q.id, q.at, networks);
      setBulk({ done: i + 1, total: queue.length });
      if (!ok) break;
    }
    setBulk(null);
  }

  return (
    <>
      <ConnectionPanel
        connection={connection}
        businessName={businessName}
        tokenConnected={tokenConnected}
        tokenPages={tokenPages}
        loginBlocked={loginBlocked}
        canConnect={canConnect}
      />

      {posts.length === 0 ? (
        <div className="socal-empty">
          Nothing is on the calendar for {monthName} yet. Plan the month, then approve its copy and pictures.
          {" "}<Link href="/social">Plan it from the Topic Pool</Link>
        </div>
      ) : (
        <section className="spack" aria-label={`Schedule for ${monthName}`}>
          <div className="spack-summary">
            <div className="spack-progress" aria-hidden>
              <span className="spack-bar written" style={{ width: `${((count("scheduled") + count("publishing") + count("published") + count("partial")) / posts.length) * 100}%` }} />
              <span className="spack-bar approved" style={{ width: `${(count("published") / posts.length) * 100}%` }} />
            </div>
            <p>
              <strong>{posts.length}</strong> posts · <strong>{count("ready")}</strong> ready
              · <strong>{count("scheduled") + count("publishing")}</strong> scheduled
              · <strong>{count("published")}</strong> published
              {count("blocked") ? <span className="socal-muted"> · {count("blocked")} not ready</span> : null}
              {count("failed") + count("partial") ? <span className="ssched-bad"> · {count("failed") + count("partial")} need attention</span> : null}
            </p>
            {canEdit && ready.length > 0 ? (
              bulk ? (
                <div className="spack-bulk" role="status">
                  <span>Scheduling {Math.min(bulk.done + 1, bulk.total)} of {bulk.total}…</span>
                  <button type="button" className="btn small" onClick={() => { stop.current = true; }}>Stop after this one</button>
                </div>
              ) : (
                <button type="button" className="btn primary" disabled={!available.length || Object.keys(busy).length > 0}
                        title={available.length ? undefined : "Connect a network that can post first."}
                        onClick={() => setBulkOpen(true)}>
                  Schedule all {ready.length} ready
                </button>
              )
            ) : null}
          </div>

          {bulkOpen ? (
            <BulkDialog
              posts={ready}
              available={available}
              onSchedule={(time, networks) => void scheduleAll(time, networks)}
              onClose={() => setBulkOpen(false)}
            />
          ) : null}

          <ol className="spack-grid sipack-grid">
            {posts.map((p, i) => {
              const state = states[i]!;
              const s = p.pack?.schedule;
              const image = p.pack?.image;
              const working = busy[p.id];
              const blocker = blockers[p.id] ?? null;
              return (
                <li key={p.id} className={`sipack-card ssched-card state-${state}`}>
                  <button type="button" className="sipack-thumb" style={{ aspectRatio: "4 / 5" }} onClick={() => setOpenId(p.id)}
                          aria-label={`Open ${p.title}`}>
                    {image ? (
                      <img src={imageUrl(image.key)} alt={p.pack?.altText || p.title} />
                    ) : (
                      <span className="sipack-placeholder">No image yet</span>
                    )}
                  </button>
                  <div className="sipack-body">
                    <div className="spack-card-top">
                      <span className="sipack-day">{weekday(p.date)} {dateOf(p.date).getUTCDate()}</span>
                      <span className={`spack-status ssched-state ${state}`}>
                        {state === "publishing" || working ? <span className="spack-spin dark" aria-hidden /> : null}
                        {STATE_LABEL[state]}
                      </span>
                    </div>
                    <h3 className="spack-card-title">
                      <button type="button" onClick={() => setOpenId(p.id)}>{p.title}</button>
                    </h3>
                    {s ? (
                      <p className="ssched-when">
                        <When iso={s.at} />
                        <span className="ssched-marks">
                          {s.networks.map((n) => <NetworkMark key={n} id={n} result={s.results[n]?.status} />)}
                        </span>
                      </p>
                    ) : (
                      <p className="spack-card-meta">{p.format} · {p.audience}</p>
                    )}
                    {state === "blocked" && blocker ? <p className="ssched-why">{blocker}</p> : null}
                    {s && (state === "failed" || state === "partial") ? (
                      <p className="spack-card-error" title={failures(s)}>{failures(s)}</p>
                    ) : null}
                    {canConnect && s?.status === "publishing" ? <SocialPublishRecovery topicId={p.id} schedule={s} onSaved={pack => setSchedule(p.id, pack, pack.schedule?.status === "published" ? "published" : undefined)} /> : null}
                    {errors[p.id] ? <p className="spack-card-error" title={errors[p.id]}>{errors[p.id]}</p> : null}
                    <div className="spack-card-actions">
                      {state === "blocked" && !fixableHere(blocker) ? (
                        <button type="button" className="btn small" onClick={() => setOpenId(p.id)}>Why not?</button>
                      ) : state === "blocked" ? (
                        <Link className="btn small" href={blockerLink(blocker, monthKey)}>{blockerAction(blocker)}</Link>
                      ) : state === "published" ? (
                        <button type="button" className="btn small" onClick={() => setOpenId(p.id)}>View</button>
                      ) : canEdit && state === "ready" ? (
                        <button type="button" className="btn primary small" disabled={!!working || !!bulk || !available.length}
                                onClick={() => setOpenId(p.id)}>Schedule</button>
                      ) : canEdit && state === "scheduled" ? (
                        <>
                          <button type="button" className="btn small" disabled={!!working} onClick={() => setOpenId(p.id)}>Change</button>
                          <button type="button" className="btn small" disabled={!!working} onClick={() => void unschedule(p.id)}>
                            {working === "unschedule" ? "…" : "Unschedule"}
                          </button>
                        </>
                      ) : canEdit && (state === "failed" || state === "partial") ? (
                        <button type="button" className="btn primary small" disabled={!!working} onClick={() => setOpenId(p.id)}>Try again</button>
                      ) : (
                        <button type="button" className="btn small" onClick={() => setOpenId(p.id)}>Open</button>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>

          <p className="spack-next">
            Posts go out from the server at their time, whether or not this page is open. A scheduled post&apos;s copy and
            picture are locked until it is unscheduled. Carousels and videos are not published from here yet.
          </p>
        </section>
      )}

      {openPost ? (
        <ScheduleDialog
          key={openPost.id}
          post={openPost}
          state={stateOf(openPost, blockers[openPost.id] ?? null)}
          blocker={blockers[openPost.id] ?? null}
          connection={connection}
          canEdit={canEdit}
          working={busy[openPost.id] ?? null}
          error={errors[openPost.id] ?? null}
          monthKey={monthKey}
          onSchedule={(at, networks) => void schedule(openPost.id, at, networks)}
          onUnschedule={() => void unschedule(openPost.id)}
          onClose={() => setOpenId(null)}
        />
      ) : null}
    </>
  );
}

function failures(s: PackSchedule): string {
  return s.networks
    .flatMap((n) => (s.results[n]?.status === "failed" ? [`${NAME[n]}: ${s.results[n]!.error ?? "failed"}`] : []))
    .join(" ");
}

function blockerLink(blocker: string | null, monthKey: string): string {
  return blocker?.includes("step 3") ? `/social/content?month=${monthKey}` : `/social/images?month=${monthKey}`;
}
function blockerAction(blocker: string | null): string {
  return blocker?.includes("step 3") ? "Approve copy in step 3" : "Finish image in step 4";
}
/** Whether an earlier step can clear the blocker. A format this tool cannot publish, no step can. */
function fixableHere(blocker: string | null): boolean {
  return !!blocker && (blocker.includes("step 3") || blocker.includes("step 4"));
}

function NetworkMark({ id, result }: { id: SocialNetworkId; result?: "published" | "failed" }) {
  return (
    <span className={`ssched-mark ${id} ${result ?? ""}`} title={`${NAME[id]}${result ? `: ${result}` : ""}`}>
      {NETWORKS.find((n) => n.id === id)!.mark}
    </span>
  );
}

function ConnectionPanel({
  connection, businessName, tokenConnected, tokenPages, loginBlocked, canConnect,
}: {
  connection: ConnectionSummary;
  businessName: string | null;
  tokenConnected: boolean;
  tokenPages: string | null;
  loginBlocked: string | null;
  canConnect: boolean;
}) {
  const needsReconnect = [connection.facebook.reason, connection.instagram.reason].some((r) => r?.startsWith("Reconnect"));
  return (
    <section className="ssched-connect" aria-label="Where posts publish">
      <div className="ssched-connect-main">
        <h3>Where posts go</h3>
        <p className="ssched-connect-sub">
          {connection.connected
            ? connection.pageName
              ? <>Posting as <b>{connection.pageName}</b>{connection.instagramLinked ? " and its Instagram account" : ""}.</>
              : <>Connected. Choose which Page is {businessName ?? "this client"}&apos;s.</>
            : "Connect the Facebook account that manages this client's Page. Its linked Instagram account posts too."}
        </p>
        <ul className="ssched-networks">
          {NETWORKS.map((n) => {
            const r = connection[n.id];
            return (
              <li key={n.id} className={r.ok ? "ok" : "no"}>
                <span className={`ssched-mark ${n.id}`} aria-hidden>{n.mark}</span>
                <span>
                  <strong>{n.label}</strong>
                  <small>{r.ok ? "Ready to post" : r.reason}</small>
                </span>
              </li>
            );
          })}
        </ul>
        <p className="ssched-connect-how">
          These show where posts can go. To post, click <b>Schedule</b> on a ready post below, then choose the
          networks and a time, or publish now.
        </p>
      </div>
      {canConnect ? (
        <div className="ssched-connect-side">
          {loginBlocked ? (
            <p className="metalogin-note">{loginBlocked}</p>
          ) : (
            <a className={`btn ${connection.connected && !needsReconnect ? "small" : "primary"}`}
               href="/api/integrations/meta/start?return=/social/schedule">
              {connection.connected ? "Reconnect Facebook & Instagram" : "Connect Facebook & Instagram"}
            </a>
          )}
          <MetaTokenConnect connected={tokenConnected && !needsReconnect} pageNames={tokenPages} defaultOpen={!!loginBlocked} offerToken={!!loginBlocked} />
          {connection.connected ? <MetaPagePicker businessName={businessName} /> : null}
        </div>
      ) : (
        <p className="ssched-connect-side small muted">An admin connects the accounts.</p>
      )}
    </section>
  );
}

function NetworkChoice({
  connection, chosen, results, disabled, onChange,
}: {
  connection: ConnectionSummary;
  chosen: SocialNetworkId[];
  results?: PackSchedule["results"];
  disabled: boolean;
  onChange: (next: SocialNetworkId[]) => void;
}) {
  return (
    <div className="ssched-choice" role="group" aria-label="Networks">
      {NETWORKS.map((n) => {
        const r = connection[n.id];
        const done = results?.[n.id]?.status === "published";
        return (
          <label key={n.id} className={`ssched-net ${r.ok || done ? "" : "off"}`}>
            <input
              type="checkbox"
              checked={done || chosen.includes(n.id)}
              disabled={disabled || done || !r.ok}
              onChange={(e) => onChange(e.target.checked ? [...chosen, n.id] : chosen.filter((c) => c !== n.id))}
            />
            <span className={`ssched-mark ${n.id}`} aria-hidden>{n.mark}</span>
            <span>
              <strong>{n.label}</strong>
              <small>{done ? "Already published" : r.ok ? "Ready" : r.reason}</small>
            </span>
          </label>
        );
      })}
    </div>
  );
}

function useModal(onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  return {
    ref,
    close: () => ref.current?.close(),
    props: {
      ref,
      onClose,
      onClick: (e: React.MouseEvent) => { if (e.target === ref.current) ref.current?.close(); },
    },
  };
}

function ScheduleDialog({
  post, state, blocker, connection, canEdit, working, error, monthKey, onSchedule, onUnschedule, onClose,
}: {
  post: PackPost;
  state: CardState;
  blocker: string | null;
  connection: ConnectionSummary;
  canEdit: boolean;
  working: string | null;
  error: string | null;
  monthKey: string;
  onSchedule: (at: string | null, networks: SocialNetworkId[]) => void;
  onUnschedule: () => void;
  onClose: () => void;
}) {
  const modal = useModal(onClose);
  const s = post.pack?.schedule;
  const [when, setWhen] = useState(() => defaultWhen(post));
  const [chosen, setChosen] = useState<SocialNetworkId[]>(() => {
    const ok = NETWORKS.filter((n) => connection[n.id].ok).map((n) => n.id);
    if (!s) return ok;
    // Retrying: what failed, where it can still post.
    return s.networks.filter((n) => s.results[n]?.status !== "published" && ok.includes(n));
  });
  const [zone, setZone] = useState("");
  useEffect(() => setZone(Intl.DateTimeFormat().resolvedOptions().timeZone), []);

  const image = post.pack?.image;
  const text = postText(post.pack);
  const at = toIso(when.date, when.time);
  const past = !at || Date.parse(at) < Date.now() + 60_000;
  const editable = canEdit && (state === "ready" || state === "scheduled" || state === "failed" || state === "partial");
  const nothingPublished = !s || !Object.values(s.results).some((r) => r?.status === "published");

  return (
    <dialog {...modal.props} className="spack-dialog" aria-labelledby="ssched-dialog-title">
      <div className="spack-dialog-inner">
        <header className="spd-head">
          <span className="spd-date">{chipDate(post.date)}</span>
          <div className="spd-titlebox">
            <h3 id="ssched-dialog-title">{post.title}</h3>
            <div className="spd-pills">
              <span className="spd-aud">{post.audience}</span>
              <span className="spd-fmt">{post.format}</span>
              {post.occasion ? <span className="spd-occ"><PinIcon /> {post.occasion}</span> : null}
            </div>
          </div>
          <div className="spd-side">
            <span className={`spack-status ssched-state ${state}`}>{STATE_LABEL[state]}</span>
            <button type="button" className="socal-pop-close" aria-label="Close" onClick={modal.close}>×</button>
          </div>
        </header>

        <div className="spack-dialog-scroll">
          {state === "blocked" && blocker ? (
            <p className="sipack-waiting">
              <span aria-hidden>🔒</span> {blocker}{" "}
              {fixableHere(blocker) ? <Link href={blockerLink(blocker, monthKey)}>{blockerAction(blocker)}</Link> : null}
            </p>
          ) : null}
          {error ? <p className="error">{error}</p> : null}

          <div className="sipack-layout">
            <div className="sipack-left">
              <div className="sipack-preview" style={{ aspectRatio: cssRatio(post.format) }}>
                {image ? (
                  <img src={imageUrl(image.key)} alt={post.pack?.altText || post.title} />
                ) : (
                  <span className="sipack-placeholder">No image yet</span>
                )}
              </div>
            </div>

            <div className="sipack-right">
              {s && Object.keys(s.results).length ? (
                <Section label="What happened">
                  <ul className="ssched-results">
                    {s.networks.map((n) => {
                      const r = s.results[n];
                      if (!r) return null;
                      return (
                        <li key={n} className={r.status}>
                          <span className={`ssched-mark ${n}`} aria-hidden>{NETWORKS.find((x) => x.id === n)!.mark}</span>
                          <span>
                            <strong>{NAME[n]}: {r.status === "published" ? "published" : "failed"}</strong>{" "}
                            <small><When iso={r.at} /></small>
                            {r.status === "published" && r.url ? (
                              <> · <a href={r.url} target="_blank" rel="noreferrer">View post</a></>
                            ) : null}
                            {r.error ? <small className="ssched-err">{r.error}</small> : null}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </Section>
              ) : null}

              {editable ? (
                <Section label="When" hint={zone ? `Your time zone: ${zone}.` : undefined}>
                  <div className="ssched-when-inputs">
                    {/* Widths inline: the global input rule outranks any class selector. */}
                    <input type="date" className="spd-input" value={when.date} aria-label="Date" style={{ width: "11rem" }}
                           disabled={!!working} onChange={(e) => setWhen({ ...when, date: e.target.value })} />
                    <input type="time" className="spd-input" value={when.time} aria-label="Time" step={300} style={{ width: "8.5rem" }}
                           disabled={!!working} onChange={(e) => setWhen({ ...when, time: e.target.value })} />
                    {when.date !== post.date ? (
                      <span className="ssched-off">The calendar has it on {chipDate(post.date)}.</span>
                    ) : null}
                  </div>
                  {past ? <p className="ssched-bad small">That time has passed. Pick a later one, or publish now.</p> : null}
                </Section>
              ) : s ? (
                <Section label="When"><p className="sipack-text"><When iso={s.at} /></p></Section>
              ) : null}

              {editable ? (
                <Section label="Where">
                  <NetworkChoice connection={connection} chosen={chosen} results={s?.results} disabled={!!working} onChange={setChosen} />
                </Section>
              ) : null}

              <Section label="Caption as it will post" copy={text}
                       aside={<span className="ssched-count">{text.length.toLocaleString()} / 2,200</span>}>
                <p className="sipack-text pre ssched-caption">{text || "No caption."}</p>
              </Section>
            </div>
          </div>
        </div>

        <footer className="spd-foot">
          <p>
            {state === "scheduled" && s ? <>Goes out <When iso={s.at} />. Unschedule to change the copy or picture.</>
              : state === "published" ? "Published. Edit or delete it on Facebook or Instagram if it needs to change."
              : "Publishes the approved copy and picture, exactly as shown."}
          </p>
          {editable ? (
            <div className="ssched-foot-buttons">
              {state === "scheduled" && nothingPublished ? (
                <button type="button" className="btn small" disabled={!!working} onClick={onUnschedule}>
                  {working === "unschedule" ? "Unscheduling…" : "Unschedule"}
                </button>
              ) : null}
              <button type="button" className="btn small" disabled={!!working || !chosen.length} onClick={() => onSchedule(null, chosen)}>
                {working === "now" ? "Sending…" : "Publish now"}
              </button>
              <button type="button" className="btn primary" disabled={!!working || !chosen.length || past}
                      onClick={() => onSchedule(at, chosen)}>
                {working === "schedule" ? "Scheduling…" : state === "scheduled" ? "Save new time" : "Schedule"}
              </button>
            </div>
          ) : null}
        </footer>
      </div>
    </dialog>
  );
}

function BulkDialog({
  posts, available, onSchedule, onClose,
}: {
  posts: PackPost[];
  available: SocialNetworkId[];
  onSchedule: (time: string, networks: SocialNetworkId[]) => void;
  onClose: () => void;
}) {
  const modal = useModal(onClose);
  const [time, setTime] = useState(DEFAULT_TIME);
  const [chosen, setChosen] = useState<SocialNetworkId[]>(available);
  const [now, setNow] = useState(0);
  useEffect(() => setNow(Date.now()), []);
  const late = posts.filter((p) => {
    const at = toIso(p.date, time);
    return !at || Date.parse(at) <= now + 60_000;
  });
  const going = posts.length - late.length;

  return (
    <dialog {...modal.props} className="spack-dialog ssched-bulk" aria-labelledby="ssched-bulk-title">
      <div className="spack-dialog-inner">
        <header className="spd-head">
          <div className="spd-titlebox">
            <h3 id="ssched-bulk-title">Schedule {posts.length} ready post{posts.length === 1 ? "" : "s"}</h3>
          </div>
          <div className="spd-side">
            <button type="button" className="socal-pop-close" aria-label="Close" onClick={modal.close}>×</button>
          </div>
        </header>
        <div className="spack-dialog-scroll">
          <Section label="Time of day" hint="Each post goes out on its calendar date at this time, in your time zone.">
            <input type="time" className="spd-input ssched-time" value={time} step={300} aria-label="Time" style={{ width: "8.5rem" }}
                   onChange={(e) => setTime(e.target.value)} />
          </Section>
          <Section label="Where">
            <div className="ssched-choice" role="group" aria-label="Networks">
              {NETWORKS.filter((n) => available.includes(n.id)).map((n) => (
                <label key={n.id} className="ssched-net">
                  <input type="checkbox" checked={chosen.includes(n.id)}
                         onChange={(e) => setChosen(e.target.checked ? [...chosen, n.id] : chosen.filter((c) => c !== n.id))} />
                  <span className={`ssched-mark ${n.id}`} aria-hidden>{n.mark}</span>
                  <span><strong>{n.label}</strong></span>
                </label>
              ))}
            </div>
          </Section>
          {late.length ? (
            <p className="ssched-off">
              {late.length === posts.length ? "All of them are" : `${late.length} of them ${late.length === 1 ? "is" : "are"}`} dated
              {" "}at or before now, so {late.length === 1 ? "it is" : "they are"} left out. Schedule {late.length === 1 ? "it" : "those"} one by one.
            </p>
          ) : null}
        </div>
        <footer className="spd-foot">
          <p>{going} post{going === 1 ? "" : "s"} will be scheduled.</p>
          <button type="button" className="btn primary" disabled={!going || !chosen.length} onClick={() => onSchedule(time, chosen)}>
            Schedule {going}
          </button>
        </footer>
      </div>
    </dialog>
  );
}
