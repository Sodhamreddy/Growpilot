"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { LoadingIndicator } from "./LoadingIndicator";
import { ArticleMarkdown } from "./ArticleMarkdown";
import { getArticleBodySource } from "@/lib/article-comment-text";
import styles from "./ArticleHistory.module.css";

type Revision = { version: number; title: string; authoredBy: string; createdAt: string; bodyMarkdown?: string };

const AUTHOR: Record<string, string> = { ai: "Written by AI", human: "Edited by your team" };
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

export function ArticleHistory({ articleId, version, canRestore, onRestoringChange }: { articleId: string; version: number; canRestore: boolean; onRestoringChange?: (restoring: boolean) => void }) {
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const [revisions, setRevisions] = useState<Revision[] | null>(null);
  const [selected, setSelected] = useState<Revision | null>(null);
  const [opening, setOpening] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [restoring, setRestoring] = useState(false);
  useEffect(() => { onRestoringChange?.(restoring || refreshing); }, [restoring, refreshing, onRestoringChange]);
  useEffect(() => () => onRestoringChange?.(false), [onRestoringChange]);

  async function open(revision: number) {
    setOpening(revision);
    setError("");
    try {
      const response = await fetch(`/api/articles/${articleId}/revisions?version=${revision}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? "Could not open this version.");
      setSelected(data.revision);
    } catch (err) { setError(err instanceof Error ? err.message : "Could not open this version."); }
    finally { setOpening(null); }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`/api/articles/${articleId}/revisions`, { cache: "no-store" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error?.message ?? "Could not load saved versions.");
        if (cancelled) return;
        setRevisions(data.revisions);
        // Start on the newest saved version, so the page never opens empty.
        if (data.revisions[0]) void open(data.revisions[0].version);
      } catch (err) { if (!cancelled) { setRevisions([]); setError(err instanceof Error ? err.message : "Could not load saved versions."); } }
    })();
    return () => { cancelled = true; };
    // Loads once per article; `open` only reads the same articleId.
  }, [articleId]);

  async function restore() {
    if (!selected || selected.bodyMarkdown === undefined) return;
    setRestoring(true);
    setError("");
    try {
      const response = await fetch(`/api/articles/${articleId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedVersion: version, title: selected.title, bodyMarkdown: selected.bodyMarkdown }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? "Could not restore this version.");
      startRefresh(() => router.refresh());
    } catch (err) { setError(err instanceof Error ? err.message : "Could not restore this version."); }
    finally { setRestoring(false); }
  }

  const busy = restoring || refreshing;
  const isCurrent = selected?.version === version;
  return <div className={styles.page}>
    <header className={styles.head}>
      <h2>Version History</h2>
      <p>Every saved version of this article. Open one to read it, or restore its title and text as a new version.</p>
    </header>
    {error && <p className={styles.error} role="alert">{error}</p>}
    <div className={styles.layout}>
      <ol className={styles.list} aria-label="Saved versions">
        {revisions === null && <li className={styles.status}><LoadingIndicator label="Loading saved versions…" /></li>}
        {revisions?.length === 0 && !error && <li className={styles.status}>No saved versions yet. One is saved each time the article changes.</li>}
        {revisions?.map((revision) => <li key={revision.version}>
          <button type="button" aria-pressed={selected?.version === revision.version} disabled={busy} onClick={() => void open(revision.version)}>
            <span className={styles.badge}>v{revision.version}</span>
            <span className={styles.label}>
              <strong>{revision.version === version ? "Current version" : `Version ${revision.version}`}</strong>
              <span>{AUTHOR[revision.authoredBy] ?? "Saved version"} · {when(revision.createdAt)}</span>
            </span>
          </button>
        </li>)}
      </ol>
      <section className={styles.preview} aria-live="polite" aria-busy={opening !== null}>
        {selected ? <>
          <div className={styles.previewHead}>
            <div>
              <span className={styles.eyebrow}>Version {selected.version}{isCurrent ? " · current" : ""}</span>
              <h3>{selected.title}</h3>
            </div>
            {canRestore && !isCurrent && <button type="button" className={styles.restore} disabled={busy || opening !== null} onClick={() => void restore()}>
              {restoring || refreshing ? <LoadingIndicator label="Restoring…" /> : "Restore this version"}
            </button>}
          </div>
          {!isCurrent && <p className={styles.note}>{canRestore
            ? `Restoring saves this title and text as version ${version + 1}. SEO details stay as they are, and the article needs quality checks again before approval.`
            : "Request changes on this article to restore an earlier version."}</p>}
          <div className={styles.body}><ArticleMarkdown source={getArticleBodySource(selected.title, selected.bodyMarkdown ?? "")} /></div>
        </> : <div className={styles.placeholder}>{opening !== null ? <LoadingIndicator label="Opening version…" /> : "Choose a version to read it here."}</div>}
      </section>
    </div>
  </div>;
}
