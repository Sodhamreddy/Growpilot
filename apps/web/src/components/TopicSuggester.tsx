"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

/**
 * Topic suggestions — the entry point to blog automation.
 *
 * Suggestions are held in component state, not written to the database. A
 * customer asks for five, picks one, and the other four should leave no trace:
 * persisting rejected proposals would fill the content plan with things nobody
 * chose.
 */

export interface Suggestion {
  title: string;
  rationale: string;
  primaryKeyword: string;
  intent: "informational" | "commercial" | "transactional" | "local";
  service: string;
  location: string;
  fit: number;
}

const INTENT_LABEL: Record<string, string> = {
  informational: "Informational",
  commercial: "Commercial",
  transactional: "Transactional",
  local: "Local",
};

export function TopicSuggester({
  businessId, canEdit, blockedReason, compact = false, autoRun = false,
}: {
  businessId: string;
  canEdit: boolean;
  /** Set when the prerequisites are not met — suggestions cannot be asked for. */
  blockedReason: string | null;
  /**
   * Header mode: the trigger lives in the page header, and this renders
   * nothing until there is something to show. A permanent explanatory card
   * for an action that is one click away is just a card in the way.
   */
  compact?: boolean;
  /** Ask as soon as this mounts — the header button already expressed intent. */
  autoRun?: boolean;
}) {
  const router = useRouter();
  const started = useRef(false);
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [accepting, setAccepting] = useState<string | null>(null);
  /*
   * Per-suggestion edits, keyed by the original title.
   *
   * The focus keyword decides what the article is written to rank for — it
   * shapes the brief, the headings and the meta description. A model's guess is
   * a starting point, not a decision, so it has to be changeable before the
   * generation spends anything. Held separately from `suggestions` so editing
   * one card never rewrites the list.
   */
  const [edits, setEdits] = useState<Record<string, { title: string; keyword: string }>>({});
  const [openEditor, setOpenEditor] = useState<string | null>(null);

  const editOf = (s: Suggestion) =>
    edits[s.title] ?? { title: s.title, keyword: s.primaryKeyword };

  const setEdit = (s: Suggestion, patch: Partial<{ title: string; keyword: string }>) =>
    setEdits((current) => ({
      ...current,
      [s.title]: { ...editOf(s), ...patch },
    }));
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/topics/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, limit: 5 }),
      });
      const parsed: unknown = await res.json();
      if (!res.ok) {
        setError(
          (parsed as { error?: { message?: string } }).error?.message ??
            "Could not generate topics.",
        );
        return;
      }
      const list = (parsed as { topics?: Suggestion[] }).topics ?? [];
      setSuggestions(list);
      if (list.length === 0) {
        setError("The model returned no usable topics. Try again, or add more services.");
      }
    } catch {
      setError("Could not reach the server.");
    } finally {
      setLoading(false);
    }
  }

  async function accept(s: Suggestion) {
    setAccepting(s.title);
    setError(null);
    try {
      const res = await fetch("/api/topics/suggest", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          title: editOf(s).title.trim(),
          primaryKeyword: editOf(s).keyword.trim(),
          intent: s.intent,
          rationale: s.rationale,
        }),
      });
      const parsed: unknown = await res.json();
      if (!res.ok) {
        setError(
          (parsed as { error?: { message?: string } }).error?.message ??
            "Could not start that article.",
        );
        return;
      }
      // Remove the accepted one; the rest stay available to pick next.
      setSuggestions((cur) => cur?.filter((x) => x.title !== s.title) ?? null);
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setAccepting(null);
    }
  }

  /*
   * Run once on mount in autoRun mode.
   *
   * The header button is the intent; remounting with a new key is what
   * re-triggers it. Guarded by a ref rather than the loading flag so React's
   * development double-invoke does not spend two model calls.
   */
  useEffect(() => {
    if (!autoRun || blockedReason || started.current) return;
    started.current = true;
    void generate();
    // generate() is stable for the life of this mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRun, blockedReason]);

  if (blockedReason) {
    // In compact mode the header button is already disabled with the reason on
    // it, so a second full-width warning would say the same thing twice.
    if (compact) return null;
    return (
      <div className="card" style={{ marginBottom: 22, borderColor: "var(--warn)" }}>
        <strong style={{ fontSize: 14 }}>Not ready to suggest topics</strong>
        <p className="muted small" style={{ margin: "6px 0 0", maxWidth: "70ch" }}>
          {blockedReason}
        </p>
      </div>
    );
  }

  /*
   * Nothing to show yet, and the trigger is elsewhere.
   *
   * The button lives in the page header in compact mode, so an empty card
   * explaining what the button does would be a permanent placeholder for an
   * action already one click away.
   */
  if (compact && !suggestions && !loading && !error) return null;

  return (
    <div className="card" style={{ marginBottom: 22 }}>
      {compact ? null : (
        <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
          <div style={{ maxWidth: "62ch" }}>
            <strong style={{ fontSize: 14 }}>Suggest topics</strong>
            <p className="muted small" style={{ margin: "6px 0 0" }}>
              Five topics drawn from your services and locations, with the reasoning for each.
              These are a judgement about what buyers in your field are asking now — not measured
              search-trend data, which needs a keyword provider we do not have connected.
            </p>
          </div>
          {canEdit ? (
            <button type="button" className="btn primary" disabled={loading} onClick={() => void generate()}>
              {loading ? "Thinking…" : suggestions ? "Suggest again" : "Generate topics"}
            </button>
          ) : null}
        </div>
      )}

      {compact && suggestions ? (
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <strong style={{ fontSize: 14 }}>Suggested topics</strong>
          <span className="small muted">
            A judgement about what buyers are asking now — not measured search data.
          </span>
        </div>
      ) : null}

      {error ? (
        <p className="small" style={{ color: "var(--danger)", margin: "12px 0 0" }}>{error}</p>
      ) : null}

      {loading && !suggestions ? (
        <p className="small muted" style={{ margin: "14px 0 0" }}>
          Reading your services and locations…
        </p>
      ) : null}

      {suggestions && suggestions.length > 0 ? (
        <div style={{ marginTop: 18 }}>
          {suggestions.map((s) => (
            <div className="finding" key={s.title}>
              <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
                <div style={{ flex: 1 }}>
                  <strong>{editOf(s).title}</strong>
                  <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                    <span className="badge neutral">{INTENT_LABEL[s.intent] ?? s.intent}</span>
                    {s.service ? <span className="badge neutral">{s.service}</span> : null}
                    {s.location ? <span className="badge ok">{s.location}</span> : null}
                    <span className="badge neutral">fit {Math.round(s.fit * 100)}%</span>
                  </div>
                  <div className="suggestion" style={{ marginTop: 8 }}>{s.rationale}</div>

                  {openEditor === s.title ? (
                    <div className="formgrid" style={{ marginTop: 12 }}>
                      <label className="field" style={{ marginBottom: 0 }}>
                        <span className="fieldlabel">Title</span>
                        <input
                          type="text"
                          value={editOf(s).title}
                          onChange={(e) => setEdit(s, { title: e.target.value })}
                        />
                      </label>
                      <label className="field" style={{ marginBottom: 0 }}>
                        <span className="fieldlabel">Focus keyword</span>
                        <input
                          type="text"
                          value={editOf(s).keyword}
                          onChange={(e) => setEdit(s, { keyword: e.target.value })}
                        />
                        <span className="hint">
                          What the article is written to rank for. It shapes the brief, the
                          headings and the meta description.
                        </span>
                      </label>
                    </div>
                  ) : (
                    <div className="small muted mono" style={{ marginTop: 6 }}>
                      focus keyword: {editOf(s).keyword}
                    </div>
                  )}
                </div>

                {canEdit ? (
                  <div style={{ display: "grid", gap: 8, minWidth: 120 }}>
                    <button
                      type="button"
                      className="btn primary"
                      disabled={
                        accepting !== null ||
                        editOf(s).title.trim() === "" ||
                        editOf(s).keyword.trim() === ""
                      }
                      onClick={() => void accept(s)}
                    >
                      {accepting === s.title ? "Starting…" : "Write this"}
                    </button>
                    <button
                      type="button"
                      className="btn small"
                      disabled={accepting !== null}
                      onClick={() => setOpenEditor(openEditor === s.title ? null : s.title)}
                    >
                      {openEditor === s.title ? "Done" : "Edit"}
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
