"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import { BlogBriefWorkspace } from "./BlogBriefWorkspace";
import { IconSpark } from "./Icons";
import styles from "./BlogQueue.module.css";
import { LoadingIndicator } from "./LoadingIndicator";

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
  const inFlight = useRef(false);
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Suggestion | null>(null);
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
      [s.title]: { ...(current[s.title] ?? { title: s.title, keyword: s.primaryKeyword }), ...patch },
    }));
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    if (inFlight.current || !canEdit || blockedReason) return;
    inFlight.current = true;
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
      setEdits({}); setOpenEditor(null);
      if (list.length === 0) {
        setError("The model returned no usable topics. Try again, or add more services.");
      }
    } catch {
      setError("Could not reach the server.");
    } finally {
      inFlight.current = false;
      setLoading(false);
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
    if (!autoRun || !canEdit || blockedReason || started.current) return;
    started.current = true;
    void generate();
    // generate() is stable for the life of this mount.
  }, [autoRun, canEdit, blockedReason]);

  if (blockedReason) {
    // In compact mode the header button is already disabled with the reason on
    // it, so a second full-width warning would say the same thing twice.
    if (compact) return null;
    return (
      <div className={styles.notice}>
        <strong>Not ready to suggest topics</strong>
        <p>
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
    <div className={styles.suggestions}>
      {selected && canEdit ? createPortal(<BlogBriefWorkspace
        key={selected.title}
        businessId={businessId}
        suggestion={{ ...selected, title: editOf(selected).title, primaryKeyword: editOf(selected).keyword }}
        onClose={() => setSelected(null)}
        onReject={() => {
          setSuggestions((current) => current?.filter((item) => item.title !== selected.title) ?? null);
          setSelected(null);
        }}
        onGenerated={(articleId) => {
          setSuggestions((current) => current?.filter((item) => item.title !== selected.title) ?? null);
          setSelected(null);
          router.push(`/articles/${articleId}`);
          router.refresh();
        }}
      />, document.body) : null}
      {compact ? null : (
        <div className={styles.panelHeader}>
          <div><h2>Topic ideas</h2><p>Ideas based on your services and locations. Choose one to review its brief.</p></div>
          {canEdit ? (
            <button type="button" className={`${styles.button} ${styles.primary}`} disabled={loading || selected !== null} onClick={() => void generate()}>
              {loading ? "Finding ideas…" : suggestions ? "Find more ideas" : "Find topic ideas"}
            </button>
          ) : null}
        </div>
      )}

      {compact ? (
        <div className={styles.ideaToolbar}>
          <span role="status">{loading ? "Finding ideas for your business…" : suggestions ? `${suggestions.length} ${suggestions.length === 1 ? "idea" : "ideas"} to review` : "Topic ideas"}</span>
          {canEdit && <button type="button" className={styles.button} disabled={loading || selected !== null} onClick={() => void generate()}><IconSpark size={15} /> {loading ? "Finding ideas…" : "Find more ideas"}</button>}
        </div>
      ) : null}

      {error ? (
        <p className={styles.error} role="alert">{error}</p>
      ) : null}

      {loading ? (
        <p className={styles.ideaLoading}>
          <LoadingIndicator label={suggestions ? "Refreshing topic ideas…" : "Finding topic ideas…"} />
        </p>
      ) : null}

      {suggestions && suggestions.length > 0 ? (
        <div className={styles.ideaList}>
          {suggestions.map((s) => (
            <article className={styles.ideaCard} key={s.title}>
                <div className={styles.ideaCopy}>
                  <h3>{editOf(s).title}</h3>
                  <div className={styles.ideaMeta}>
                    <span>{INTENT_LABEL[s.intent] ?? s.intent}</span>
                    {s.service ? <span>{s.service}</span> : null}
                    {s.location ? <span>{s.location}</span> : null}
                  </div>
                  <p className={styles.ideaRationale}>{s.rationale}</p>

                  {openEditor === s.title ? (
                    <div className={styles.ideaFields}>
                      <label>
                        <span>Title</span>
                        <input
                          type="text"
                          value={editOf(s).title}
                          maxLength={200}
                          disabled={loading}
                          onChange={(e) => setEdit(s, { title: e.target.value })}
                        />
                      </label>
                      <label>
                        <span>Focus keyword</span>
                        <input
                          type="text"
                          value={editOf(s).keyword}
                          maxLength={120}
                          disabled={loading}
                          onChange={(e) => setEdit(s, { keyword: e.target.value })}
                        />
                        <small>The search phrase this article should address.</small>
                      </label>
                    </div>
                  ) : (
                    <div className={styles.ideaKeyword}>
                      Focus keyword: <span>{editOf(s).keyword}</span>
                    </div>
                  )}
                </div>

                {canEdit ? (
                  <div className={styles.ideaActions}>
                    <button
                      type="button"
                      className={`${styles.button} ${styles.primary}`}
                      disabled={
                        loading || selected !== null ||
                        editOf(s).title.trim().length < 4 ||
                        editOf(s).keyword.trim().length < 2
                      }
                      onClick={() => setSelected(s)}
                    >
                      Review brief
                    </button>
                    <button
                      type="button"
                      className={styles.textButton}
                      disabled={loading || selected !== null}
                      onClick={() => setOpenEditor(openEditor === s.title ? null : s.title)}
                    >
                      {openEditor === s.title ? "Done editing" : "Edit idea"}
                    </button>
                  </div>
                ) : null}
            </article>
          ))}
        </div>
      ) : null}
      {suggestions?.length === 0 && !loading && !error && <p className={styles.ideaNote}>No ideas left to review. Find more ideas when you&rsquo;re ready to create another blog.</p>}
      {suggestions && suggestions.length > 0 && <p className={styles.ideaNote}>These ideas are based on your business profile. Search volume is shown only when measured keyword data is available.</p>}
    </div>
  );
}
