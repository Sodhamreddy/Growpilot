"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  monthGrid, audienceTones, monthName as labelOf, dragBlocker, dropBlocker, offObservance, type GridDay,
} from "@/lib/social-calendar";
import { SocialMonthNav } from "./SocialMonthNav";

/**
 * A month of social posts on a wall-calendar grid, rearranged by dragging.
 *
 * Each day shows the observances the planner found for it, then the posts
 * scheduled on it. Observances are drawn only from what the pool and the month
 * already hold. There is no holiday feed behind this, and inventing one here
 * would put days on the calendar that nothing checked.
 *
 * Moves are held here until confirmed. A month is arranged as a whole, and
 * saving each drop as it happens would write half-finished arrangements and
 * make "undo" a series of requests. Confirming saves the dates and hands the
 * month to step 3, which writes its content packs.
 *
 * Every drag has a keyboard and touch equivalent: the post's detail has a
 * "Move to" picker, because native drag and drop is mouse-only.
 */

export interface CalendarPost {
  id: string;
  /** Day of the month. */
  day: number;
  title: string;
  hook: string;
  audience: string;
  format: string;
  imageIdea: string;
  occasion: string | null;
  dateRule: string | null;
  status: string;
  categoryName: string;
  /** Written copy, once the writing prompt has run. */
  caption: string | null;
  hashtags: string[];
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Shown on a card only past "scheduled", which every post on the grid is at least. */
const STATUS_LABEL: Record<string, string> = {
  written: "Written",
  approved: "Approved",
  published: "Published",
};

const isoOf = (monthKey: string, day: number) => `${monthKey}-${String(day).padStart(2, "0")}`;

export function SocialCalendar({
  monthKey,
  currentMonthKey,
  todayIso,
  planned,
  posts,
  occasions,
  monthLong,
  audiences,
  emptyNote,
  canEdit,
}: {
  /** The month on screen, "2026-10". */
  monthKey: string;
  /** The month today falls in, for the jump-back link. */
  currentMonthKey: string;
  /** "YYYY-MM-DD" in UTC, to mark today's square and refuse past days. */
  todayIso: string;
  /** Whether a month row exists, i.e. the calendar was committed. */
  planned: boolean;
  posts: CalendarPost[];
  /** Day of the month → observance names. */
  occasions: Record<number, string[]>;
  /** Observances that run the whole month rather than a day. */
  monthLong: string[];
  /** Every audience in the business's pool, so colours hold across months. */
  audiences: string[];
  /** Why the grid is empty, and what to do about it. Null when it is not. */
  emptyNote: React.ReactNode;
  canEdit: boolean;
}) {
  const router = useRouter();
  const name = labelOf(monthKey);
  const monthName = name.split(" ")[0]!;
  const tones = audienceTones([...audiences, ...posts.map((p) => p.audience)]);

  /** Post id → the day it has been dragged to, until confirmed. */
  const [moves, setMoves] = useState<Record<string, number>>({});
  const [dragId, setDragId] = useState<string | null>(null);
  const [overDay, setOverDay] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fresh data from the server means the saved arrangement is now the real one.
  useEffect(() => { setMoves({}); }, [posts]);

  const movedCount = Object.keys(moves).length;

  // Leaving with unsaved moves loses them, so say so.
  useEffect(() => {
    if (!movedCount) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [movedCount]);

  const placed = posts.map((p) => ({ ...p, day: moves[p.id] ?? p.day, moved: p.id in moves }));
  const byDay = new Map<number, typeof placed>();
  for (const p of placed) byDay.set(p.day, [...(byDay.get(p.day) ?? []), p]);

  const unwritten = posts.filter((p) => p.status === "scheduled").length;
  const movedWithCopy = posts.filter((p) => p.id in moves && p.status === "written").length;
  // Posts sitting off their one-day observance. Allowed, but said out loud.
  const offDays = new Map<string, number>();
  for (const p of placed) {
    const day = offObservance(p, occasions);
    if (day) offDays.set(p.id, day);
  }
  const offDay = placed.filter((p) => p.moved && offDays.has(p.id)).map((p) => ({ post: p, day: offDays.get(p.id)! }));
  const onObservance = posts.filter((p) => p.occasion).length;
  // The legend lists only who this month is written for, in colour order.
  const legend = [...new Set(posts.map((p) => p.audience))]
    .sort((a, b) => (tones.get(a) ?? 0) - (tones.get(b) ?? 0));

  const canDrop = (day: number) => !dropBlocker(isoOf(monthKey, day), { monthKey, todayIso });

  function move(id: string, day: number) {
    const original = posts.find((p) => p.id === id);
    if (!original || !canDrop(day)) return;
    setError(null);
    setMoves((m) => {
      const next = { ...m };
      // Dragged back where it started is no move at all.
      if (original.day === day) delete next[id]; else next[id] = day;
      return next;
    });
  }

  async function confirm(write: boolean) {
    setSaving(true);
    setError(null);
    try {
      if (movedCount) {
        const res = await fetch("/api/social/calendar", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            moves: Object.entries(moves).map(([topicId, day]) => ({ topicId, date: isoOf(monthKey, day) })),
          }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
          setError(body.error?.message ?? "The new dates could not be saved.");
          setSaving(false);
          return;
        }
      }
      if (write) {
        router.push(`/social/content?month=${monthKey}&write=all`);
      } else {
        router.refresh();
        setSaving(false);
      }
    } catch {
      setError("Could not reach the server.");
      setSaving(false);
    }
  }

  return (
    <section className="socal-wrap" aria-labelledby="socal-title">
      <SocialMonthNav monthKey={monthKey} currentMonthKey={currentMonthKey} basePath="/social/calendar" titleId="socal-title">
        <span className={`socal-status${planned ? " planned" : ""}`}>{planned ? "Planned" : "Not planned"}</span>
        <span><strong>{posts.length}</strong> post{posts.length === 1 ? "" : "s"}</span>
        {posts.length ? <span className="socal-muted">{onObservance} on an observance</span> : null}
      </SocialMonthNav>

      {monthLong.length ? (
        <p className="socal-monthlong"><b>All month</b> {monthLong.join(" · ")}</p>
      ) : null}

      {emptyNote ? <div className="socal-empty">{emptyNote}</div> : null}

      {canEdit && posts.length > 0 ? (
        <div className={`socal-confirm${movedCount ? " pending" : ""}`} role="status">
          <p>
            {movedCount ? (
              <>
                <strong>{movedCount} post{movedCount === 1 ? "" : "s"} moved.</strong> Not saved until you confirm.
                {movedWithCopy ? (
                  <span className="socal-muted">
                    {" "}{movedWithCopy} already {movedWithCopy === 1 ? "has" : "have"} copy written for the old date;
                    rewrite it in step 3 if it mentions the day.
                  </span>
                ) : null}
                {offDay.map(({ post, day }) => (
                  <span key={post.id} className="socal-offday">
                    {post.occasion} is on {monthName} {day}; this post will run on {monthName} {post.day} instead.
                  </span>
                ))}
              </>
            ) : unwritten ? (
              <>Drag posts to change their day. When the month looks right, confirm it and the content packs are written.</>
            ) : (
              <>Every post has its content pack. Drag a post to change its day.</>
            )}
          </p>
          <div className="socal-confirm-actions">
            {movedCount ? (
              <button type="button" className="btn small" disabled={saving} onClick={() => setMoves({})}>Undo moves</button>
            ) : null}
            {movedCount && unwritten ? (
              <button type="button" className="btn small" disabled={saving} onClick={() => void confirm(false)}>
                Save dates only
              </button>
            ) : null}
            {unwritten ? (
              <button type="button" className="btn primary" disabled={saving} onClick={() => void confirm(true)}>
                {saving ? "Saving…" : `Confirm calendar & write ${unwritten} content pack${unwritten === 1 ? "" : "s"}`}
              </button>
            ) : movedCount ? (
              <button type="button" className="btn primary" disabled={saving} onClick={() => void confirm(false)}>
                {saving ? "Saving…" : "Save new dates"}
              </button>
            ) : null}
          </div>
          {error ? <p className="error">{error}</p> : null}
        </div>
      ) : null}

      <div className={`socal${dragId ? " dragging" : ""}`}>
        <div className="socal-band" aria-hidden><span>{name}</span></div>
        <div className="socal-scroll">
          <div className="socal-main">
            <div className="socal-head" aria-hidden>
              {WEEKDAYS.map((d) => <span key={d}>{d}</span>)}
            </div>
            <div className="socal-grid">
              {monthGrid(monthKey).flat().map((cell, i) =>
                cell ? (
                  <DayCell
                    key={cell.iso}
                    cell={cell}
                    monthKey={monthKey}
                    monthName={monthName}
                    todayIso={todayIso}
                    occasions={occasions[cell.day] ?? []}
                    posts={byDay.get(cell.day) ?? []}
                    tones={tones}
                    canEdit={canEdit && !saving}
                    dragging={dragId !== null}
                    droppable={canDrop(cell.day)}
                    over={overDay === cell.day}
                    onDragStart={(id) => setDragId(id)}
                    onDragEnd={() => { setDragId(null); setOverDay(null); }}
                    onDragOver={() => setOverDay(cell.day)}
                    onDrop={(id) => { move(id, cell.day); setDragId(null); setOverDay(null); }}
                    onMove={move}
                    draggingId={dragId}
                    offDays={offDays}
                  />
                ) : (
                  <div key={`pad-${i}`} className="socal-cell pad" aria-hidden />
                ),
              )}
            </div>
          </div>
        </div>
      </div>

      {legend.length ? (
        <ul className="socal-legend" aria-label="Audiences">
          {legend.map((a) => (
            <li key={a} className={`tone-${tones.get(a) ?? 0}`}><span className="socal-dot" aria-hidden />{a}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

type PlacedPost = CalendarPost & { moved: boolean };

function DayCell({
  cell, monthKey, monthName, todayIso, occasions, posts, tones,
  canEdit, dragging, droppable, over, draggingId, offDays,
  onDragStart, onDragEnd, onDragOver, onDrop, onMove,
}: {
  /** Post id → the day of the observance it has been moved off. */
  offDays: Map<string, number>;
  cell: GridDay;
  monthKey: string;
  monthName: string;
  todayIso: string;
  occasions: string[];
  posts: PlacedPost[];
  tones: Map<string, number>;
  canEdit: boolean;
  dragging: boolean;
  droppable: boolean;
  over: boolean;
  draggingId: string | null;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onDragOver: () => void;
  onDrop: (id: string) => void;
  onMove: (id: string, day: number) => void;
}) {
  const weekend = cell.weekday === 0 || cell.weekday === 6;
  const today = cell.iso === todayIso;
  const longDate = `${WEEKDAYS_LONG[cell.weekday]}, ${monthName} ${cell.day}`;
  const cls = ["socal-cell"];
  if (weekend) cls.push("weekend");
  if (today) cls.push("today");
  // Nothing on it. Hidden in the phone list, where an empty row is just scroll.
  if (!occasions.length && !posts.length) cls.push("bare");
  if (dragging) cls.push(droppable ? "drop-ok" : "drop-no");
  if (over && droppable) cls.push("drop-over");

  return (
    <div
      className={cls.join(" ")}
      onDragOver={(e) => {
        if (!dragging || !droppable) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        onDragOver();
      }}
      onDrop={(e) => {
        e.preventDefault();
        const id = e.dataTransfer.getData("text/plain") || draggingId;
        if (id && droppable) onDrop(id);
      }}
    >
      <div className="socal-daynum">
        {/* Visible as the row heading on a phone; read aloud everywhere. */}
        <span className="socal-wd">{WEEKDAYS_LONG[cell.weekday]}, {monthName} </span>
        <span className="socal-n">{cell.day}</span>
        {today ? <span className="socal-todaytag">Today</span> : null}
      </div>

      {occasions.length ? <p className="socal-occ">{occasions.join(" · ")}</p> : null}

      {posts.length ? (
        <ul className="socal-posts">
          {posts.map((p) => {
            const id = `socal-post-${p.id}`;
            const status = STATUS_LABEL[p.status];
            const pinned = dragBlocker(p);
            const movable = canEdit && !pinned;
            const open = () => (document.getElementById(id) as HTMLElement & { showPopover?: () => void })?.showPopover?.();
            const cardCls = ["socal-post", `tone-${tones.get(p.audience) ?? 0}`];
            if (p.moved) cardCls.push("moved");
            if (draggingId === p.id) cardCls.push("is-dragging");
            if (movable) cardCls.push("movable");
            return (
              <li key={p.id}>
                <div
                  role="button"
                  tabIndex={0}
                  className={cardCls.join(" ")}
                  draggable={movable}
                  title={canEdit && pinned ? pinned : undefined}
                  aria-haspopup="dialog"
                  onClick={open}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
                  }}
                  onDragStart={(e) => {
                    e.dataTransfer.setData("text/plain", p.id);
                    e.dataTransfer.effectAllowed = "move";
                    onDragStart(p.id);
                  }}
                  onDragEnd={onDragEnd}
                >
                  <span className="socal-dot" aria-hidden />
                  <span className="socal-post-body">
                    <span className="socal-post-title">{p.title}</span>
                    <span className="socal-post-meta">
                      {p.format} · {p.audience}{status ? ` · ${status}` : ""}{p.moved ? " · Moved" : ""}
                    </span>
                  </span>
                  {canEdit && pinned ? <PinIcon /> : null}
                </div>
                <PostDetail
                  id={id}
                  post={p}
                  longDate={longDate}
                  tone={tones.get(p.audience) ?? 0}
                  canEdit={canEdit}
                  pinned={pinned}
                  monthKey={monthKey}
                  todayIso={todayIso}
                  observanceDay={offDays.get(p.id) ?? null}
                  monthName={monthName}
                  onMove={(day) => {
                    onMove(p.id, day);
                    (document.getElementById(id) as HTMLElement & { hidePopover?: () => void })?.hidePopover?.();
                  }}
                />
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

function PinIcon() {
  return (
    <svg className="socal-pin" width="12" height="12" viewBox="0 0 20 20" fill="none" aria-hidden>
      <path d="M7 2.5h6l-1 5 3 3H5l3-3-1-5ZM10 10.5V17" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Everything the card had no room for, and the keyboard way to move it.
 *
 * The hook is the post's actual argument, and a title alone is not enough to
 * judge a post by: two topics can share one and say different things.
 */
function PostDetail({
  id, post, longDate, tone, canEdit, pinned, monthKey, todayIso, observanceDay, monthName, onMove,
}: {
  id: string;
  post: PlacedPost;
  longDate: string;
  tone: number;
  canEdit: boolean;
  pinned: string | null;
  monthKey: string;
  todayIso: string;
  /** The observance's own day, when the post has been moved off it. */
  observanceDay: number | null;
  monthName: string;
  onMove: (day: number) => void;
}) {
  const [y, m] = monthKey.split("-").map(Number);
  const days = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  const options = Array.from({ length: days }, (_, i) => i + 1)
    .filter((d) => d === post.day || !dropBlocker(isoOf(monthKey, d), { monthKey, todayIso }));

  return (
    <div id={id} popover="auto" className="socal-pop" role="dialog" aria-labelledby={`${id}-title`}>
      <div className="socal-pop-head">
        <span className="socal-pop-date">{longDate}{post.occasion ? ` · ${post.occasion}` : ""}</span>
        <button type="button" className="socal-pop-close" popoverTarget={id} popoverTargetAction="hide"
                aria-label="Close">×</button>
      </div>
      <h3 id={`${id}-title`}>{post.title}</h3>
      <div className="socal-pop-tags">
        <span className={`socal-pop-aud tone-${tone}`}><span className="socal-dot" aria-hidden />{post.audience}</span>
        <span>{post.format}</span>
        <span>{post.categoryName}</span>
        <span>{STATUS_LABEL[post.status] ?? "Scheduled"}</span>
      </div>
      <p className="socal-pop-hook">{post.hook}</p>
      {post.imageIdea ? <p className="socal-pop-line"><b>Image</b> {post.imageIdea}</p> : null}
      {post.dateRule ? <p className="socal-pop-line"><b>Date rule</b> {post.dateRule}</p> : null}
      {observanceDay ? (
        <p className="socal-pop-line socal-offday">
          {post.occasion} is on {monthName} {observanceDay}. This post runs on {monthName} {post.day}.
        </p>
      ) : null}
      {post.caption ? (
        <div className="socal-pop-copy">
          <b>Caption</b>
          <p>{post.caption}</p>
          {post.hashtags.length ? <p className="socal-pop-tagsline">{post.hashtags.join(" ")}</p> : null}
        </div>
      ) : null}
      {canEdit ? (
        pinned ? (
          <p className="socal-pop-line socal-pop-pinned"><b>Date</b> {pinned}</p>
        ) : (
          <label className="socal-pop-move">
            <b>Move to</b>
            <select value={post.day} onChange={(e) => onMove(Number(e.target.value))}>
              {options.map((d) => {
                const weekday = WEEKDAYS[new Date(`${isoOf(monthKey, d)}T12:00:00Z`).getUTCDay()];
                return <option key={d} value={d}>{weekday} {d}</option>;
              })}
            </select>
          </label>
        )
      ) : null}
    </div>
  );
}
