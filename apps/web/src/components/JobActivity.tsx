"use client";
import Link from "next/link";
import { useEffect, useState } from "react";

type Task = { id: string; queue: string; name: string; state: string; at: number; canRetry: boolean; attempts: number };
const LABELS: Record<string, string> = {
  "crawl.site": "Website scan", "crawl.extract-profile": "Business profile", "crawl.extract-voice": "Brand voice",
  "crawl.index-knowledge": "Knowledge update", "research.keywords": "Keyword research", "research.content-plan": "Article planning",
  "ai.generate-article": "Article writing", "qa.run-gates": "Article quality check", "publish.article": "Article publishing",
  "publish.social-post": "Social publishing", "analytics.reviews-sync": "Review sync", "analytics.ingest": "Social analytics",
  "analytics.measurement": "Search analytics", "maintenance.scheduled-run": "Scheduled content",
};
const STATES: Record<string, string> = { active: "Working", waiting: "Waiting", delayed: "Scheduled / retry pending", completed: "Completed", failed: "Failed" };

export function JobActivity() {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  async function refresh(signal?: AbortSignal) {
    const res = await fetch("/api/jobs/recent", { cache: "no-store", ...(signal ? { signal } : {}) });
    if (!res.ok) throw new Error("Task status is unavailable. Try refreshing shortly.");
    const body = await res.json() as { jobs: Task[] };
    if (!signal?.aborted) { setTasks(body.jobs); setError(""); }
  }
  useEffect(() => {
    const controller = new AbortController();
    const poll = () => { void refresh(controller.signal).catch((e: Error) => {
      if (!controller.signal.aborted) setError(e.message);
    }); };
    poll();
    const timer = setInterval(poll, 20_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, []);
  async function retry(task: Task) {
    setBusy(task.id);
    try {
      const res = await fetch("/api/jobs/recent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ queue: task.queue, id: task.id }) });
      const body = await res.json() as { error?: { message?: string } };
      if (!res.ok) throw new Error(body.error?.message ?? "Could not retry this task.");
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not retry this task."); }
    finally { setBusy(null); }
  }
  return <section className="card" style={{ marginTop: 20, padding: 20 }} aria-label="Background tasks">
    <h2 style={{ fontSize: 18, marginTop: 0 }}>Recent background tasks</h2>
    <p className="small muted">Recent activity across this workspace. Status refreshes every 20 seconds.</p>
    {error && <p role="alert">{error}</p>}
    {!tasks && !error && <p role="status">Loading task status…</p>}
    {tasks?.length === 0 && <p className="muted">No recent tasks to display.</p>}
    {tasks?.map((task) => <div key={`${task.queue}:${task.id}`} className="row" style={{ justifyContent: "space-between", gap: 12, flexWrap: "wrap", padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
      <div><strong>{LABELS[task.name] ?? "Background task"}</strong><span className="small muted"> · {STATES[task.state] ?? "Updating"}</span>
        <div className="small muted">{new Date(task.at).toLocaleString()}</div>
        {task.state === "failed" && <div className="small">Open the related section for details and recovery options.</div>}
      </div>
      {task.canRetry ? <button className="btn small" disabled={busy !== null} onClick={() => void retry(task)}>{busy === task.id ? "Retrying…" : "Retry sync"}</button>
        : task.state === "failed" ? <Link className="btn small" href={task.name.includes("reviews") ? "/reviews" : task.name.includes("social") ? "/social" : task.queue === "crawl" ? "/settings/business" : "/articles"}>View details</Link> : null}
    </div>)}
  </section>;
}
