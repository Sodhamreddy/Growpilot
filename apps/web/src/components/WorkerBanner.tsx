"use client";

import { useEffect, useState } from "react";

/**
 * Warns when jobs are queued but no worker is running to execute them.
 *
 * This is the most confusing failure in the whole system: adding a website
 * enqueues a crawl, the UI says "running in the background", and nothing ever
 * happens — because `pnpm dev:worker` was never started. The worker publishes a
 * heartbeat to Redis; if it is absent while work is waiting, say so.
 */
export function WorkerBanner() {
  const [state, setState] = useState<{ stalled: boolean; queued: number } | null>(null);

  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const res = await fetch("/api/jobs/status");
        if (!res.ok || !alive) return;
        const body = (await res.json()) as {
          worker?: { stalled: boolean; queuedJobs: number };
        };
        if (body.worker) {
          setState({ stalled: body.worker.stalled, queued: body.worker.queuedJobs });
        }
      } catch {
        // Transient; the next poll retries.
      }
    };
    void check();
    const id = setInterval(() => void check(), 20_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  if (!state?.stalled) return null;

  return (
    <div className="workerbanner" role="status">
      <span className="wb-dot" aria-hidden="true" />
      <div>
        <strong>
          {state.queued} job{state.queued === 1 ? "" : "s"} waiting, but the worker is not running
        </strong>
        <span>
          Crawling, extraction and article generation all run in a separate process. Start it with{" "}
          <code>pnpm dev:worker</code> and queued work resumes automatically — nothing is lost.
        </span>
      </div>
    </div>
  );
}
