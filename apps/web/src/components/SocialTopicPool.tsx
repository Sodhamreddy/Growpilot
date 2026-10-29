"use client";

import Link from "next/link";
import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { IconSpark, IconEdit } from "./Icons";
import { SocialPromptSettings, type SocialPrompts } from "./SocialPromptSettings";

/**
 * The topic pool.
 *
 * Categories down the left with their fill counts, topics as cards on the
 * right. The shape is taken from the planner this replaces, and it earns it:
 * a sidebar makes "which categories are still empty" a glance rather than a
 * scroll, and cards let a reviewer read three hooks side by side and judge
 * them against each other.
 *
 * Every card shows its full hook. Two topics can share a title and be entirely
 * different posts, so approving on titles alone would be approving on faith.
 */

export interface PoolTopicRow {
  id: string;
  title: string;
  hook: string;
  audience: string;
  format: string;
  imageIdea: string;
  status: string;
  /** "Sep 7 · Labor Day" when the topic is tied to a day. */
  dateLabel: string | null;
  /** How that date was derived, shown on hover so it can be checked. */
  dateRule: string | null;
  recommended: boolean;
  recommendedWhy: string | null;
}

/** Formats a reviewer can switch a card to. Mirrors FORMATS in @ob/social. */
const FORMAT_OPTIONS = [
  "Static Image", "Carousel", "Video", "Quote", "Q and A", "Poll/Quiz", "Podcast", "GIF",
];

export interface PoolCategory {
  id: string;
  name: string;
  description: string;
  targetCount: number;
  topics: PoolTopicRow[];
}

interface SelectedPlan {
  slots: Array<{ topicId: string; title: string; date: string; format: string }>;
  warnings: string[];
}

const AUDIENCE_CLASS: Record<string, string> = {
  "Senior specific": "aud-senior",
  "Family caregiver specific": "aud-family",
  "Caregiver specific": "aud-caregiver",
  General: "aud-general",
};

/**
 * Short labels for the filter row; the full names are long.
 *
 * Only a display shortening. Which filters actually appear comes from the
 * topics in the pool, not from this table: it was a fixed list of home care
 * audiences, so a software company's pool offered "Senior", "Caregiver" and
 * "Family" as filters that could only ever match nothing.
 */
const SHORT_LABEL: Record<string, string> = {
  "Senior specific": "Senior",
  "Caregiver specific": "Caregiver",
  "Family caregiver specific": "Family",
};

/**
 * The filter row for a category, built from the audiences actually present.
 *
 * "All" always leads. The rest are whatever this client's topics were written
 * for, in the order the pool happens to hold them, so a filter never promises
 * a slice that does not exist. A pool whose topics share one audience gets no
 * filters at all, because filtering to the only option does nothing.
 */
function filtersFor(topics: PoolTopicRow[]): { key: string; label: string }[] {
  const present = [...new Set(topics.map((t) => t.audience).filter(Boolean))];
  if (present.length < 2) return [];
  return [
    { key: "", label: "All" },
    ...present.map((a) => ({ key: a, label: SHORT_LABEL[a] ?? a })),
  ];
}

export function SocialTopicPool({
  categories,
  canEdit,
  blockedReason,
  emptyState,
  businessId,
  monthKey,
  prompts,
}: {
  categories: PoolCategory[];
  canEdit: boolean;
  blockedReason: string | null;
  emptyState: {
    title: string;
    description: string;
    canCreate: boolean;
    actionHref: string;
    actionLabel: string;
  };
  businessId: string | null;
  monthKey: string;
  prompts: SocialPrompts;
}) {
  const router = useRouter();
  const [activeId, setActiveId] = useState(categories[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const [audience, setAudience] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rejected, setRejected] = useState<{ topic: string; reason: string }[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  /** The category being added or edited. `id` absent means a new one. */
  const [editing, setEditing] = useState<
    { id?: string; name: string; description: string; targetCount: number } | null
  >(null);
  const [selectedPlan, setSelectedPlan] = useState<SelectedPlan | null>(null);
  /*
   * Selection lives here, not per card.
   *
   * A month is built from a set, and the only question that matters while
   * picking is "how many so far" — which no individual card can answer.
   */
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggle = (id: string) => {
    setSelectedPlan(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const live = (c: PoolCategory) => c.topics.filter((t) => t.status !== "rejected");
  const active = categories.find((c) => c.id === activeId) ?? categories[0];

  /*
   * The filter row, and the guarantee that it can always be cleared.
   *
   * Built from the *live* topics, not every topic: rejecting the only
   * "Caregiver specific" card used to leave its chip on screen offering a
   * slice that no longer existed.
   *
   * `shown` is what the grid filters by. When the selected audience is no
   * longer among the filters — because its last topic was just rejected, or
   * because the row dropped to a single audience and disappeared entirely —
   * the selection is ignored rather than applied. Without that, the grid went
   * empty with no chip left on screen to clear, and the only way out was to
   * switch category and come back.
   */
  const filters = active ? filtersFor(live(active)) : [];
  const shown = filters.some((f) => f.key === audience) ? audience : "";

  const totalLive = categories.reduce((n, c) => n + live(c).length, 0);
  const totalTarget = categories.reduce((n, c) => n + c.targetCount, 0);

  const visible = useMemo(() => {
    if (!active) return [];
    const q = query.trim().toLowerCase();
    return live(active).filter((t) => {
      if (shown && t.audience !== shown) return false;
      if (!q) return true;
      return (t.title + " " + t.hook).toLowerCase().includes(q);
    });
  }, [active, query, shown]);

  const configured = [prompts.topics, prompts.post, prompts.image, prompts.reference]
    .filter((s) => s.trim()).length;

  async function setupCategories() {
    setBusy("categories");
    setError(null);
    try {
      const res = await fetch("/api/social/categories", { method: "POST" });
      const body: unknown = await res.json();
      if (!res.ok) {
        setError((body as { error?: { message?: string } }).error?.message ?? "Categories could not be created.");
        return;
      }
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(null);
    }
  }

  async function saveCategory() {
    if (!editing || !editing.name.trim()) return;
    setBusy("category");
    setError(null);
    try {
      const res = await fetch("/api/social/categories", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(editing.id ? { id: editing.id } : {}),
          name: editing.name.trim(),
          description: editing.description.trim(),
          targetCount: editing.targetCount,
        }),
      });
      const body: unknown = await res.json();
      if (!res.ok) {
        setError((body as { error?: { message?: string } }).error?.message ?? "Could not save that.");
        return;
      }
      /*
       * Select a newly created category, so pressing "New category" and then
       * Save lands on the thing that was just made rather than leaving it
       * somewhere down a sidebar the person then has to hunt through.
       */
      const created = (body as { category?: { id: string } }).category;
      if (!editing.id && created) setActiveId(created.id);
      setEditing(null);
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(null);
    }
  }

  async function deleteCategory(id: string) {
    setBusy("category");
    setError(null);
    try {
      const res = await fetch("/api/social/categories", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const body: unknown = await res.json();
      if (!res.ok) {
        setError((body as { error?: { message?: string } }).error?.message ?? "Could not remove that.");
        return;
      }
      setEditing(null);
      // Fall back to the first remaining category rather than an empty pane.
      setActiveId(categories.find((c) => c.id !== id)?.id ?? "");
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(null);
    }
  }

  async function planSelected(mode: "preview" | "commit") {
    if (!businessId || selected.size === 0) return;
    setBusy("calendar");
    setError(null);
    try {
      const topicIds = Array.from(selected);
      const res = await fetch("/api/social/calendar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          monthKey,
          mode,
          topicIds,
          target: topicIds.length,
        }),
      });
      const body: unknown = await res.json();
      if (!res.ok) {
        setError((body as { error?: { message?: string } }).error?.message ?? "The calendar could not be built.");
        return;
      }
      if (mode === "preview") {
        setSelectedPlan((body as { plan: SelectedPlan }).plan);
      } else {
        setSelectedPlan(null);
        setSelected(new Set());
        router.refresh();
      }
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(null);
    }
  }

  async function generate(categoryId: string) {
    setBusy(categoryId);
    setError(null);
    setRejected([]);
    try {
      const res = await fetch("/api/social/topics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ categoryId }),
      });
      const body: unknown = await res.json();
      if (!res.ok) {
        setError((body as { error?: { message?: string } }).error?.message ?? "That did not work.");
        return;
      }
      setRejected((body as { rejected?: { topic: string; reason: string }[] }).rejected ?? []);
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(null);
    }
  }

  async function changeFormat(topicId: string, format: string) {
    setError(null);
    try {
      const res = await fetch("/api/social/topics", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topicId, action: "edit", format }),
      });
      if (!res.ok) {
        const body: unknown = await res.json();
        setError((body as { error?: { message?: string } }).error?.message ?? "That did not work.");
        return;
      }
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    }
  }

  async function reject(topicId: string) {
    setError(null);
    try {
      const res = await fetch("/api/social/topics", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topicId, action: "reject" }),
      });
      if (!res.ok) {
        const body: unknown = await res.json();
        setError((body as { error?: { message?: string } }).error?.message ?? "That did not work.");
        return;
      }
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    }
  }

  return (
    <>
      <div className="headeractions" style={{ marginBottom: 16 }}>
        <button
          type="button"
          className={`actionbtn${showSettings ? " on" : ""}`}
          aria-expanded={showSettings}
          aria-label="Writing instructions"
          onClick={() => setShowSettings((s) => !s)}
        >
          <span className="actionbtn-icon" aria-hidden><IconEdit size={15} /></span>
          <span style={{ whiteSpace: "nowrap", fontSize: 13 }}>Writing instructions</span>
          {configured ? <span className="dot" title={`${configured} of 4 set`} aria-hidden /> : null}
        </button>

        <span className="small muted" style={{ alignSelf: "center", marginLeft: 4 }}>
          {totalLive} of {totalTarget} topics
        </span>
      </div>

      {showSettings ? (
        <SocialPromptSettings businessId={businessId ?? ""} initial={prompts} canEdit={canEdit} startOpen />
      ) : null}

      {blockedReason && categories.length > 0 ? (
        <div className="card" style={{ marginBottom: 18, borderColor: "var(--warn)" }}>
          <p className="small" style={{ margin: 0, color: "var(--warn)" }}>{blockedReason}</p>
        </div>
      ) : null}

      {error ? <p className="error" style={{ marginBottom: 14 }}>{error}</p> : null}

      {categories.length === 0 ? (
        <section className="social-empty-state" aria-labelledby="social-empty-title">
          <span className="social-empty-icon" aria-hidden><IconSpark size={24} /></span>
          <div className="social-empty-copy">
            <span className="social-empty-eyebrow">Content setup</span>
            <h3 id="social-empty-title">{emptyState.title}</h3>
            <p>{emptyState.description}</p>
            <div className="social-empty-actions">
              {emptyState.canCreate ? (
                <button
                  type="button"
                  className="btn primary"
                  disabled={busy !== null}
                  onClick={() => void setupCategories()}
                >
                  {busy === "categories" ? "Creating categories…" : "Create categories"}
                </button>
              ) : null}
              <Link className={`btn${emptyState.canCreate ? "" : " primary"}`} href={emptyState.actionHref}>
                {emptyState.actionLabel}
              </Link>
            </div>
          </div>
          <ol className="social-empty-steps" aria-label="Social content setup steps">
            <li className={emptyState.canCreate ? "done" : "current"}><b>1</b><span>Confirm services</span></li>
            <li className={emptyState.canCreate ? "current" : ""}><b>2</b><span>Create categories</span></li>
            <li><b>3</b><span>Generate topics</span></li>
          </ol>
        </section>
      ) : (
      <div className="poollayout">
        {/* ── Categories ── */}
        <nav className="poolnav" aria-label="Topic categories">
          {/*
            * Adding a category is an action, so it looks like one.
            *
            * It sat at the foot of the list styled as a nav item, where it
            * read as a tenth category called "+ New category" and was below
            * the fold on a short window. At the top, as a button, it is the
            * one thing here that is not a category.
            *
            * The seeded set comes from an industry match, which is a good
            * default and never the whole truth about a client — so this needs
            * to be findable, not discoverable.
            */}
          {canEdit && categories.length > 0 ? (
            <button
              type="button"
              className="poolnav-new"
              onClick={() => setEditing({ name: "", description: "", targetCount: 16 })}
            >
              + New category
            </button>
          ) : null}

          {categories.map((c) => {
            const n = live(c).length;
            const full = n >= c.targetCount;
            const isActive = c.id === active?.id;
            return (
              <div key={c.id} className={`poolnav-row${isActive ? " active" : ""}`}>
                <button
                  type="button"
                  className="poolnav-item"
                  aria-current={isActive ? "true" : undefined}
                  onClick={() => { setActiveId(c.id); setQuery(""); setAudience(""); }}
                >
                  <span className="poolnav-name">{c.name}</span>
                  <span className={`poolcount${full ? " full" : ""}${n === 0 ? " empty" : ""}`}>
                    {n}/{c.targetCount}
                  </span>
                </button>

                {/*
                  * Edit and remove live on the row they act on.
                  *
                  * This was a pencil beside the active category's heading,
                  * revealed on hovering the heading — which meant there was
                  * nothing on screen to say a category could be edited at
                  * all, and removing one was two steps behind that. Here the
                  * control is on every row, so the set is visibly editable.
                  */}
                {canEdit ? (
                  <button
                    type="button"
                    className="poolnav-edit"
                    title={`Edit ${c.name}`}
                    aria-label={`Edit ${c.name}`}
                    onClick={() => setEditing({
                      id: c.id,
                      name: c.name,
                      description: c.description,
                      targetCount: c.targetCount,
                    })}
                  >
                    <IconEdit size={13} />
                  </button>
                ) : null}
              </div>
            );
          })}
        </nav>

        {/* ── Topics ── */}
        <div style={{ minWidth: 0 }}>
          {editing ? (
            <form
              className="cateditor"
              onSubmit={(e) => { e.preventDefault(); void saveCategory(); }}
            >
              <h3>{editing.id ? "Edit category" : "New category"}</h3>

              <label>
                <span>Name</span>
                <input
                  type="text"
                  value={editing.name}
                  autoFocus
                  maxLength={80}
                  placeholder="Managing Your Medication"
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                />
              </label>

              <label>
                <span>What it covers</span>
                <textarea
                  rows={3}
                  value={editing.description}
                  maxLength={600}
                  placeholder="Refills, timing, storage, side effects, what to ask before starting something new."
                  onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                />
                {/* This text is what steers generation, so it is worth saying
                    that it does real work rather than labelling the box. */}
                <em>Steers what gets written for this category. Be specific.</em>
              </label>

              <label className="cateditor-count">
                <span>How many topics</span>
                <input
                  type="number"
                  min={1}
                  max={60}
                  value={editing.targetCount}
                  onChange={(e) =>
                    setEditing({ ...editing, targetCount: Number(e.target.value) || 1 })}
                />
              </label>

              <div className="row" style={{ gap: 8, marginTop: 4 }}>
                <button type="submit" className="btn primary small"
                        disabled={busy !== null || !editing.name.trim()}>
                  {busy === "category" ? "Saving…" : editing.id ? "Save changes" : "Add category"}
                </button>
                <button type="button" className="btn small" disabled={busy !== null}
                        onClick={() => { setEditing(null); setError(null); }}>
                  Cancel
                </button>
                {editing.id ? (
                  <button
                    type="button"
                    className="btn danger small"
                    style={{ marginLeft: "auto" }}
                    disabled={busy !== null}
                    onClick={() => void deleteCategory(editing.id!)}
                  >
                    Remove
                  </button>
                ) : null}
              </div>
            </form>
          ) : null}

          {active ? (
            <>
              <div className="poolbar">
                <input
                  type="search"
                  className="poolsearch"
                  placeholder="Search topics…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  aria-label="Search topics in this category"
                />
                <div className="chips" role="group" aria-label="Filter by audience">
                  {filters.map((f) => (
                    <button
                      key={f.key}
                      type="button"
                      className={`chip${shown === f.key ? " on" : ""}`}
                      aria-pressed={shown === f.key}
                      onClick={() => setAudience(f.key)}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="row" style={{ justifyContent: "space-between", alignItems: "center", margin: "16px 0 12px" }}>
                <div>
                  <h3 style={{ margin: 0, fontSize: 17 }}>{active.name}</h3>
                  <p className="small muted" style={{ margin: "4px 0 0", maxWidth: "70ch" }}>
                    {active.description}
                  </p>
                </div>

                {canEdit && !blockedReason ? (
                  <button
                    type="button"
                    className="actionbtn"
                    style={live(active).length >= active.targetCount ? undefined : {
                      background: "var(--accent)", borderColor: "var(--accent)", color: "#fff",
                    }}
                    disabled={busy !== null || live(active).length >= active.targetCount}
                    onClick={() => void generate(active.id)}
                  >
                    <span className="actionbtn-icon" aria-hidden><IconSpark size={15} /></span>
                    <span style={{ whiteSpace: "nowrap", fontSize: 13 }}>
                      {busy === active.id
                        ? "Writing…"
                        : live(active).length >= active.targetCount
                          ? "Full"
                          : `Generate ${active.targetCount - live(active).length}`}
                    </span>
                  </button>
                ) : null}
              </div>

              {visible.length === 0 ? (
                <div className="empty">
                  <strong>
                    {live(active).length === 0 ? "No topics yet" : "Nothing matches"}
                  </strong>
                  <span>
                    {live(active).length === 0
                      ? `Generate ${active.targetCount} to fill this category.`
                      : "Try a different search or audience."}
                  </span>
                </div>
              ) : (
                <div className="poolgrid">
                  {visible.map((t) => (
                    <article
                      className={`poolcard${selected.has(t.id) ? " picked" : ""}`}
                      key={t.id}
                    >
                      <div className="poolcard-head">
                        <strong className="poolcard-title">{t.title}</strong>
                        {canEdit ? (
                          <label className="poolpick" title="Pick for a month">
                            <input
                              type="checkbox"
                              checked={selected.has(t.id)}
                              onChange={() => toggle(t.id)}
                            />
                            <span className="sr-only">Pick &ldquo;{t.title}&rdquo; for a month</span>
                          </label>
                        ) : null}
                      </div>

                      <p className="poolcard-hook">{t.hook}</p>

                      {t.imageIdea ? (
                        <p className="poolcard-image">
                          <strong>Image idea:</strong> {t.imageIdea}
                        </p>
                      ) : null}

                      <div className="poolcard-foot">
                        <span className={`badge ${AUDIENCE_CLASS[t.audience] ?? "neutral"}`}>
                          {t.audience.replace(" specific", "")}
                        </span>

                        {/*
                          * Format is a control, not a label.
                          *
                          * The model's choice is a starting point, and a
                          * reviewer who wants a carousel instead of a static
                          * image should not have to regenerate the topic to
                          * get one.
                          */}
                        {canEdit ? (
                          <select
                            className="poolformat"
                            value={t.format}
                            aria-label={`Format for "${t.title}"`}
                            onChange={(e) => void changeFormat(t.id, e.target.value)}
                          >
                            {FORMAT_OPTIONS.map((f) => (
                              <option key={f} value={f}>{f}</option>
                            ))}
                          </select>
                        ) : (
                          <span className="badge neutral">{t.format}</span>
                        )}

                        {canEdit ? (
                          <button type="button" className="btn small" style={{ marginLeft: "auto" }}
                                  onClick={() => void reject(t.id)}>
                            Reject
                          </button>
                        ) : null}
                      </div>

                      {t.dateLabel || t.recommended ? (
                        <div className="poolcard-tags">
                          {t.dateLabel ? (
                            <span
                              className="datepill"
                              title={t.dateRule ? `Derived from: ${t.dateRule}` : undefined}
                            >
                              📌 {t.dateLabel}
                            </span>
                          ) : null}
                          {t.recommended ? (
                            <span
                              className="recpill"
                              title={t.recommendedWhy ?? undefined}
                            >
                              ★ Recommended
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                    </article>
                  ))}
                </div>
              )}
            </>
          ) : null}

          {/*
            * The count, where the decision is made.
            *
            * Shown against the usual 12 to 14 posts a month rather than as a
            * bare number: "15 selected" means nothing without knowing what a
            * month normally holds.
            */}
          {selected.size > 0 ? (
            <div className="selectbar" role="status">
              <span>
                <strong>{selected.size}</strong> selected
                {selected.size < 12 ? (
                  <span className="selectbar-note"> · below the usual 12 to 14</span>
                ) : selected.size > 14 ? (
                  <span className="selectbar-note"> · above the usual 12 to 14</span>
                ) : (
                  <span className="selectbar-ok"> · right in the usual 12 to 14</span>
                )}
              </span>
              <button type="button" className="btn small" onClick={() => { setSelected(new Set()); setSelectedPlan(null); }}>
                Clear
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={busy !== null || !businessId}
                onClick={() => void planSelected("preview")}
              >
                {busy === "calendar" ? "Building…" : "Preview selected →"}
              </button>
            </div>
          ) : null}

          {selectedPlan ? (
            <section className="card selected-plan-preview" aria-label="Selected topics calendar preview">
              <div className="row" style={{ justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                <div>
                  <strong>Calendar preview</strong>
                  <p className="small muted" style={{ margin: "3px 0 0" }}>
                    Review the dates before scheduling these {selectedPlan.slots.length} posts.
                  </p>
                </div>
                <button type="button" className="btn primary" disabled={busy !== null}
                        onClick={() => void planSelected("commit")}>
                  {busy === "calendar" ? "Scheduling…" : "Schedule posts"}
                </button>
              </div>
              {selectedPlan.warnings.length > 0 ? (
                <div className="finding selected-plan-warning">
                  {selectedPlan.warnings.map((warning) => <p className="small" key={warning}>{warning}</p>)}
                </div>
              ) : null}
              <div className="planlist">
                {selectedPlan.slots.map((slot) => (
                  <div className="planrow" key={slot.topicId}>
                    <span className="planrow-date">
                      {new Date(`${slot.date}T12:00:00Z`).toLocaleDateString("en-US", {
                        weekday: "short", day: "numeric", timeZone: "UTC",
                      })}
                    </span>
                    <span className="planrow-title">{slot.title}</span>
                    <span className="planrow-meta">{slot.format}</span>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {/*
            * What the model declined to write.
            *
            * Shown rather than dropped: a run that asked for sixteen and
            * returned twelve looks broken, where one that says "rejected:
            * novelty day, no action a reader can take" is doing its job.
            */}
          {rejected.length > 0 ? (
            <div className="card" style={{ marginTop: 18 }}>
              <strong style={{ fontSize: 14 }}>Not written, and why</strong>
              <div style={{ marginTop: 10 }}>
                {rejected.map((r, i) => (
                  <p className="small muted" key={i} style={{ margin: "0 0 8px", maxWidth: "80ch" }}>
                    <strong>{r.topic}</strong>: {r.reason}
                  </p>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>
      )}
    </>
  );
}
