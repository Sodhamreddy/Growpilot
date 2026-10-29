"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { LoadingIndicator } from "./LoadingIndicator";
import styles from "./ArticleReviewWorkspace.module.css";

/**
 * Approve / request-changes controls.
 *
 * Errors from the API are rendered verbatim from `error.message` plus any
 * structured `details`, so a refused approval explains which gate blocked it
 * rather than showing a generic failure (spec §10.3).
 */
export function ApprovalActions({
  articleId,
  version,
  canApprove,
  canRequestChanges,
  canPublish,
  canRunQa,
  publishTarget,
  published,
  compact = false,
  approveDisabledReason,
  requestChangesDisabledReason,
  reviewHelpId,
  articleStatus,
  onBusyChange,
}: {
  articleId: string;
  version: number;
  canApprove: boolean;
  canRequestChanges: boolean;
  /** Approved, and a publishing destination is connected. */
  canPublish: boolean;
  /** The gates can be re-run: the draft is editable and the role allows it. */
  canRunQa: boolean;
  /** Which CMS the article would go to, e.g. "wordpress". */
  publishTarget: string | null;
  published: boolean;
  compact?: boolean;
  approveDisabledReason?: string;
  requestChangesDisabledReason?: string;
  reviewHelpId?: string;
  articleStatus?: string;
  onBusyChange?: (busy: boolean) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; detail?: string } | null>(null);
  const [note, setNote] = useState("");
  const [qaNotice, setQaNotice] = useState("");

  async function submit(decision: "approve" | "request_changes" | "note") {
    setBusy(true);
    setError(null);
    setQaNotice("");
    try {
      const res = await fetch(`/api/articles/${articleId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, note: note || undefined, expectedVersion: version }),
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
    setQaNotice("");
    try {
      const res = await fetch(`/api/articles/${articleId}/qa`, { method: "POST" });
      const body: unknown = await res.json();
      if (!res.ok) {
        const err = (body as { error?: { message?: string } }).error;
        setError({ message: err?.message ?? "QA did not start." });
        return;
      }
      setQaNotice("Quality checks requested. Results will update here when background processing finishes.");
      try {
        const health = await fetch("/api/jobs/status", { cache: "no-store", signal: AbortSignal.timeout(5000) });
        if (health.ok) {
          const status = await health.json() as { worker?: { online: boolean } };
          if (status.worker?.online === false) setQaNotice("Quality checks were queued while the worker was offline. They will run when background processing reconnects.");
        }
      } catch { /* A health-check failure does not undo the accepted QA request. */ }
      startTransition(() => router.refresh());
    } catch {
      setError({ message: "Could not reach the server. Check your connection and try again." });
    } finally {
      setBusy(false);
    }
  }

  const disabled = busy || pending;
  useEffect(() => { onBusyChange?.(disabled); }, [disabled, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);

  if (compact) return <div className={styles.approval}>
    {disabled && <LoadingIndicator label="Updating article…" />}
    {canRunQa && !canApprove && <button type="button" className={`${styles.primaryButton} ${styles.qaAction}`} disabled={disabled} onClick={() => void runQa()}>Run quality checks</button>}
    {canPublish && <button type="button" className={styles.primaryButton} disabled={disabled} onClick={() => void publish()}>{disabled ? "Publishing…" : `Publish to ${publishTarget}`}</button>}
    {articleStatus && ["approved", "scheduled", "published"].includes(articleStatus)
      ? <span className={styles.approvalStatus}>{published ? "Published" : articleStatus === "scheduled" ? "Approved · Scheduled" : "This version is approved"}</span>
      : null}
    <div className={styles.decisionRow}>
      {!articleStatus || !["approved", "scheduled", "published"].includes(articleStatus) ? <button type="button" className={styles.primaryButton} disabled={!canApprove || disabled}
        aria-describedby={!canApprove ? reviewHelpId : undefined} onClick={() => void submit("approve")}
        title={canApprove ? "Approve this version" : approveDisabledReason ?? "Run quality checks before approval"}>{disabled ? "Working…" : "Approve article"}</button> : null}
      <button type="button" className={styles.rejectButton} disabled={!canRequestChanges || disabled}
        aria-describedby={!canRequestChanges ? reviewHelpId : undefined} onClick={() => void submit("request_changes")}
        title={canRequestChanges ? "Return this draft for changes" : requestChangesDisabledReason}>Request changes</button>
    </div>
    {canRunQa && canApprove && <button type="button" className={styles.button} disabled={disabled} onClick={() => void runQa()}>Run checks again</button>}
    <details className={styles.reviewNote}>
      <summary>Add a review note</summary>
      <label htmlFor="approval-note">Your note</label>
      <textarea id="approval-note" value={note} maxLength={2000} rows={3} disabled={disabled}
        onChange={event => setNote(event.target.value)} placeholder="What should change, or why are you approving?" />
      <p>Included with your decision, or save it as a note.</p>
      <button type="button" className={styles.button} disabled={disabled || !note.trim()} onClick={() => void submit("note")}>Save note</button>
    </details>
    {error && <div role="alert" className={styles.actionError}>{error.message}{error.detail && <div>{error.detail}</div>}</div>}
    {qaNotice && !error && <div role="status" className={styles.actionNotice}>{qaNotice}</div>}
  </div>;
  return (
    <div>
      {disabled && <p className="small muted"><LoadingIndicator label="Updating article…" /></p>}
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
      {qaNotice && !error ? <p role="status" className="small muted">{qaNotice}</p> : null}
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
