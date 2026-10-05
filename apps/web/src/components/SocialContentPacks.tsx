"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { SocialContentPack } from "@ob/db";
import { IconSpark } from "./Icons";
import { SocialRichText } from "./SocialRichText";
import { Section, Warnings, CopyButton, PinIcon, dateOf, weekday, chipDate, type PackPost } from "./SocialPackParts";

export type { PackPost };
import { CAPTION_WORDS, X_LIMIT, fitToX } from "@ob/social/text";
import { markdownToPlain, pictureFor, SOCIAL_FORMATS } from "@/lib/social-text";

/**
 * Step 3: the month's posts, written, read and approved.
 *
 * A grid of small portrait cards, one per post, shaped like the post itself
 * rather than a row in a table: a month is easier to judge when a dozen posts
 * are on screen at once. A card opens the post's full pack in a dialog laid
 * out the way it will be used: the caption the three long-form networks
 * share, the hashtags, X's own shorter post, and the words on the image, each
 * with its own Copy.
 *
 * Edits save themselves a moment after typing stops, and on closing. Written
 * one post per request, including "write all", so a voice that is wrong costs
 * one post rather than a month.
 *
 * An approved pack is read-only. Changing it means setting it back to
 * Written first, because an approval is for particular words.
 */


type Draft = Pick<SocialContentPack, "caption" | "shortCaption" | "imageBrief" | "altText" | "formatExtra"> & {
  /** Space separated while editing. */
  hashtags: string;
  imageText: string;
};

type SaveState = "saving" | "saved" | "failed";

const STATUS_LABEL: Record<PackPost["status"], string> = {
  scheduled: "Not started",
  written: "Written",
  approved: "Approved",
  published: "Published",
};

/** How long typing has to pause before an edit is saved. */
const SAVE_AFTER_MS = 1200;


const toDraft = (p: SocialContentPack): Draft => ({
  caption: p.caption,
  shortCaption: p.shortCaption,
  hashtags: p.hashtags.join(" "),
  imageBrief: p.imageBrief,
  altText: p.altText,
  formatExtra: p.formatExtra,
  imageText: p.imageText ?? "",
});

const splitTags = (s: string) => s.split(/[\s,]+/).filter(Boolean);
const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** Which section of the pack a warning is about, so it can sit under it. */
function sectionOf(warning: string): "caption" | "x" | "hashtags" | "brief" | "extra" | "general" {
  if (/\bX post\b/.test(warning)) return "x";
  if (/^Caption|caption body/i.test(warning)) return "caption";
  if (/hashtag/i.test(warning)) return "hashtags";
  if (/^(Image brief|Alt text)/.test(warning)) return "brief";
  if (/carousel|slides/i.test(warning)) return "extra";
  return "general";
}

async function call(method: "POST" | "PATCH", body: unknown, url = "/api/social/pack") {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as {
    status?: PackPost["status"];
    pack?: SocialContentPack;
    warnings?: string[];
    error?: { message?: string };
  };
  if (!res.ok) throw new Error(json.error?.message ?? "That did not work.");
  return json;
}

export function SocialContentPacks({
  posts: initial,
  canEdit,
  blockedReason,
  monthName,
  monthKey,
  autoWrite = false,
}: {
  posts: PackPost[];
  canEdit: boolean;
  blockedReason: string | null;
  monthName: string;
  monthKey: string;
  /** Start writing every unwritten post as soon as the page opens. */
  autoWrite?: boolean;
}) {
  const router = useRouter();
  const [posts, setPosts] = useState(initial);
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  /*
   * Edits not yet saved, per post.
   *
   * Kept outside the dialog so closing it cannot lose them: a save still
   * pending runs on close, and one that failed stays here, flagged on the
   * card, until it goes through or the post is rewritten.
   */
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [saveState, setSaveState] = useState<Record<string, SaveState>>({});
  const [confirmRewrite, setConfirmRewrite] = useState(false);
  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null);
  const stop = useRef(false);
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  // The latest drafts for timers and flushes, which outlive the render they were made in.
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;

  const update = (id: string, patch: Partial<PackPost>) =>
    setPosts((all) => all.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  const setBusyFor = (id: string, what: string | null) =>
    setBusy((b) => {
      const next = { ...b };
      if (what) next[id] = what; else delete next[id];
      return next;
    });
  const setErrorFor = (id: string, message: string | null) =>
    setErrors((e) => {
      const next = { ...e };
      if (message) next[id] = message; else delete next[id];
      return next;
    });
  /** Forget a draft, but only if it is still the one that was saved. */
  const dropDraft = (id: string, ifStill?: Draft) =>
    setDrafts((d) => {
      if (!(id in d) || (ifStill && d[id] !== ifStill)) return d;
      const next = { ...d };
      delete next[id];
      return next;
    });
  const cancelSave = (id: string) => {
    clearTimeout(timers.current[id]);
    delete timers.current[id];
  };

  const draftFor = (p: PackPost): Draft | null => drafts[p.id] ?? (p.pack ? toDraft(p.pack) : null);
  const isDirty = (p: PackPost) =>
    drafts[p.id] !== undefined && p.pack !== null && JSON.stringify(drafts[p.id]) !== JSON.stringify(toDraft(p.pack));

  async function write(id: string): Promise<boolean> {
    cancelSave(id);
    setBusyFor(id, "write");
    setErrorFor(id, null);
    setConfirmRewrite(false);
    try {
      const res = await call("POST", { topicId: id });
      update(id, { status: res.status ?? "written", pack: res.pack ?? null, warnings: res.warnings ?? [] });
      dropDraft(id);
      return true;
    } catch (err) {
      setErrorFor(id, err instanceof Error ? err.message : "Could not reach the server.");
      return false;
    } finally {
      setBusyFor(id, null);
    }
  }

  async function saveDraft(id: string, draft: Draft): Promise<boolean> {
    cancelSave(id);
    setSaveState((s) => ({ ...s, [id]: "saving" }));
    try {
      const res = await call("PATCH", {
        topicId: id, action: "save", pack: { ...draft, hashtags: splitTags(draft.hashtags) },
      });
      update(id, { status: res.status ?? "written", pack: res.pack ?? null, warnings: res.warnings ?? [] });
      // Typing that continued during the request is a newer draft, and stays.
      dropDraft(id, draft);
      setErrorFor(id, null);
      setSaveState((s) => ({ ...s, [id]: "saved" }));
      return true;
    } catch (err) {
      setErrorFor(id, err instanceof Error ? err.message : "Could not reach the server.");
      setSaveState((s) => ({ ...s, [id]: "failed" }));
      return false;
    }
  }

  function editDraft(id: string, draft: Draft) {
    // Saving turns a pack back to Written, so an approved one is never saved from here.
    const post = posts.find((p) => p.id === id);
    if (!post?.pack || post.status === "approved" || post.status === "published") return;
    // An "edit" that restores the saved text is no edit: forget the draft.
    if (JSON.stringify(draft) === JSON.stringify(toDraft(post.pack))) {
      cancelSave(id);
      dropDraft(id);
      return;
    }
    setDrafts((all) => ({ ...all, [id]: draft }));
    cancelSave(id);
    timers.current[id] = setTimeout(() => void saveDraft(id, draft), SAVE_AFTER_MS);
  }

  /** Save now whatever is waiting to be saved. True when nothing is left unsaved. */
  async function flush(id: string): Promise<boolean> {
    const draft = draftsRef.current[id];
    if (!draft) return true;
    return saveDraft(id, draft);
  }

  async function setStatus(id: string, to: "approved" | "written") {
    if (!(await flush(id))) return;
    setBusyFor(id, "status");
    setErrorFor(id, null);
    try {
      const res = await call("PATCH", { topicId: id, action: to === "approved" ? "approve" : "unapprove" });
      update(id, { status: res.status ?? to, pack: res.pack ?? null, warnings: res.warnings ?? [] });
    } catch (err) {
      setErrorFor(id, err instanceof Error ? err.message : "Could not reach the server.");
    } finally {
      setBusyFor(id, null);
    }
  }

  /*
   * A new format is a different post, so the copy is rewritten for it.
   *
   * A carousel needs slides and a reel needs a script; keeping a static
   * post's caption under a new format would leave the pack describing a post
   * that no longer exists.
   */
  async function changeFormat(post: PackPost, format: string) {
    if (format === post.format) return;
    setBusyFor(post.id, "format");
    setErrorFor(post.id, null);
    try {
      await call("PATCH", { topicId: post.id, action: "edit", format }, "/api/social/topics");
      update(post.id, { format });
    } catch (err) {
      setErrorFor(post.id, err instanceof Error ? err.message : "Could not reach the server.");
      setBusyFor(post.id, null);
      return;
    }
    setBusyFor(post.id, null);
    if (post.pack) await write(post.id);
  }

  async function writeAll() {
    const queue = posts.filter((p) => p.status === "scheduled").map((p) => p.id);
    stop.current = false;
    setBulk({ done: 0, total: queue.length });
    for (const [i, id] of queue.entries()) {
      if (stop.current) break;
      const ok = await write(id);
      setBulk({ done: i + 1, total: queue.length });
      // A failure is usually the same failure for every post that follows:
      // budget, rate limit, a missing profile. Stop rather than repeat it.
      if (!ok) break;
    }
    setBulk(null);
  }

  /*
   * Confirming the calendar hands over here with ?write=all.
   *
   * The flag is dropped from the URL straight away, so a refresh halfway
   * through does not start a second run over the same posts. The ref guards
   * against the effect running twice in development's strict mode.
   */
  const started = useRef(false);
  useEffect(() => {
    if (!autoWrite || started.current) return;
    started.current = true;
    router.replace(`/social/content?month=${monthKey}`, { scroll: false });
    if (canEdit && !blockedReason && posts.some((p) => p.status === "scheduled")) void writeAll();
    // Runs once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const open = (p: PackPost) => { setOpenId(p.id); setConfirmRewrite(false); };
  const close = () => {
    if (openId) void flush(openId);
    setOpenId(null);
    setConfirmRewrite(false);
  };

  const count = (s: PackPost["status"]) => posts.filter((p) => p.status === s).length;
  const unwritten = count("scheduled");
  const done = posts.length - unwritten;
  const approved = count("approved") + count("published");
  const editable = canEdit && !blockedReason;
  const openPost = posts.find((p) => p.id === openId) ?? null;

  if (posts.length === 0) {
    return (
      <div className="socal-empty">
        {blockedReason ?? (
          <>Nothing is on the calendar for {monthName} yet. Plan the month first and its posts appear here to be written.
            {" "}<Link href="/social">Plan it from the Topic Pool</Link></>
        )}
      </div>
    );
  }

  return (
    <section className="spack" aria-label={`Content packs for ${monthName}`}>
      <div className="spack-summary">
        <div className="spack-progress" aria-hidden>
          <span className="spack-bar written" style={{ width: `${(done / posts.length) * 100}%` }} />
          <span className="spack-bar approved" style={{ width: `${(approved / posts.length) * 100}%` }} />
        </div>
        <p>
          <strong>{posts.length}</strong> posts · <strong>{done}</strong> written · <strong>{approved}</strong> approved
          {unwritten ? <span className="socal-muted"> · {unwritten} still to write</span> : null}
        </p>
        {editable && unwritten > 0 ? (
          bulk ? (
            <div className="spack-bulk" role="status">
              <span>Writing {Math.min(bulk.done + 1, bulk.total)} of {bulk.total}…</span>
              <button type="button" className="btn small" onClick={() => { stop.current = true; }}>Stop after this one</button>
            </div>
          ) : (
            <button type="button" className="btn primary" onClick={() => void writeAll()} disabled={Object.keys(busy).length > 0}>
              <IconSpark size={15} /> Write all {unwritten} remaining
            </button>
          )
        ) : null}
      </div>

      {blockedReason ? <div className="socal-empty">{blockedReason}</div> : null}

      <ol className="spack-grid">
        {posts.map((p) => {
          const working = busy[p.id];
          return (
            <li key={p.id} className={`spack-card status-${p.status}${working === "write" ? " is-writing" : ""}`}>
              <div className="spack-card-top">
                <span className="spack-date">
                  <small>{weekday(p.date)}</small>
                  <b>{dateOf(p.date).getUTCDate()}</b>
                </span>
                <span className={`spack-status ${p.status}`}>{STATUS_LABEL[p.status]}</span>
              </div>
              {isDirty(p) ? (
                <span className="spack-card-dirty">{saveState[p.id] === "failed" ? "Edits not saved" : "Saving edits…"}</span>
              ) : null}

              <h3 className="spack-card-title">
                <button type="button" onClick={() => open(p)} title="Open this post">{p.title}</button>
              </h3>
              <p className="spack-card-meta">{p.format} · {p.audience}</p>
              {p.occasion ? <p className="spack-card-occ" title={p.occasion}>{p.occasion}</p> : null}

              <p className="spack-card-text">{p.pack ? markdownToPlain(p.pack.caption) : p.hook}</p>
              {p.pack?.hashtags.length ? <p className="spack-card-tags">{p.pack.hashtags.join(" ")}</p> : null}

              {p.warnings.length ? (
                <p className="spack-card-warn">{p.warnings.length} check{p.warnings.length === 1 ? "" : "s"} to fix</p>
              ) : null}
              {errors[p.id] ? <p className="spack-card-error" title={errors[p.id]}>{errors[p.id]}</p> : null}

              <div className="spack-card-actions">
                {editable && p.status === "scheduled" ? (
                  <button type="button" className="btn primary small" disabled={!!working || !!bulk}
                          onClick={() => void write(p.id)}>
                    {working === "write" ? <><span className="spack-spin" aria-hidden /> Writing…</> : "Write pack"}
                  </button>
                ) : null}
                {p.pack ? (
                  <button type="button" className="btn small" onClick={() => open(p)}>
                    {editable && p.status === "written" ? "Review" : "Open"}
                  </button>
                ) : null}
                {editable && p.status === "written" ? (
                  <button type="button" className="btn primary small" disabled={!!working}
                          onClick={() => void setStatus(p.id, "approved")}>
                    {working === "status" ? "Approving…" : "Approve"}
                  </button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>

      <p className="spack-next">
        Once a post&apos;s copy is approved, make its picture in{" "}
        <Link href={`/social/images?month=${monthKey}`}>step 4, Image pack</Link>. Posts stay on the{" "}
        <Link href={`/social/calendar?month=${monthKey}`}>calendar</Link> with their status as you go.
      </p>

      {openPost ? (
        <PackDialog
          key={openPost.id}
          post={openPost}
          draft={draftFor(openPost)}
          editable={editable}
          working={busy[openPost.id] ?? null}
          error={errors[openPost.id] ?? null}
          saveState={isDirty(openPost) ? (saveState[openPost.id] === "failed" ? "failed" : "saving") : saveState[openPost.id] ?? null}
          bulk={!!bulk}
          confirmRewrite={confirmRewrite}
          onConfirmRewrite={setConfirmRewrite}
          onDraft={(d) => editDraft(openPost.id, d)}
          onWrite={() => void write(openPost.id)}
          onStatus={(to) => void setStatus(openPost.id, to)}
          onFormat={(f) => void changeFormat(openPost, f)}
          onClose={close}
        />
      ) : null}
    </section>
  );
}

/**
 * One post's pack, laid out the way it will be used.
 *
 * A native modal dialog: focus moves into it, Escape and the backdrop close
 * it, and the page behind cannot be clicked by accident. Closing saves
 * whatever is waiting, so Escape cannot throw away a rewritten caption.
 */
function PackDialog({
  post, draft, editable, working, error, saveState, bulk,
  confirmRewrite, onConfirmRewrite, onDraft, onWrite, onStatus, onFormat, onClose,
}: {
  post: PackPost;
  draft: Draft | null;
  editable: boolean;
  working: string | null;
  error: string | null;
  saveState: SaveState | null;
  bulk: boolean;
  confirmRewrite: boolean;
  onConfirmRewrite: (v: boolean) => void;
  onDraft: (d: Draft) => void;
  onWrite: () => void;
  onStatus: (to: "approved" | "written") => void;
  onFormat: (format: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  /** Set when "Fit to 280" could not shorten the post without cutting a sentence. */
  const [cannotFit, setCannotFit] = useState(false);

  const locked = post.status === "approved" || post.status === "published";
  const canWrite = editable && !locked;
  const warningsFor = (section: ReturnType<typeof sectionOf>) => post.warnings.filter((w) => sectionOf(w) === section);
  const formats = SOCIAL_FORMATS.includes(post.format as (typeof SOCIAL_FORMATS)[number])
    ? [...SOCIAL_FORMATS]
    : [post.format, ...SOCIAL_FORMATS];
  const xLength = draft?.shortCaption.length ?? 0;
  const extraLabel = post.format === "Carousel" ? "Carousel slides"
    : post.format === "Video" || post.format === "Podcast" ? "Reel script"
      : "Questions and answers";
  const showExtra = !!draft && (draft.formatExtra || !["Static Image", "Quote", "GIF"].includes(post.format));
  const picture = pictureFor(post.format);

  return (
    <dialog
      ref={ref}
      className="spack-dialog"
      aria-labelledby="spack-dialog-title"
      onClose={onClose}
      onClick={(e) => { if (e.target === ref.current) ref.current?.close(); }}
    >
      <div className="spack-dialog-inner">
        <header className="spd-head">
          <span className="spd-date">{chipDate(post.date)}</span>
          <div className="spd-titlebox">
            <h3 id="spack-dialog-title">{post.title}</h3>
            <div className="spd-pills">
              <span className="spd-aud">{post.audience}</span>
              <label className="spd-format">
                <span className="sr-only">Format</span>
                <select
                  value={post.format}
                  disabled={!canWrite || !!working || bulk}
                  title={locked ? "Set it back to Written to change the format" : "Changing the format rewrites the post"}
                  onChange={(e) => onFormat(e.target.value)}
                >
                  {formats.map((f) => <option key={f} value={f}>{f}</option>)}
                </select>
              </label>
              {post.occasion ? (
                <span className="spd-occ"><PinIcon /> {post.occasion}</span>
              ) : null}
            </div>
          </div>
          <div className="spd-side">
            <label className={`spd-status ${post.status}`}>
              <span className="spd-dot" aria-hidden />
              <b>Content</b>
              <select
                value={post.status}
                disabled={!editable || !post.pack || post.status === "published" || !!working || bulk}
                onChange={(e) => onStatus(e.target.value === "approved" ? "approved" : "written")}
              >
                {post.status === "scheduled" ? <option value="scheduled">Not started</option> : null}
                {post.status === "published" ? <option value="published">Published</option> : null}
                {post.status === "written" || post.status === "approved" ? (
                  <>
                    <option value="written">Written</option>
                    <option value="approved">Approved</option>
                  </>
                ) : null}
              </select>
            </label>
            <span className={`spd-save ${saveState ?? ""}`} role="status">
              {saveState === "saving" ? "Saving…" : saveState === "saved" ? "All changes saved" : saveState === "failed" ? "Not saved" : ""}
            </span>
            <button type="button" className="socal-pop-close" aria-label="Close" onClick={() => ref.current?.close()}>×</button>
          </div>
        </header>

        <div className="spack-dialog-scroll">
          {warningsFor("general").length ? <Warnings list={warningsFor("general")} /> : null}
          {error ? <p className="error">{error}</p> : null}

          {!post.pack || !draft ? (
            <Section label="What this post argues">
              <p className="spd-hook">{post.hook}</p>
              {editable ? (
                <button type="button" className="btn primary" disabled={!!working || bulk} onClick={onWrite}>
                  {working === "write"
                    ? <><span className="spack-spin" aria-hidden /> Writing… (about 30 seconds)</>
                    : <><IconSpark size={15} /> Write content pack</>}
                </button>
              ) : null}
            </Section>
          ) : (
            <>
              <Section
                label="Caption — Instagram / LinkedIn / Facebook"
                aside={(() => {
                  const n = wordCount(markdownToPlain(draft.caption));
                  const off = n < CAPTION_WORDS.min || n > CAPTION_WORDS.max;
                  return (
                    <span className={`spd-count${off ? " off" : ""}`}>
                      {n} words · aim {CAPTION_WORDS.min} to {CAPTION_WORDS.max}
                    </span>
                  );
                })()}
                copy={markdownToPlain(draft.caption)}
                warnings={warningsFor("caption")}
              >
                <SocialRichText label="Caption" markdown={draft.caption} editable={canWrite}
                                onChange={(caption) => onDraft({ ...draft, caption })} />
              </Section>

              <Section
                label="Hashtags"
                hint="For Instagram, Facebook and LinkedIn. X uses the one or two at the end of its own post."
                copy={splitTags(draft.hashtags).join(" ")}
                warnings={warningsFor("hashtags")}
              >
                <textarea className="spd-input" rows={2} value={draft.hashtags} readOnly={!canWrite}
                          aria-label="Hashtags" onChange={(e) => onDraft({ ...draft, hashtags: e.target.value })} />
              </Section>

              <Section
                label="X (Twitter) post"
                aside={
                  <>
                    {canWrite && xLength > X_LIMIT ? (
                      <button type="button" className="spd-copy" onClick={() => {
                        const fitted = fitToX(draft.shortCaption);
                        if (fitted.length > X_LIMIT) { setCannotFit(true); return; }
                        setCannotFit(false);
                        onDraft({ ...draft, shortCaption: fitted });
                      }}>
                        Fit to {X_LIMIT}
                      </button>
                    ) : null}
                    <span className={`spd-counter${xLength > X_LIMIT ? " over" : ""}`}>{xLength}/{X_LIMIT}</span>
                  </>
                }
                copy={draft.shortCaption}
                warnings={warningsFor("x")}
                hint={`The caption's message, condensed for X. Hashtags count towards the ${X_LIMIT}, and it ends on a whole sentence.`}
              >
                <textarea className="spd-input" rows={3} value={draft.shortCaption} readOnly={!canWrite}
                          aria-label="X post"
                          onChange={(e) => { setCannotFit(false); onDraft({ ...draft, shortCaption: e.target.value }); }} />
                {cannotFit ? (
                  <p className="spd-hint spd-cannotfit">
                    The first sentence alone runs past {X_LIMIT}, so it cannot be fitted without cutting it. Shorten it by hand.
                  </p>
                ) : null}
              </Section>

              <Section label={picture.title} hint={picture.hint ?? undefined} copy={markdownToPlain(draft.imageText)}>
                <SocialRichText label={picture.title} variant="image" markdown={draft.imageText}
                                editable={canWrite} onChange={(imageText) => onDraft({ ...draft, imageText })} />
              </Section>

              {showExtra ? (
                <Section label={extraLabel} copy={draft.formatExtra} warnings={warningsFor("extra")}>
                  <textarea className="spd-input" rows={6} value={draft.formatExtra} readOnly={!canWrite}
                            aria-label={extraLabel} onChange={(e) => onDraft({ ...draft, formatExtra: e.target.value })} />
                </Section>
              ) : null}

              <details className="spd-brief" open={warningsFor("brief").length > 0}>
                <summary>{picture.brief} <span>{picture.briefFor}</span></summary>
                <label className="spd-field">
                  <span>{picture.brief.replace(/ and alt text$/, "")} <em>{draft.imageBrief.length} characters · target 380 to 620</em></span>
                  <textarea className="spd-input" rows={4} value={draft.imageBrief} readOnly={!canWrite}
                            onChange={(e) => onDraft({ ...draft, imageBrief: e.target.value })} />
                </label>
                <label className="spd-field">
                  <span>Alt text <em>{draft.altText.length} characters · target 76 to 123</em></span>
                  <textarea className="spd-input" rows={2} value={draft.altText} readOnly={!canWrite}
                            onChange={(e) => onDraft({ ...draft, altText: e.target.value })} />
                </label>
                {warningsFor("brief").length ? <Warnings list={warningsFor("brief")} /> : null}
              </details>
            </>
          )}
        </div>

        {post.pack ? (
          <footer className="spd-foot">
            <p>
              {locked
                ? "Approved copy is locked. Set the status back to Written to change it."
                : "Changing the format rewrites this post automatically, or click to redo it now."}
            </p>
            {canWrite ? (
              confirmRewrite ? (
                <div className="spd-confirm">
                  <span>Replace this copy with a new draft?</span>
                  <button type="button" className="btn small" onClick={() => onConfirmRewrite(false)}>Keep it</button>
                  <button type="button" className="btn danger small" disabled={!!working} onClick={onWrite}>Regenerate</button>
                </div>
              ) : (
                <button type="button" className="btn spd-regen" disabled={!!working || bulk}
                        onClick={() => onConfirmRewrite(true)}>
                  {working === "write" || working === "format"
                    ? <><span className="spack-spin dark" aria-hidden /> Rewriting…</>
                    : <>↻ Regenerate for this format</>}
                </button>
              )
            ) : null}
          </footer>
        ) : null}
      </div>
    </dialog>
  );
}

