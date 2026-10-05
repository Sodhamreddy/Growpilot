"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { IconCalendar } from "./Icons";

/**
 * Plan next month, in the last week of this one.
 *
 * The banner leads the page from the 24th, because that is when the work
 * actually happens: a month planned on the 24th leaves a week to review the
 * layout and write the posts before the 1st. Planning on the 10th would be
 * planning a month that is already a third gone.
 *
 * Preview before commit. The layout can be wrong in ways only a person
 * notices — one audience taking over, a fortnight with nothing in it — and
 * those are cheaper to see before the month is written than after.
 */

export interface PlanSlot {
  topicId: string;
  title: string;
  date: string;
  occasion: string | null;
  audience: string;
  format: string;
  categoryName: string;
  anchored: boolean;
}

interface Plan {
  monthKey: string;
  slots: PlanSlot[];
  tally: {
    total: number;
    anchored: number;
    filled: number;
    byAudience: Record<string, number>;
    byFormat: Record<string, number>;
  };
  warnings: string[];
}

export function PlanMonthBanner({
  businessId,
  monthKey,
  monthName,
  daysUntil,
  daysLeft,
  alreadyPlanned,
  plannedMonthId,
  canEdit,
}: {
  businessId: string;
  monthKey: string;
  monthName: string;
  /** Days until the month starts. Negative when it is already running. */
  daysUntil: number;
  /** Days still available to post into. */
  daysLeft: number;
  alreadyPlanned: boolean;
  /** The committed month's id, when there is one. Null before it is planned. */
  plannedMonthId: string | null;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [plan, setPlan] = useState<Plan | null>(null);
  /** Written posts a replan keeps in place, from the last preview. */
  const [kept, setKept] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Whether the unschedule confirmation is showing. */
  const [confirming, setConfirming] = useState(false);

  async function call(mode: "preview" | "commit") {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/social/calendar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, monthKey, mode }),
      });
      const body: unknown = await res.json();
      if (!res.ok) {
        setError((body as { error?: { message?: string } }).error?.message ?? "That did not work.");
        return;
      }
      if (mode === "preview") {
        setPlan((body as { plan: Plan }).plan);
        setKept((body as { kept?: number }).kept ?? 0);
      } else {
        setPlan(null);
        router.refresh();
      }
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Return a committed month's posts to the pool.
   *
   * The route behind this was written with the calendar and never called: no
   * component anywhere used DELETE on it. That left a real dead end, because
   * rejecting a scheduled topic is refused with "remove it from the calendar
   * first" — advice for a control that did not exist. A bad topic in a
   * committed month could not be rejected, edited out, or escaped, short of
   * replanning the whole month over the top of it.
   */
  async function unschedule() {
    if (!plannedMonthId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/social/calendar", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ monthId: plannedMonthId }),
      });
      const body: unknown = await res.json();
      if (!res.ok) {
        setError((body as { error?: { message?: string } }).error?.message ?? "That did not work.");
        return;
      }
      setPlan(null);
      setConfirming(false);
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  /*
   * Say what it means for the reader, not what is true of the calendar.
   *
   * "already running" was accurate and useless: it described the month rather
   * than the decision. What matters is how many days are left to post into,
   * because that is what decides whether planning it is worth doing.
   */
  const when = daysUntil > 1
    ? `Starts in ${daysUntil} days`
    : daysUntil === 1
      ? "Starts tomorrow"
      : daysUntil === 0
        ? "Starts today"
        : `${daysLeft} day${daysLeft === 1 ? "" : "s"} left in the month`;

  return (
    <div className={`planbanner${alreadyPlanned ? " done" : ""}`}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center", gap: 16 }}>
        <div className="row" style={{ gap: 12, alignItems: "center", minWidth: 0 }}>
          <span className="planbanner-icon" aria-hidden><IconCalendar size={18} /></span>
          <div style={{ minWidth: 0 }}>
            <strong>
              {alreadyPlanned ? `${monthName} is planned` : `Plan ${monthName}`}
            </strong>
            <p className="small muted" style={{ margin: "2px 0 0" }}>
              {alreadyPlanned
                ? (confirming
                    ? "Every post returns to the pool. The month itself is deleted."
                    : "Replan to rebuild it, or unschedule to return the posts to the pool.")
                : when}
            </p>
          </div>
        </div>

        {canEdit ? (
          <div className="row" style={{ gap: 8, flexShrink: 0 }}>
            {/*
              * Unschedule sits beside replan, not instead of it.
              *
              * Replanning overwrites; this returns the posts to the pool so
              * they can be rejected or re-picked. They are different
              * intentions, and offering only the first is what made a bad
              * scheduled topic unrejectable.
              */}
            {alreadyPlanned && plannedMonthId ? (
              confirming ? (
                <>
                  <button type="button" className="btn danger small" disabled={busy}
                          onClick={() => void unschedule()}>
                    {busy ? "Clearing…" : "Clear the month"}
                  </button>
                  <button type="button" className="btn small" disabled={busy}
                          onClick={() => setConfirming(false)}>
                    Keep it
                  </button>
                </>
              ) : (
                <button type="button" className="btn" disabled={busy}
                        onClick={() => { setConfirming(true); setError(null); }}>
                  Unschedule
                </button>
              )
            ) : null}

            {!confirming ? (
              <button type="button" className="btn primary" disabled={busy}
                      onClick={() => void call("preview")}>
                {busy ? "Working…" : plan ? "Preview again" : alreadyPlanned ? "Replan" : "Build calendar"}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {error ? <p className="error" style={{ marginTop: 12 }}>{error}</p> : null}

      {plan ? (
        <div style={{ marginTop: 16 }}>
          <div className="row" style={{ gap: 14, flexWrap: "wrap", marginBottom: 12 }}>
            <span className="small">
              <strong>{plan.tally.total}</strong> posts
            </span>
            <span className="small muted">
              {plan.tally.anchored} on a fixed date · {plan.tally.filled} spread across the month
            </span>
            {kept > 0 ? (
              <span className="small muted">
                · {kept} written post{kept === 1 ? "" : "s"} stay where {kept === 1 ? "it is" : "they are"}
              </span>
            ) : null}
          </div>

          {/*
            * Warnings before the plan, not after.
            *
            * These are the reasons not to commit, and putting them under a
            * thirty-row table would mean nobody reads them.
            */}
          {plan.warnings.length > 0 ? (
            <div className="finding" style={{ borderColor: "var(--warn)", marginBottom: 12 }}>
              {plan.warnings.map((w, i) => (
                <p className="small" key={i} style={{ margin: i ? "6px 0 0" : 0, color: "var(--warn)" }}>
                  {w}
                </p>
              ))}
            </div>
          ) : null}

          <div className="planlist">
            {plan.slots.map((s) => (
              <div className="planrow" key={s.topicId}>
                <span className="planrow-date">
                  {new Date(`${s.date}T12:00:00Z`).toLocaleDateString("en-US", {
                    weekday: "short", day: "numeric", timeZone: "UTC",
                  })}
                </span>
                <span className="planrow-title">
                  {s.title}
                  {s.occasion ? <span className="planrow-occasion"> · {s.occasion}</span> : null}
                </span>
                <span className="planrow-meta">{s.format}</span>
              </div>
            ))}
          </div>

          {canEdit ? (
            <div className="row" style={{ gap: 10, marginTop: 14 }}>
              <button type="button" className="btn primary" disabled={busy}
                      onClick={() => void call("commit")}>
                {busy ? "Saving…" : `Schedule these ${plan.slots.length} posts`}
              </button>
              <button type="button" className="btn" disabled={busy} onClick={() => setPlan(null)}>
                Discard
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
