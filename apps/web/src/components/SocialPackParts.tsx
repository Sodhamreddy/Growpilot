"use client";

import { useState } from "react";
import type { SocialContentPack } from "@ob/db";

/**
 * Pieces shared by the content pack (step 3) and image pack (step 4) views:
 * the post they both show, its date formats, and the blocks their dialogs are
 * built from. One source, so the two steps cannot drift apart visually.
 */

export interface PackPost {
  id: string;
  /** "YYYY-MM-DD". */
  date: string;
  title: string;
  hook: string;
  audience: string;
  format: string;
  occasion: string | null;
  categoryName: string;
  status: "scheduled" | "written" | "approved" | "published";
  pack: SocialContentPack | null;
  /** Where the pack misses the planner's measurements. */
  warnings: string[];
}

export const dateOf = (iso: string) => new Date(`${iso}T12:00:00Z`);
export const weekday = (iso: string) => dateOf(iso).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
export const chipDate = (iso: string) =>
  `${dateOf(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })} · ${weekday(iso)}`;

/** One block of the pack: a label, an optional note on the right, Copy, then the content. */
export function Section({ label, aside, copy, hint, warnings, children }: {
  label: string;
  aside?: React.ReactNode;
  copy?: string;
  hint?: string;
  warnings?: string[];
  children: React.ReactNode;
}) {
  return (
    <section className="spd-section">
      <div className="spd-section-head">
        <h4>{label}</h4>
        <div className="spd-section-tools">
          {aside}
          {copy !== undefined ? <CopyButton text={copy} /> : null}
        </div>
      </div>
      {hint ? <p className="spd-hint">{hint}</p> : null}
      {children}
      {warnings?.length ? <Warnings list={warnings} /> : null}
    </section>
  );
}

export function Warnings({ list }: { list: string[] }) {
  return (
    <ul className="spack-warnings">
      {list.map((w) => <li key={w}>{w}</li>)}
    </ul>
  );
}

export function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  return (
    <button
      type="button"
      className={`spd-copy ${state}`}
      disabled={!text}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setState("done");
        } catch {
          setState("failed");
        }
        setTimeout(() => setState("idle"), 1600);
      }}
    >
      {state === "done" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}
    </button>
  );
}

export function PinIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 20 20" fill="none" aria-hidden>
      <path d="M7 2.5h6l-1 5 3 3H5l3-3-1-5ZM10 10.5V17" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
