"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { LoadingIndicator } from "./LoadingIndicator";

/**
 * The blog companion.
 *
 * Pick a section, say what you want changed, see the before and after, decide.
 * It exists because the two things a reviewer could previously do with a draft
 * that was nearly right were both bad: edit it by hand, or regenerate and throw
 * away everything that already worked.
 *
 * It proposes; it never writes. Applying goes through the same PATCH a manual
 * edit uses, so an accepted change bumps the version and files a revision like
 * any other — the history stays honest about what the draft has been through,
 * and there is no path where a model's output reaches the article without a
 * person having read it.
 */

export interface CompanionSection {
  id: string;
  heading: string;
  level: number;
}

interface Proposal {
  expectedVersion: number;
  sectionId: string;
  heading: string;
  before: string;
  after: string;
  changed: boolean;
}

const EXAMPLES = [
  "Soften this — we can't promise that",
  "Make this shorter",
  "Add a sentence about what it costs",
  "Too salesy, make it plainer",
];

export function BlogCompanion({
  articleId,
  version,
  sections,
  canEdit,
  editable,
  embedded = false,
  onApplyingChange,
}: {
  articleId: string;
  version: number;
  sections: CompanionSection[];
  canEdit: boolean;
  editable: boolean;
  embedded?: boolean;
  onApplyingChange?: (applying: boolean) => void;
}) {
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const [sectionId, setSectionId] = useState(sections[0]?.id ?? "");
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const usable = canEdit && editable && sections.length > 0;
  useEffect(() => { onApplyingChange?.(applying || refreshing); }, [applying, refreshing, onApplyingChange]);
  useEffect(() => () => onApplyingChange?.(false), [onApplyingChange]);

  async function ask() {
    setBusy(true);
    setError(null);
    setProposal(null);
    setDone(null);
    try {
      const res = await fetch(`/api/articles/${articleId}/revise`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sectionId, instruction: instruction.trim(), expectedVersion: version }),
      });
      const body: unknown = await res.json();
      if (!res.ok) {
        setError(
          (body as { error?: { message?: string } }).error?.message ?? "That did not work.",
        );
        return;
      }
      setProposal(body as Proposal);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!proposal) return;
    setApplying(true);
    setError(null);
    try {
      const res = await fetch(`/api/articles/${articleId}/revise/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sectionId: proposal.sectionId, content: proposal.after, expectedVersion: proposal.expectedVersion }),
      });
      const body: unknown = await res.json();
      if (!res.ok) {
        setError(
          (body as { error?: { message?: string } }).error?.message ?? "Could not apply that.",
        );
        return;
      }
      setProposal(null);
      setInstruction("");
      setDone("Applied. The draft is now at a new version.");
      startRefresh(() => router.refresh());
    } catch {
      setError("Could not reach the server.");
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="card" style={{ position: embedded ? "static" : "sticky", top: embedded ? undefined : 16 }}>
      <div style={{ marginBottom: 14 }}>
        <strong>Ask for a change</strong>
        <p className="small muted" style={{ margin: "4px 0 0" }}>
          Pick a section and say what you want different. You&rsquo;ll see the change
          before it goes in.
        </p>
      </div>

      {refreshing && <p className="small muted"><LoadingIndicator label="Loading updated article…" /></p>}

      {!usable ? (
        <p className="small muted" style={{ margin: 0 }}>
          {!canEdit
            ? "You need editor access to change this draft."
            : !editable
              ? "This draft cannot be changed in its current state."
              : "There is no draft to change yet."}
        </p>
      ) : (
        <>
          <label className="field">
            <span className="fieldlabel">Section</span>
            <select value={sectionId} onChange={(e) => setSectionId(e.target.value)}
                    disabled={busy || applying}>
              {sections.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.heading || "Opening (before the first heading)"}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span className="fieldlabel">What should change?</span>
            <textarea
              rows={3}
              value={instruction}
              disabled={busy || applying}
              placeholder="e.g. soften this, we can't promise same-day visits"
              onChange={(e) => setInstruction(e.target.value)}
              style={{ width: "100%", fontFamily: "inherit", lineHeight: 1.6, resize: "vertical" }}
            />
          </label>

          {!instruction && !proposal ? (
            <div className="row" style={{ gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
              {EXAMPLES.map((e) => (
                <button key={e} type="button" className="btn small"
                        onClick={() => setInstruction(e)}>
                  {e}
                </button>
              ))}
            </div>
          ) : null}

          <button type="button" className="btn primary"
                  disabled={busy || applying || instruction.trim().length < 3}
                  onClick={() => void ask()}>
            {busy ? <LoadingIndicator label="Preparing your change…" /> : "Show me the change"}
          </button>

          {proposal ? (
            <div style={{ marginTop: 18 }}>
              {!proposal.changed ? (
                /*
                 * Say so rather than showing two identical blocks.
                 * A reviewer who asked for something and got nothing back
                 * needs to know it was understood and declined, not wonder
                 * whether the diff failed to render.
                 */
                <p className="small" style={{ color: "var(--warn)" }}>
                  Nothing changed. That may need a fact the draft doesn&rsquo;t have —
                  try being more specific, or edit it yourself.
                </p>
              ) : null}

              <div className="field">
                <span className="fieldlabel">Now</span>
                <div className="small" style={{
                  padding: 10, borderRadius: 8, background: "var(--surface-2)",
                  whiteSpace: "pre-wrap", maxHeight: 200, overflowY: "auto",
                }}>
                  {proposal.before}
                </div>
              </div>

              <div className="field">
                <span className="fieldlabel">Proposed</span>
                <div className="small" style={{
                  padding: 10, borderRadius: 8, background: "var(--surface-2)",
                  whiteSpace: "pre-wrap", maxHeight: 260, overflowY: "auto",
                }}>
                  {proposal.after}
                </div>
              </div>

              <div className="row" style={{ gap: 10 }}>
                <button type="button" className="btn primary"
                        disabled={applying || !proposal.changed}
                        onClick={() => void apply()}>
                  {applying ? <LoadingIndicator label="Applying…" /> : "Apply"}
                </button>
                <button type="button" className="btn" disabled={applying}
                        onClick={() => setProposal(null)}>
                  Discard
                </button>
              </div>
            </div>
          ) : null}

          {error ? <p className="error" style={{ marginTop: 12 }}>{error}</p> : null}
          {done ? <p className="small muted" style={{ marginTop: 12 }}>{done}</p> : null}

          <p className="small muted" style={{ margin: "16px 0 0", lineHeight: 1.5 }}>
            It can rewrite, shorten and soften. It can&rsquo;t add a fact your business
            profile doesn&rsquo;t have, or invent a link.
          </p>
        </>
      )}
    </div>
  );
}
