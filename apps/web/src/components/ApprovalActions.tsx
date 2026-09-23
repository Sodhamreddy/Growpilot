"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * Approve / request-changes controls.
 *
 * Errors from the API are rendered verbatim from `error.message` plus any
 * structured `details`, so a refused approval explains which gate blocked it
 * rather than showing a generic failure (spec §10.3).
 */
export function ApprovalActions({
  articleId,
  canApprove,
  canRequestChanges,
  canPublish,
  canRunQa,
  publishTarget,
  published,
}: {
  articleId: string;
  canApprove: boolean;
  canRequestChanges: boolean;
  /** Approved, and a publishing destination is connected. */
  canPublish: boolean;
  /** The gates can be re-run: the draft is editable and the role allows it. */
  canRunQa: boolean;
  /** Which CMS the article would go to, e.g. "wordpress". */
  publishTarget: string | null;
  published: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; detail?: string } | null>(null);
  const [note, setNote] = useState("");

  async function submit(decision: "approve" | "request_changes" | "note") {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/articles/${articleId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, note: note || undefined }),
      });
      const body: unknown = await res.json();

      if (!res.ok) {
        const err = (body as { error?: { message?: string; details?: Record<string, unknown> } }).error;
        setError({
          message: err?.message ?? "That did not work.",
          detail: formatDetails(err?.details),
        });
        return;
      }
      setNote("");
      startTransition(() => router.refresh());
    } catch {
      setError({ message: "Could not reach the server. Check your connection and try again." });
    } finally {
      setBusy(false);
    }
  }

  /**
   * Send the article to the connected CMS.
   *
   * The route behind this has been complete since the pipeline was built —
   * role check, gate re-evaluation, integration liveness, idempotency key,
   * queue enqueue — and nothing in the UI ever called it. An article could be
   * approved and then went nowhere: the page promised "review, approve and
   * publish in one place" and stopped one step short of the last word.
   */
  async function publish() {
    if (!publishTarget) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/articles/${articleId}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: publishTarget }),
      });
      const body: unknown = await res.json();
      if (!res.ok) {
        const err = (body as { error?: { message?: string; details?: Record<string, unknown> } }).error;
        setError({
          message: err?.message ?? "Publishing did not start.",
          detail: formatDetails(err?.details),
        });
        return;
      }
      startTransition(() => router.refresh());
    } catch {
      setError({ message: "Could not reach the server. Check your connection and try again." });
    } finally {
      setBusy(false);
    }
  }

  /**
   * Re-run the quality gates.
   *
   * The blocked-approval message tells a reviewer to "fix these, then re-run
   * QA", which was an instruction with no control behind it. Fixing a draft
   * left the old failing results on screen with no way to ask again.
   */
  async function runQa() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/articles/${articleId}/qa`, { method: "POST" });
      const body: unknown = await res.json();
      if (!res.ok) {
        const err = (body as { error?: { message?: string } }).error;
        setError({ message: err?.message ?? "QA did not start." });
        return;
      }
      startTransition(() => router.refresh());
    } catch {
      setError({ message: "Could not reach the server. Check your connection and try again." });
    } finally {
      setBusy(false);
    }
  }

  const disabled = busy || pending;

  return (
    <div>
      {/*
        * The note is always available, not only when a decision can be made.
        *
        * It used to render alongside the buttons, so an article still in draft
        * — before quality gates have run — showed no way to leave a comment at
        * all. That is exactly when someone reading a fresh draft wants to note
        * what needs fixing, and hiding the field made the article look
        * read-only.
        */}
      <div className="field">
        <label htmlFor="approval-note">
          {canApprove || canRequestChanges ? "Note (optional)" : "Note for this draft"}
        </label>
        <textarea
          id="approval-note"
          rows={2}
          value={note}
          maxLength={2000}
          onChange={(e) => setNote(e.target.value)}
          placeholder={
            canApprove || canRequestChanges
              ? "Why are you approving, or what needs to change?"
              : "What should change before this goes to review?"
          }
        />
        {!canApprove && !canRequestChanges ? (
          <span className="hint">
            Saved to the audit trail with your name. Approval opens once the quality gates
            have run.
          </span>
        ) : null}
      </div>

      {!canApprove && !canRequestChanges ? (
        <div className="row" style={{ marginBottom: 14 }}>
          <button
            className="btn"
            disabled={busy || note.trim() === ""}
            onClick={() => void submit("note")}
          >
            {busy ? "Saving…" : "Save note"}
          </button>
        </div>
      ) : null}

      <div className="row">
        <button
          className="btn primary"
          disabled={!canApprove || disabled}
          onClick={() => void submit("approve")}
          title={canApprove ? undefined : "Only an article awaiting approval with no failing gates can be approved"}
        >
          {disabled ? "Working…" : "Approve"}
        </button>
        <button
          className="btn"
          disabled={!canRequestChanges || disabled}
          onClick={() => void submit("request_changes")}
        >
          Request changes
        </button>

        {/*
          * Re-run QA, beside the message that asks for it.
          *
          * Offered whenever the draft is still editable, including while the
          * gates are failing — that is precisely when somebody has just fixed
          * something and wants to ask again.
          */}
        {canRunQa ? (
          <button className="btn" disabled={disabled} onClick={() => void runQa()}>
            {disabled ? "Working…" : "Re-run QA"}
          </button>
        ) : null}

        {/*
          * Publish, the step this page was missing.
          *
          * Shown only once the article is approved, so it does not compete
          * with the decision that has to come first. When nothing is
          * connected the button says so rather than failing on click.
          */}
        {published ? (
          <span className="hint" style={{ alignSelf: "center" }}>Published.</span>
        ) : canPublish ? (
          <button
            className="btn primary"
            disabled={disabled}
            onClick={() => void publish()}
            style={{ marginLeft: "auto" }}
          >
            {disabled ? "Publishing…" : `Publish to ${publishTarget}`}
          </button>
        ) : canApprove || canRequestChanges ? null : (
          <span className="hint" style={{ alignSelf: "center", marginLeft: "auto" }}>
            Connect a site in Settings to publish.
          </span>
        )}
      </div>

      {error ? (
        <div className="error" style={{ marginTop: 12 }}>
          <div>{error.message}</div>
          {error.detail ? <div className="small mono">{error.detail}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

/** Render the API's structured detail without dumping raw JSON at the user. */
function formatDetails(details: Record<string, unknown> | undefined): string | undefined {
  if (!details) return undefined;

  const failing = details["failing"];
  if (Array.isArray(failing)) {
    return failing
      .map((f) => {
        const row = f as { gate?: string; errors?: string[] };
        return `${row.gate}: ${(row.errors ?? []).join("; ")}`;
      })
      .join(" · ");
  }

  const reasons = details["reasons"];
  if (Array.isArray(reasons)) return reasons.join(" · ");

  const fields = details["fields"];
  if (fields && typeof fields === "object") {
    return Object.entries(fields as Record<string, string>)
      .map(([k, v]) => `${k}: ${v}`)
      .join(" · ");
  }

  return undefined;
}
