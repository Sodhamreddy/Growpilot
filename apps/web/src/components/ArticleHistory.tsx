"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { LoadingIndicator } from "./LoadingIndicator";

type Revision = { version: number; title: string; authoredBy: string; createdAt: string; bodyMarkdown?: string };

export function ArticleHistory({ articleId, version, canRestore, onRestoringChange }: { articleId: string; version: number; canRestore: boolean; onRestoringChange?: (restoring: boolean) => void }) {
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const [revisions, setRevisions] = useState<Revision[] | null>(null);
  const [selected, setSelected] = useState<Revision | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [restoring, setRestoring] = useState(false);
  useEffect(() => { onRestoringChange?.(restoring || refreshing); }, [restoring, refreshing, onRestoringChange]);
  useEffect(() => () => onRestoringChange?.(false), [onRestoringChange]);

  async function load(selectedVersion?: number) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/articles/${articleId}/revisions${selectedVersion ? `?version=${selectedVersion}` : ""}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? "Could not load saved versions.");
      if (selectedVersion) setSelected(data.revision);
      else setRevisions(data.revisions);
    } catch (err) { setError(err instanceof Error ? err.message : "Could not load saved versions."); }
    finally { setBusy(false); }
  }

  async function restore() {
    if (!selected || selected.bodyMarkdown === undefined) return;
    setBusy(true);
    setRestoring(true);
    setError("");
    try {
      const response = await fetch(`/api/articles/${articleId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedVersion: version, title: selected.title, bodyMarkdown: selected.bodyMarkdown }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? "Could not restore this version.");
      setSelected(null);
      startRefresh(() => router.refresh());
    } catch (err) { setError(err instanceof Error ? err.message : "Could not restore this version."); }
    finally { setBusy(false); setRestoring(false); }
  }

  return <details className="card" style={{ marginBottom: 24 }} onToggle={(event) => {
    if (event.currentTarget.open && revisions === null && !busy) void load();
  }}>
    <summary style={{ cursor: "pointer" }}>Version history · current v{version}</summary>
    <p className="small muted">Preview a saved title and article body. Restoring creates a new version that must pass quality checks again. SEO metadata stays as it is.</p>
    {revisions?.length === 0 ? <p className="small muted">No earlier versions saved yet.</p> : null}
    <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
      {revisions?.map((revision) => <button type="button" className="btn small" key={revision.version} disabled={busy}
        onClick={() => void load(revision.version)}>v{revision.version} · {new Date(revision.createdAt).toLocaleDateString()}</button>)}
    </div>
    {selected ? <div style={{ marginTop: 16 }}>
      <strong>{selected.title} · v{selected.version}</strong>
      <pre style={{ whiteSpace: "pre-wrap", maxHeight: 320, overflowY: "auto", fontFamily: "inherit" }}>{selected.bodyMarkdown}</pre>
      {canRestore && selected.version !== version ? <button type="button" className="btn" disabled={busy} onClick={() => void restore()}>Restore this title and body</button> : null}
    </div> : null}
    {busy || refreshing ? <p className="small muted"><LoadingIndicator label={restoring || refreshing ? "Restoring version…" : "Loading saved versions…"} /></p> : null}
    {error ? <p className="error" role="alert">{error}</p> : null}
  </details>;
}
