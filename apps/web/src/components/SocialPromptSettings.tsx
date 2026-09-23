"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * How this workspace wants its social posts written.
 *
 * Three boxes for the three model calls the social pipeline makes: one that
 * decides which topics enter the pool, one that writes the caption, one that
 * describes the image. Plus a reference post, which teaches more than any of
 * them, and the words the brand refuses to use.
 *
 * Separate from the blog's settings on purpose. The same workspace can want
 * long, link-rich articles and short, plain captions, and one shared box would
 * force a compromise that suits neither.
 *
 * What this is NOT: the whole prompt. The rules that keep a post factual and
 * legal are not shown and not editable, because a customer cannot be expected
 * to know that deleting one line lets the model invent a statistic about a
 * medical condition.
 */

export interface SocialPrompts {
  topics: string;
  post: string;
  image: string;
  reference: string;
  wordsToAvoid: string[];
}

const LIMITS = { topics: 8000, post: 8000, image: 4000, reference: 20000 } as const;

const PLACEHOLDER = {
  topics:
    "e.g. Every topic must land on one concrete thing a reader can do this " +
    "week. Prefer the moment someone is actually deciding something. No " +
    "awareness-day posts that just name the day.",
  post:
    "e.g. Open on a real moment, never a greeting. Short paragraphs. Give the " +
    "reason behind every claim. Close deliberately, never on a hashtag.",
  image:
    "e.g. Full-bleed photo with the cyan #46C8F5 bottom wave. Caregivers " +
    "always in blue scrubs. Never draw a logo, the top band is reserved. No " +
    "legible wording in the photo.",
  reference:
    "Paste a post you would be happy to have written. The model matches its " +
    "depth, structure and tone, not its facts.",
} as const;

export function SocialPromptSettings({
  initial,
  canEdit,
  startOpen = false,
}: {
  initial: SocialPrompts;
  canEdit: boolean;
  startOpen?: boolean;
}) {
  const router = useRouter();
  const [v, setV] = useState<SocialPrompts>(initial);
  const [words, setWords] = useState(initial.wordsToAvoid.join("\n"));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wordList = words.split("\n").map((w) => w.trim()).filter(Boolean);
  const dirty =
    v.topics !== initial.topics ||
    v.post !== initial.post ||
    v.image !== initial.image ||
    v.reference !== initial.reference ||
    wordList.join("\n") !== initial.wordsToAvoid.join("\n");

  /*
   * Over-length blocks the save rather than trimming the text.
   *
   * A `maxLength` on the textarea silently stops accepting characters partway
   * through a paste: the box looks full, the instructions look present, and
   * the last third is gone. That only surfaces later as posts that came back
   * subtly wrong.
   */
  const tooLong = (["topics", "post", "image", "reference"] as const)
    .filter((k) => v[k].length > LIMITS[k]);

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/social/prompts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...v, wordsToAvoid: wordList }),
      });
      if (!res.ok) {
        const body: unknown = await res.json();
        setError((body as { error?: { message?: string } }).error?.message ?? "That did not save.");
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

  if (!startOpen) return null;

  return (
    <div className="card" style={{ marginBottom: 18 }}>
      <Box
        label="Topic ideas"
        hint="Shapes which topics enter the pool when you generate a category."
        value={v.topics}
        max={LIMITS.topics}
        placeholder={PLACEHOLDER.topics}
        disabled={!canEdit || busy}
        onChange={(topics) => setV({ ...v, topics })}
      />

      <Box
        label="Post writing"
        hint="Shapes the caption: voice, structure, how a post opens and closes."
        value={v.post}
        max={LIMITS.post}
        placeholder={PLACEHOLDER.post}
        disabled={!canEdit || busy}
        onChange={(post) => setV({ ...v, post })}
      />

      <Box
        label="Image direction"
        hint="Layout, brand colours and anything the image must never contain."
        value={v.image}
        max={LIMITS.image}
        placeholder={PLACEHOLDER.image}
        disabled={!canEdit || busy}
        onChange={(image) => setV({ ...v, image })}
      />

      <Box
        label="Reference post"
        hint="An example of what good looks like. Used for style only, never for its facts."
        value={v.reference}
        max={LIMITS.reference}
        placeholder={PLACEHOLDER.reference}
        rows={8}
        disabled={!canEdit || busy}
        onChange={(reference) => setV({ ...v, reference })}
      />

      <label className="field" style={{ marginBottom: 18 }}>
        <span className="fieldlabel">
          Words to avoid · {wordList.length}
        </span>
        <textarea
          rows={4}
          value={words}
          disabled={!canEdit || busy}
          placeholder={"One per line, e.g.\npeace of mind\nloved ones\ngolden years\njourney"}
          onChange={(e) => setWords(e.target.value)}
          style={{ width: "100%", fontFamily: "inherit", lineHeight: 1.6, resize: "vertical" }}
        />
        <span className="hint">
          Clichés the copy must never use. One per line.
        </span>
      </label>

      <p className="small muted" style={{ margin: "0 0 14px", maxWidth: "72ch" }}>
        These are added to the built-in instructions, not swapped for them. The rules that
        keep a post factual, never invent a statistic about a condition, and never tell
        anyone to change a treatment, always apply, and nothing typed here can switch them off.
      </p>

      {canEdit ? (
        <div className="row" style={{ gap: 10 }}>
          <button type="button" className="btn primary"
                  disabled={busy || !dirty || tooLong.length > 0}
                  onClick={() => void save()}>
            {busy ? "Saving…" : "Save instructions"}
          </button>
          <button type="button" className="btn" disabled={busy || !dirty}
                  onClick={() => {
                    setV(initial);
                    setWords(initial.wordsToAvoid.join("\n"));
                    setError(null); setSaved(false);
                  }}>
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
          One or more boxes are over the limit. Shorten them to save.
        </p>
      ) : null}
      {error ? <p className="error" style={{ marginTop: 12 }}>{error}</p> : null}
      {saved && !error ? (
        <p className="small muted" style={{ marginTop: 12 }}>
          Saved. The next topics and the next posts will use these.
        </p>
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
