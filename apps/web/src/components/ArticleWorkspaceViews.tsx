"use client";

import { useEffect, useState, type ReactNode } from "react";
import { IconCheckCircle, IconClose, IconComment, IconPencil, IconPulse, IconSparkles, IconTick, IconWordPress } from "./ArticleWorkspaceIcons";
import styles from "./ArticleWorkspaceViews.module.css";

export type ScoreBreakdownItem = { key: string; label: string; weight: number; score: number; reasons: string[] };
export type ActivityEntry = { id: string; action: string; actor: string; at: string; version: number | null; note: string | null };
export type KeywordUse = { inSeoTitle: boolean; inMetaDescription: boolean; inTitle: boolean; bodyCount: number };
type Keyword = { term: string; volume: number | null; intent: string | null } | null;
type Tone = "good" | "warn" | "bad" | "none";

const formatScore = (score: number) => score.toLocaleString("en-US", { maximumFractionDigits: 1 });

/** One plain-language grade for the headline score, used by the gauge and the review panel. */
export function scoreGrade(score: number | null): { label: string; tone: Tone; text: string } {
  if (score === null) return { label: "Not checked", tone: "none", text: "Run quality checks to get a score for this version." };
  if (score >= 85) return { label: "Excellent", tone: "good", text: "Your article is in great shape for search." };
  if (score >= 70) return { label: "Good", tone: "good", text: "Your article is well-optimized. A few improvements can make it even stronger." };
  if (score >= 50) return { label: "Fair", tone: "warn", text: "A solid start. The checks below show what will lift the score." };
  return { label: "Needs work", tone: "bad", text: "This draft needs more work before it is ready to publish." };
}

const toneOf = (score: number): Tone => score >= 70 ? "good" : score >= 50 ? "warn" : "bad";

/** The quality checks, named and explained in the words a reviewer uses. */
const GATES: Record<string, { label: string; help: string }> = {
  grounding: { label: "Grounding", help: "Claims are backed by your sources." },
  business_facts: { label: "Business Facts", help: "Names your business and states only verified facts as fact." },
  brand: { label: "Brand Voice", help: "Reads like your brand." },
  seo: { label: "SEO", help: "Keyword, title, description and structure." },
  risk: { label: "Sensitive Topics", help: "Legal, medical, safety or money advice gets a person's review." },
  publishing: { label: "Publishing Policy", help: "Meets your workspace's approval rules." },
  audit: { label: "AI Record", help: "Which AI models and prompts produced this version." },
};
export const gateInfo = (gate: string) => GATES[gate] ?? { label: gate.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()), help: "" };

export function ScoreArc({ score, width = 150 }: { score: number | null; width?: number }) {
  const value = score === null ? 0 : Math.max(0, Math.min(100, score));
  const angle = Math.PI * (1 - value / 100);
  const knob = { x: 60 + 48 * Math.cos(angle), y: 60 - 48 * Math.sin(angle) };
  return <div className={styles.arc} style={{ width }} data-tone={scoreGrade(score).tone}>
    <svg viewBox="0 0 120 66" role="img" aria-label={score === null ? "SEO score: not checked yet" : `SEO score: ${formatScore(score)} out of 100`}>
      <path d="M12 60a48 48 0 0 1 96 0" className={styles.arcTrack} pathLength={100} />
      {value > 0 && <path d="M12 60a48 48 0 0 1 96 0" className={styles.arcFill} pathLength={100} strokeDasharray={`${value} 100`} />}
      {score !== null && <circle cx={knob.x} cy={knob.y} r="3.4" className={styles.arcKnob} />}
    </svg>
    <div className={styles.arcValue}><strong>{score === null ? "–" : formatScore(score)}</strong><span>/ 100</span></div>
  </div>;
}

function LengthMeter({ label, length, min, max, note }: { label: string; length: number; min: number; max: number; note?: string | null }) {
  const scale = max * 1.25;
  const state = length === 0 ? "missing" : length < min ? "short" : length > max ? "long" : "good";
  const verdict = state === "missing" ? "Missing" : state === "good" ? "Good length" : `${state === "short" ? "Too short" : "Too long"} · aim for ${min}–${max}`;
  return <div className={styles.meter} data-state={state}>
    <div className={styles.meterHead}><strong>{label}</strong><span>{length} characters</span></div>
    <div className={styles.meterTrack} aria-hidden="true">
      <b style={{ left: `${(min / scale) * 100}%`, width: `${((max - min) / scale) * 100}%` }} />
      <i style={{ width: `${Math.min(100, (length / scale) * 100)}%` }} />
    </div>
    <span className={styles.meterNote}>{verdict}{note ? ` · ${note}` : ""}</span>
  </div>;
}

function Check({ ok, children }: { ok: boolean; children: ReactNode }) {
  return <li data-ok={ok}><span className={styles.checkMark}>{ok ? <IconTick size={13} /> : <IconClose size={12} />}</span>{children}<span className={styles.srOnly}>{ok ? " (done)" : " (missing)"}</span></li>;
}

const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

export function SeoView({ article, keyword, keywordUse, secondaryKeywords, breakdown, editable, onEdit, onImprove }: {
  article: { title: string; slug: string; metaTitle: string | null; metaDescription: string | null; bodyMarkdown: string; seoScore: number | null; version: number };
  keyword: Keyword; keywordUse: KeywordUse | null; secondaryKeywords: string[]; breakdown: ScoreBreakdownItem[]; editable: boolean; onEdit: () => void; onImprove: () => void;
}) {
  const grade = scoreGrade(article.seoScore);
  const seoTitle = article.metaTitle?.trim() || article.title;
  const description = article.metaDescription?.trim() ?? "";
  const bodyCount = keywordUse?.bodyCount ?? 0;
  return <div className={styles.page}>
    <header className={styles.pageHead}>
      <div><h2>SEO &amp; Optimization</h2><p>How search engines will see this article, and what makes up its score.</p></div>
      {editable && <div className={styles.headActions}>
        <button type="button" className={styles.primary} onClick={onImprove}><IconSparkles size={16} /> Improve with AI</button>
        <button type="button" className={styles.secondary} onClick={onEdit}><IconPencil size={15} /> Edit SEO details</button>
      </div>}
    </header>

    <section className={styles.card} aria-labelledby="seo-score-heading">
      <div className={styles.scoreHead}>
        <ScoreArc score={article.seoScore} width={170} />
        <div>
          <span className={styles.grade} data-tone={grade.tone}>{grade.label}</span>
          <h3 id="seo-score-heading">SEO score for version {article.version}</h3>
          <p>{grade.text}</p>
        </div>
      </div>
      {breakdown.length ? <ul className={styles.components} aria-label="What makes up the score">{breakdown.map((part) => <li key={part.key}>
        <div className={styles.componentHead}><strong>{part.label}</strong><span>{part.weight}% of the score</span><b data-tone={toneOf(part.score)}>{Math.round(part.score)}</b></div>
        <div className={styles.bar} aria-hidden="true"><i data-tone={toneOf(part.score)} style={{ width: `${Math.max(2, Math.min(100, part.score))}%` }} /></div>
        {part.reasons.length > 0 && <p>{part.reasons.slice(0, 2).join(" ")}</p>}
      </li>)}</ul> : <p className={styles.muted}>The breakdown appears here once quality checks have run for this version.</p>}
    </section>

    <div className={styles.columns}>
      <section className={styles.card} aria-labelledby="seo-preview-heading">
        <h3 id="seo-preview-heading">Search preview</h3>
        <p className={styles.muted}>Roughly how this page can appear in Google results.</p>
        <div className={styles.serp}>
          <span className={styles.serpUrl}>Your website › {article.slug}</span>
          <span className={styles.serpTitle}>{clip(seoTitle, 62)}</span>
          <span className={styles.serpText}>{description ? clip(description, 160) : "No meta description yet, so search engines will choose text from the article."}</span>
        </div>
        <LengthMeter label="SEO title" length={seoTitle.length} min={30} max={60} note={article.metaTitle?.trim() ? null : "using the article title"} />
        <LengthMeter label="Meta description" length={description.length} min={120} max={160} />
      </section>

      <section className={styles.card} aria-labelledby="seo-keyword-heading">
        <h3 id="seo-keyword-heading">Target keyword</h3>
        {keyword ? <>
          <div className={styles.keywordHead}>
            <span className={styles.keyword}>{keyword.term}</span>
            {keyword.volume !== null && <span>{keyword.volume.toLocaleString("en-US")} searches/mo</span>}
            {keyword.intent && <span>{keyword.intent} intent</span>}
          </div>
          <ul className={styles.checklist}>
            <Check ok={Boolean(keywordUse?.inSeoTitle)}>In the SEO title</Check>
            <Check ok={Boolean(keywordUse?.inMetaDescription)}>In the meta description</Check>
            <Check ok={Boolean(keywordUse?.inTitle)}>In the article title</Check>
            <Check ok={bodyCount > 0}>In the article text{bodyCount ? ` · ${bodyCount} ${bodyCount === 1 ? "time" : "times"}` : ""}</Check>
          </ul>
          <p className={styles.muted}>Measured the same way as the SEO score: the keyword&apos;s main words together and in order. Small words such as “for” and “in” between them are fine.</p>
          {secondaryKeywords.length > 0 && <>
            <h4>Related terms</h4>
            <ul className={styles.terms}>{secondaryKeywords.map((term) => <li key={term}>{term}</li>)}</ul>
          </>}
        </> : <p className={styles.muted}>No target keyword is linked to this article. Articles created from a keyword topic get one automatically.</p>}
      </section>
    </div>
  </div>;
}

type Kind = "ai" | "good" | "warn" | "bad" | "comment" | "edit" | "publish" | "neutral";
const ACTIONS: Record<string, [string, Kind]> = {
  "article.created": ["created the article", "edit"],
  "article.generated": ["wrote the first draft", "ai"],
  "article.gates_run": ["ran the quality checks", "neutral"],
  "article.edited": ["saved changes", "edit"],
  "article.revision_proposed": ["asked AI to rewrite a section", "ai"],
  "article.revision_applied": ["applied an AI rewrite", "ai"],
  "article.score_improvements_proposed": ["asked AI for improvements", "ai"],
  "article.score_improvements_previewed": ["prepared AI improvements", "ai"],
  "article.note_added": ["added a review note", "comment"],
  "article.changes_requested": ["requested changes", "warn"],
  "article.content_approved": ["approved it for a Manager (Content review)", "good"],
  "article.approved": ["approved the article", "good"],
  "article.publish_requested": ["sent the article to publish", "publish"],
  "article.published_to_cms": ["published it to the website", "publish"],
  "article.published": ["published the article", "publish"],
  "article.publish_failed": ["could not publish the article", "bad"],
  "article.comment.created": ["added a comment", "comment"],
  "article.comment.replied": ["replied to a comment", "comment"],
  "article.comment.resolved": ["resolved a comment", "good"],
  "article.comment.reopened": ["reopened a comment", "comment"],
};
const KIND_ICON: Record<Kind, ReactNode> = {
  ai: <IconSparkles size={15} />, good: <IconCheckCircle size={15} />, warn: <IconPencil size={14} />, bad: <IconClose size={14} />,
  comment: <IconComment size={15} />, edit: <IconPencil size={14} />, publish: <IconWordPress size={15} />, neutral: <IconPulse size={15} />,
};

function relativeTime(iso: string, now: number) {
  const seconds = (new Date(iso).getTime() - now) / 1000;
  const size = Math.abs(seconds);
  const format = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (size < 60) return "just now";
  if (size < 3600) return format.format(Math.round(seconds / 60), "minute");
  if (size < 86_400) return format.format(Math.round(seconds / 3600), "hour");
  if (size < 7 * 86_400) return format.format(Math.round(seconds / 86_400), "day");
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function ActivityView({ entries, limit }: { entries: ActivityEntry[]; limit: number }) {
  // Times are local to the reader, so they are only worked out in the browser.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => setNow(Date.now()), []);
  return <div className={styles.page}>
    <header className={styles.pageHead}><div><h2>Activity Log</h2><p>Everything that happened to this article, newest first.</p></div></header>
    {entries.length === 0 ? <div className={styles.empty}><IconPulse size={22} /><strong>No activity yet</strong><span>Edits, checks, comments and decisions will appear here.</span></div>
      : <ol className={styles.timeline}>{entries.map((entry) => {
        const [text, kind] = ACTIONS[entry.action] ?? [entry.action.replace(/^article\./, "").replace(/[._]/g, " "), "neutral" as Kind];
        return <li key={entry.id} data-kind={kind}>
          <span className={styles.dot}>{KIND_ICON[kind]}</span>
          <div className={styles.event}>
            <p><strong>{entry.actor}</strong> {text}{entry.version !== null && <span className={styles.version}>v{entry.version}</span>}</p>
            {entry.note && <blockquote>{entry.note}</blockquote>}
            <time dateTime={entry.at} title={now ? new Date(entry.at).toLocaleString() : undefined}>{now ? relativeTime(entry.at, now) : " "}</time>
          </div>
        </li>;
      })}</ol>}
    {entries.length >= limit && <p className={styles.muted}>Showing the latest {limit} events.</p>}
  </div>;
}
