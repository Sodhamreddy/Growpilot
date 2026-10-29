export const dynamic = "force-dynamic";
import { z } from "zod";
import { AppError, requireRole } from "@ob/core";
import { QUEUE_NAMES } from "@ob/jobs";
import { route, parseBody } from "@/lib/api";
import { getQueues } from "@/lib/services";
import { mayRetryJob } from "@/lib/job-recovery";

export const GET = route(async (ctx) => {
  const results = await Promise.all(QUEUE_NAMES.map(async (name) => {
    const queue = getQueues().get(name);
    // Bounded recent history. Never expose another workspace's job data.
    const jobs = await queue.getJobs(["active", "waiting", "delayed", "failed", "completed"], 0, 99, false);
    return Promise.all(jobs.filter((job) => job.data?.workspaceId === ctx.workspaceId).map(async (job) => {
      const state = await job.getState();
      return { id: job.id, queue: name, name: job.name, state, at: job.finishedOn ?? job.processedOn ?? job.timestamp,
        canRetry: state === "failed" && ctx.role !== "viewer" && mayRetryJob(ctx.workspaceId, job),
        attempts: job.attemptsMade };
    }));
  }));
  return { jobs: results.flat().sort((a, b) => b.at - a.at).slice(0, 12) };
});

export const POST = route(async (ctx, req) => {
  requireRole(ctx, "editor");
  const body = await parseBody(req, z.object({ queue: z.enum(QUEUE_NAMES), id: z.string().min(1).max(250) }));
  const job = await getQueues().get(body.queue).getJob(body.id);
  if (!job || !mayRetryJob(ctx.workspaceId, job)) throw new AppError("not_found", "This task cannot be retried here.");
  if (await job.getState() !== "failed") throw new AppError("conflict", "The task is no longer failed. Refresh its status.");
  await job.retry("failed");
  return { ok: true };
}, { rateLimit: { limit: 20, windowSeconds: 3600 } });
