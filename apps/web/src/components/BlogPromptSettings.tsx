"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { IconEdit, IconChevron } from "./Icons";

/**
 * How this workspace wants its blog written.
 *
 * Two boxes for the two model calls the blog pipeline makes — one that decides
 * which topics get proposed, one that decides how the article reads — plus a
 * reference article, which in practice teaches more than either box. A customer
 * pasting something they liked communicates depth, structure and register in a
 * way no adjective does.
 *
 * What this is NOT: the whole prompt. The instructions that keep a draft
 * grounded — only write about services this business sells, never invent a URL,
 * never claim a location they do not serve — are not shown and not editable,
 * because a customer cannot be expected to know that deleting one line would
 * let the model start making things up. This steers editorial judgement, which
 * is the part they are the authority on.
 *
 * Collapsed by default: it is set once and then rarely touched, and this page
 * is for choosing a topic.
 */

export interface BlogPrompts {
  topics: string;
  article: string;
  reference: string;
}

const LIMITS = { topics: 8000, article: 8000, reference: 20000 } as const;

const LABELS = {
  topics: "Topic suggestions",
  article: "Article writing",
  reference: "Reference article",
} as const;

const PLACEHOLDER = {
  topics:
    "e.g. Lean towards practical decision-making guides for families, not " +
    "industry news. Prefer topics someone would search at the moment they are " +
    "comparing options. Avoid anything seasonal.",
  article:
    "e.g. Short paragraphs, plain English, no jargon. Open with the reader's " +
    "situation rather than with the company. Use a comparison table where it " +
    "helps. British spelling.",
  reference:
    "Paste an article you would be happy to have written — yours or anyone's. " +
    "The model matches its depth, structure and tone, not its facts.",
} as const;

export function BlogPromptSettings({
  initial,
  canEdit,
  startOpen = false,
}: {
  initial: BlogPrompts;
  canEdit: boolean;
  /**
   * Open on mount, with no header of its own — used when the page header
   * already carries the button that revealed this panel. Two disclosure
   * controls for one panel is one too many.
   */
  startOpen?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(startOpen);
  const [v, setV] = useState<BlogPrompts>(initial);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty =
    v.topics !== initial.topics ||
    v.article !== initial.article ||
    v.reference !== initial.reference;

  /*
   * Over-length blocks the save rather than trimming the text.
   *
   * The textarea used to carry `maxLength`, which silently stops accepting
   * characters partway through a paste — the box looks full, the prompt looks
   * present, and the last third is simply gone. That damage only surfaces later
   * as a draft that came back subtly wrong. Better to keep every character the
   * customer pasted and refuse to save until it fits.
   */
  const tooLong = (["topics", "article", "reference"] as const)
    .filter((k) => v[k].length > LIMITS[k]);

  const configured = [initial.topics, initial.article, initial.reference]
    .filter((s) => s.trim()).length;

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/blog/prompts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(v),
      });
      if (!res.ok) {
        const body: unknown = await res.json();
        setError(
          (body as { error?: { message?: string } }).error?.message ?? "That did not save.",
        );
        return;
      }
      setSaved(true);
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginBottom: 22 }}>
      {/*
        * The whole header is the control.
        *
        * A card that opens only from a button in its corner reads as static
        * text with a button next to it — the screenshot showed people missing
        * it. Making the header itself the button, with a chevron that turns,
        * is the disclosure pattern people already know from every settings
        * panel they have used.
        */}
      {startOpen ? null : (
      <button
        type="button"
        className="disclosure"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="disclosure-icon" aria-hidden><IconEdit size={16} /></span>

        <span className="disclosure-text">
          <strong>Writing instructions</strong>
          <span className="small muted" style={{ display: "block", marginTop: 4, maxWidth: "72ch" }}>
            Tell the model what kind of topics to suggest and how you want the articles
            written. Applies to every blog this workspace generates from now on.
          </span>
        </span>

        <span className="row" style={{ gap: 10, alignItems: "center", flexShrink: 0 }}>
          <span className={`badge ${configured ? "ok" : "neutral"}`}>
            {configured ? `${configured} set` : "using defaults"}
          </span>
          <span className={`chev${open ? " open" : ""}`} aria-hidden>
            <IconChevron size={16} />
          </span>
        </span>
      </button>
      )}

      {open ? (
        <div style={{ marginTop: startOpen ? 0 : 18 }}>
          <Box
            label="Topic suggestions"
            hint="Shapes which topics get proposed when you press Suggest topics."
            value={v.topics}
            max={LIMITS.topics}
            placeholder={PLACEHOLDER.topics}
            disabled={!canEdit || busy}
            onChange={(topics) => setV({ ...v, topics })}
          />

          <Box
            label="Article writing"
            hint="Shapes how the draft reads — voice, structure, level of detail."
            value={v.article}
            max={LIMITS.article}
            placeholder={PLACEHOLDER.article}
            disabled={!canEdit || busy}
            onChange={(article) => setV({ ...v, article })}
          />

          <Box
            label="Reference article"
            hint="An example of what good looks like. Used for style only — its facts are never copied."
            value={v.reference}
            max={LIMITS.reference}
            placeholder={PLACEHOLDER.reference}
            rows={8}
            disabled={!canEdit || busy}
            onChange={(reference) => setV({ ...v, reference })}
          />

          <p className="small muted" style={{ margin: "0 0 14px", maxWidth: "72ch" }}>
            These are added to the built-in instructions, not swapped for them. The rules
            that keep a draft factual — write only about services you actually offer, never
            invent a link, never claim a location you do not serve — always apply, and
            nothing typed here can switch them off.
          </p>

          {canEdit ? (
            <div className="row" style={{ gap: 10 }}>
              <button type="button" className="btn primary"
                      disabled={busy || !dirty || tooLong.length > 0}
                      onClick={() => void save()}>
                {busy ? "Saving…" : "Save instructions"}
              </button>
              <button type="button" className="btn" disabled={busy || !dirty}
                      onClick={() => { setV(initial); setError(null); setSaved(false); }}>
                Discard
              </button>
            </div>
          ) : (
            <p className="small muted" style={{ margin: 0 }}>
              You need editor access to change these.
            </p>
          )}

          {tooLong.length > 0 ? (
            <p className="error" style={{ marginTop: 12 }}>
              {tooLong.length === 1
                ? `The ${LABELS[tooLong[0]!]} box is ${(v[tooLong[0]!].length - LIMITS[tooLong[0]!]).toLocaleString()} characters over. Shorten it to save.`
                : "Two or more boxes are over the limit. Shorten them to save."}
            </p>
          ) : null}

          {error ? <p className="error" style={{ marginTop: 12 }}>{error}</p> : null}
          {saved && !error ? (
            <p className="small muted" style={{ marginTop: 12 }}>
              Saved. The next topic suggestion and the next draft will use these.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Box({
  label, hint, value, max, placeholder, rows = 4, disabled, onChange,
}: {
  label: string;
  hint: string;
  value: string;
  max: number;
  placeholder: string;
  rows?: number;
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  const over = value.length > max;
  return (
    <label className="field" style={{ marginBottom: 18 }}>
      <span className="fieldlabel">
        {label} · {value.length.toLocaleString()}/{max.toLocaleString()}
      </span>
      <textarea
        value={value}
        rows={rows}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={{ width: "100%", fontFamily: "inherit", lineHeight: 1.6, resize: "vertical" }}
      />
      <span className="hint" style={over ? { color: "var(--warn)" } : undefined}>{hint}</span>
    </label>
  );
}
