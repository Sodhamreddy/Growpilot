"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { PackImage, SocialContentPack } from "@ob/db";
import { pictureRatio } from "@ob/social/text";
import { IconSpark } from "./Icons";
import { Section, PinIcon, dateOf, weekday, chipDate, type PackPost } from "./SocialPackParts";
import { markdownToPlain, pictureFor } from "@/lib/social-text";

/**
 * Step 4: each post's picture, made from its approved copy.
 *
 * A post waits here until its copy is approved in step 3, because the picture
 * prints the image text: making it from copy still under review would mean
 * making it again after every edit. Then it can be generated from the pack,
 * or a finished design uploaded instead, and approved.
 *
 * Generation is one post per request, "generate all" included, and stops at
 * the first failure. An image is the most expensive call in the product, and
 * a failure (quota, budget) is usually the same for every post after it.
 */

type ImageState = "waiting" | "none" | "draft" | "approved";

const STATE_LABEL: Record<ImageState, string> = {
  waiting: "Waiting for content",
  none: "Not started",
  draft: "Draft",
  approved: "Approved",
};

function stateOf(p: PackPost): ImageState {
  if (p.status !== "approved" && p.status !== "published") return "waiting";
  return p.pack?.image?.status ?? "none";
}

const urlOf = (image: PackImage) => `/api/social/images/${image.key}`;
const cssRatio = (format: string) => pictureRatio(format).replace(":", " / ");
const madeOn = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

async function send(method: "POST" | "PATCH", body: Record<string, unknown> | FormData) {
  const res = await fetch("/api/social/image", {
    method,
    ...(body instanceof FormData
      ? { body }
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const json = (await res.json().catch(() => ({}))) as { pack?: SocialContentPack; error?: { message?: string } };
  if (!res.ok) throw new Error(json.error?.message ?? "That did not work.");
  return json;
}

export function SocialImagePacks({
  posts: initial,
  canEdit,
  monthName,
  monthKey,
}: {
  posts: PackPost[];
  canEdit: boolean;
  monthName: string;
  monthKey: string;
}) {
  const [posts, setPosts] = useState(initial);
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null);
  const stop = useRef(false);
  // One hidden file picker for every card; which post it is for is kept here.
  const picker = useRef<HTMLInputElement>(null);
  const [uploadFor, setUploadFor] = useState<string | null>(null);

  const setPack = (id: string, pack: SocialContentPack) =>
    setPosts((all) => all.map((p) => (p.id === id ? { ...p, pack } : p)));
  /** Set or clear one post's entry in a per-post map. */
  const entry = (id: string, value: string | null) => (m: Record<string, string>) => {
    const next = { ...m };
    if (value) next[id] = value; else delete next[id];
    return next;
  };

  async function run(id: string, what: string, action: () => Promise<{ pack?: SocialContentPack }>): Promise<boolean> {
    setBusy(entry(id, what));
    setErrors(entry(id, null));
    try {
      const res = await action();
      if (res.pack) setPack(id, res.pack);
      return true;
    } catch (err) {
      setErrors(entry(id, err instanceof Error ? err.message : "Could not reach the server."));
      return false;
    } finally {
      setBusy(entry(id, null));
    }
  }

  const generate = (id: string, direction?: string) =>
    run(id, "generate", () => send("POST", { topicId: id, ...(direction?.trim() ? { direction: direction.trim() } : {}) }));
  const review = (id: string, action: "approve" | "unapprove") =>
    run(id, action, () => send("PATCH", { topicId: id, action }));
  const upload = (id: string, file: File) => {
    const form = new FormData();
    form.set("topicId", id);
    form.set("file", file);
    return run(id, "upload", () => send("POST", form));
  };
  const chooseFile = (id: string) => {
    setUploadFor(id);
    picker.current?.click();
  };

  async function generateAll() {
    const queue = posts.filter((p) => stateOf(p) === "none").map((p) => p.id);
    stop.current = false;
    setBulk({ done: 0, total: queue.length });
    for (const [i, id] of queue.entries()) {
      if (stop.current) break;
      const ok = await generate(id);
      setBulk({ done: i + 1, total: queue.length });
      if (!ok) break;
    }
    setBulk(null);
  }

  const counts = { waiting: 0, none: 0, draft: 0, approved: 0 } as Record<ImageState, number>;
  for (const p of posts) counts[stateOf(p)]++;
  const openPost = posts.find((p) => p.id === openId) ?? null;

  if (posts.length === 0) {
    return (
      <div className="socal-empty">
        Nothing is on the calendar for {monthName} yet. Plan the month and approve its copy first.
        {" "}<Link href="/social">Plan it from the Topic Pool</Link>
      </div>
    );
  }

  return (
    <section className="spack" aria-label={`Image packs for ${monthName}`}>
      <input
        ref={picker}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file && uploadFor) void upload(uploadFor, file);
        }}
      />

      <div className="spack-summary">
        <div className="spack-progress" aria-hidden>
          <span className="spack-bar written" style={{ width: `${((counts.draft + counts.approved) / posts.length) * 100}%` }} />
          <span className="spack-bar approved" style={{ width: `${(counts.approved / posts.length) * 100}%` }} />
        </div>
        <p>
          <strong>{posts.length}</strong> posts · <strong>{counts.draft + counts.approved}</strong> with an image
          · <strong>{counts.approved}</strong> approved
          {counts.waiting ? <span className="socal-muted"> · {counts.waiting} waiting for approved copy</span> : null}
        </p>
        {canEdit && counts.none > 0 ? (
          bulk ? (
            <div className="spack-bulk" role="status">
              <span>Generating {Math.min(bulk.done + 1, bulk.total)} of {bulk.total}…</span>
              <button type="button" className="btn small" onClick={() => { stop.current = true; }}>Stop after this one</button>
            </div>
          ) : (
            <button type="button" className="btn primary" disabled={Object.keys(busy).length > 0} onClick={() => void generateAll()}>
              <IconSpark size={15} /> Generate all {counts.none} remaining
            </button>
          )
        ) : null}
      </div>

      <ol className="spack-grid sipack-grid">
        {posts.map((p) => {
          const state = stateOf(p);
          const working = busy[p.id];
          const image = p.pack?.image;
          return (
            <li key={p.id} className={`sipack-card state-${state}`}>
              <button type="button" className="sipack-thumb" style={{ aspectRatio: "4 / 5" }} onClick={() => setOpenId(p.id)}
                      aria-label={`Open the image for ${p.title}`}>
                {working === "generate" || working === "upload" ? (
                  <span className="sipack-placeholder"><span className="spack-spin dark" aria-hidden /> {working === "upload" ? "Uploading…" : "Generating…"}</span>
                ) : image ? (
                  // Served from our own authenticated route; next/image would need it whitelisted for nothing.
                  <img src={urlOf(image)} alt={p.pack?.altText || p.title} />
                ) : (
                  <span className="sipack-placeholder">{state === "waiting" ? "Copy not approved yet" : "No image yet"}</span>
                )}
              </button>
              <div className="sipack-body">
                <div className="spack-card-top">
                  <span className="sipack-day">{weekday(p.date)} {dateOf(p.date).getUTCDate()}</span>
                  <span className={`spack-status sipack-state ${state}`}>{STATE_LABEL[state]}</span>
                </div>
                <h3 className="spack-card-title">
                  <button type="button" onClick={() => setOpenId(p.id)}>{p.title}</button>
                </h3>
                <p className="spack-card-meta">{p.format} · {p.audience}</p>
                {errors[p.id] ? <p className="spack-card-error" title={errors[p.id]}>{errors[p.id]}</p> : null}
                <div className="spack-card-actions">
                  {state === "waiting" ? (
                    <Link className="btn small" href={`/social/content?month=${monthKey}`}>Approve copy in step 3</Link>
                  ) : canEdit && state === "none" ? (
                    <>
                      <button type="button" className="btn primary small" disabled={!!working || !!bulk} onClick={() => void generate(p.id)}>Generate</button>
                      <button type="button" className="btn small" disabled={!!working || !!bulk} onClick={() => chooseFile(p.id)}>Upload</button>
                    </>
                  ) : canEdit && state === "draft" ? (
                    <>
                      <button type="button" className="btn small" onClick={() => setOpenId(p.id)}>Review</button>
                      <button type="button" className="btn primary small" disabled={!!working} onClick={() => void review(p.id, "approve")}>
                        {working === "approve" ? "Approving…" : "Approve"}
                      </button>
                    </>
                  ) : (
                    <button type="button" className="btn small" onClick={() => setOpenId(p.id)}>Open</button>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>

      <p className="spack-next">
        The model draws the words onto the picture itself, so check every word against the image text before
        approving. Approved pictures and copy go on to step 5, where they are scheduled.
      </p>

      {openPost ? (
        <ImageDialog
          key={openPost.id}
          post={openPost}
          state={stateOf(openPost)}
          canEdit={canEdit}
          working={busy[openPost.id] ?? null}
          error={errors[openPost.id] ?? null}
          bulk={!!bulk}
          monthKey={monthKey}
          onGenerate={(direction) => void generate(openPost.id, direction)}
          onUpload={() => chooseFile(openPost.id)}
          onReview={(action) => void review(openPost.id, action)}
          onClose={() => setOpenId(null)}
        />
      ) : null}
    </section>
  );
}

function ImageDialog({
  post, state, canEdit, working, error, bulk, monthKey, onGenerate, onUpload, onReview, onClose,
}: {
  post: PackPost;
  state: ImageState;
  canEdit: boolean;
  working: string | null;
  error: string | null;
  bulk: boolean;
  monthKey: string;
  onGenerate: (direction: string) => void;
  onUpload: () => void;
  onReview: (action: "approve" | "unapprove") => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  const [direction, setDirection] = useState("");

  const pack = post.pack;
  const image = pack?.image;
  const picture = pictureFor(post.format);
  const ready = state !== "waiting";
  const canChange = canEdit && ready && post.status !== "published";
  const [headline = "", ...rest] = markdownToPlain(pack?.imageText ?? "").split(/\n\s*\n/).filter(Boolean);

  return (
    <dialog
      ref={ref}
      className="spack-dialog"
      aria-labelledby="sipack-dialog-title"
      onClose={onClose}
      onClick={(e) => { if (e.target === ref.current) ref.current?.close(); }}
    >
      <div className="spack-dialog-inner">
        <header className="spd-head">
          <span className="spd-date">{chipDate(post.date)}</span>
          <div className="spd-titlebox">
            <h3 id="sipack-dialog-title">{post.title}</h3>
            <div className="spd-pills">
              <span className="spd-aud">{post.audience}</span>
              <span className="spd-fmt">{post.format}</span>
              {post.occasion ? <span className="spd-occ"><PinIcon /> {post.occasion}</span> : null}
            </div>
          </div>
          <div className="spd-side">
            <label className={`spd-status sipack-status ${state}`}>
              <span className="spd-dot" aria-hidden />
              <b>Image</b>
              <select
                value={state}
                disabled={!canChange || !image || !!working || bulk}
                onChange={(e) => onReview(e.target.value === "approved" ? "approve" : "unapprove")}
              >
                {state === "waiting" ? <option value="waiting">Waiting for content</option> : null}
                {state === "none" ? <option value="none">Not started</option> : null}
                {state === "draft" || state === "approved" ? (
                  <>
                    <option value="draft">Draft</option>
                    <option value="approved">Approved</option>
                  </>
                ) : null}
              </select>
            </label>
            <button type="button" className="socal-pop-close" aria-label="Close" onClick={() => ref.current?.close()}>×</button>
          </div>
        </header>

        <div className="spack-dialog-scroll">
          {!ready ? (
            <p className="sipack-waiting">
              <span aria-hidden>🔒</span> Waiting for <b>content approval</b>. Finish the review in{" "}
              <Link href={`/social/content?month=${monthKey}`}>step 3, Content pack</Link>, then make the image from the approved text.
            </p>
          ) : null}
          {error ? <p className="error">{error}</p> : null}

          <div className="sipack-layout">
            <div className="sipack-left">
              <div className="sipack-preview" style={{ aspectRatio: cssRatio(post.format) }}>
                {working === "generate" || working === "upload" ? (
                  <span className="sipack-placeholder"><span className="spack-spin dark" aria-hidden /> {working === "upload" ? "Uploading…" : "Generating… about 15 seconds"}</span>
                ) : image ? (
                  <img src={urlOf(image)} alt={pack?.altText || post.title} />
                ) : (
                  <span className="sipack-placeholder">No image yet</span>
                )}
              </div>
              {image ? (
                <p className="sipack-source">
                  {image.source === "generated" ? `Generated ${madeOn(image.createdAt)}${image.model ? ` · ${image.model}` : ""}` : `Uploaded ${madeOn(image.createdAt)}`}
                </p>
              ) : null}

              {canChange ? (
                <>
                  <div className="sipack-buttons">
                    <button type="button" className="btn primary small" disabled={!!working || bulk} onClick={() => onGenerate(direction)}>
                      <IconSpark size={14} /> {image ? "Generate again" : "Generate image"}
                    </button>
                    <button type="button" className="btn small" disabled={!!working || bulk} onClick={onUpload}>
                      {image ? "Replace with upload" : "Upload image"}
                    </button>
                    {image ? (
                      <a className="btn small" href={urlOf(image)} download={`${post.date}-${post.format.toLowerCase().replace(/\W+/g, "-")}`}>Download</a>
                    ) : null}
                  </div>
                  <label className="sipack-direction">
                    <span>Extra direction for the next attempt <em>optional, not saved to the copy</em></span>
                    <textarea rows={2} value={direction} placeholder="e.g. warmer light, more space above the headline"
                              onChange={(e) => setDirection(e.target.value)} />
                  </label>
                </>
              ) : !ready ? (
                <div className="sipack-buttons">
                  <button type="button" className="btn small" disabled>Generate image</button>
                  <button type="button" className="btn small" disabled>Upload image</button>
                </div>
              ) : null}
            </div>

            <div className="sipack-right">
              <Section label={`${picture.title} (from step 3)`} copy={markdownToPlain(pack?.imageText ?? "")}>
                {headline ? (
                  <div className="sipack-imagetext">
                    <p className="h">{headline}</p>
                    {rest.map((line) => <p key={line}>{line}</p>)}
                  </div>
                ) : (
                  <p className="spd-hint">No text for the picture. It will be made without words.</p>
                )}
              </Section>
              <Section label={picture.brief.replace(/ and alt text$/, "")} copy={pack?.imageBrief ?? ""}>
                <p className="sipack-text">{pack?.imageBrief || "No brief yet."}</p>
              </Section>
              <Section label="Alt text" copy={pack?.altText ?? ""}>
                <p className="sipack-text">{pack?.altText || "No alt text yet."}</p>
              </Section>
              {pack?.formatExtra ? (
                <Section label={post.format === "Carousel" ? "Carousel slides" : post.format === "Video" || post.format === "Podcast" ? "Reel script" : "Questions and answers"}
                         copy={pack.formatExtra}>
                  <p className="sipack-text pre">{pack.formatExtra}</p>
                </Section>
              ) : null}
            </div>
          </div>
        </div>

        <footer className="spd-foot">
          <p>The model draws the words onto the picture. Check each one against the text on the right before approving.</p>
          {canChange && image ? (
            state === "approved" ? (
              <button type="button" className="btn small" disabled={!!working} onClick={() => onReview("unapprove")}>Set back to draft</button>
            ) : (
              <button type="button" className="btn primary" disabled={!!working} onClick={() => onReview("approve")}>
                {working === "approve" ? "Approving…" : "Approve image"}
              </button>
            )
          ) : null}
        </footer>
      </div>
    </dialog>
  );
}
