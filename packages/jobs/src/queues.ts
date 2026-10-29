import { Queue, type JobsOptions, type ConnectionOptions } from "bullmq";
import type { TenantContext } from "@ob/core";

/**
 * Job orchestration — spec §12.
 *
 * Seven queues, matching the spec's table exactly. Reliability requirements
 * from §12.1 are encoded in `DEFAULT_JOB_OPTIONS` and the worker setup:
 *   - durable queues            → Redis-backed BullMQ
 *   - exponential retry         → `backoff: { type: "exponential" }`
 *   - dead-letter queue         → failed jobs retained, moved by `toDeadLetter`
 *   - rate limits               → per-queue limiter in the worker
 *   - timeout and cancellation  → AbortSignal threaded into each processor
 *   - correlation IDs           → carried on every payload
 *   - replayable failures       → `replay()` re-enqueues from the DLQ
 *   - idempotent externals      → deterministic `jobId`
 */

export const QUEUE_NAMES = [
  "crawl",
  "research",
  "ai",
  "qa",
  "publish",
  "analytics",
  "maintenance",
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

export const DEAD_LETTER_QUEUE = "dead-letter";

/** Per-queue tuning. Slow external work gets fewer attempts and more room. */
export const QUEUE_CONFIG: Record<QueueName, { attempts: number; backoffMs: number; concurrency: number }> = {
  crawl: { attempts: 3, backoffMs: 10_000, concurrency: 2 },
  research: { attempts: 3, backoffMs: 5_000, concurrency: 4 },
  ai: { attempts: 3, backoffMs: 15_000, concurrency: 4 },
  qa: { attempts: 3, backoffMs: 5_000, concurrency: 6 },
  publish: { attempts: 5, backoffMs: 30_000, concurrency: 2 },
  analytics: { attempts: 3, backoffMs: 60_000, concurrency: 2 },
  maintenance: { attempts: 2, backoffMs: 60_000, concurrency: 1 },
};

/** Every job payload carries tenancy and correlation (spec §12.1). */
export interface JobPayload {
  workspaceId: string;
  userId: string;
  correlationId: string;
  [key: string]: unknown;
}

export function payloadFrom(ctx: TenantContext, data: Record<string, unknown>): JobPayload {
  return {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    correlationId: ctx.correlationId,
    ...data,
  };
}

/**
 * BullMQ stores jobs under `bull:<queue>:<id>`, so a custom job id containing a
 * colon is rejected outright ("Custom Id cannot contain :"). Our idempotency
 * keys are colon-separated for readability, so they are translated here rather
 * than every call site having to remember.
 *
 * The mapping must stay injective: two different keys must never collapse to
 * the same id, or one job would silently suppress another.
 */
export function toJobId(idempotencyKey: string): string {
  return idempotencyKey.replace(/_/g, "__").replace(/:/g, "_");
}

export function defaultJobOptions(queue: QueueName): JobsOptions {
  const cfg = QUEUE_CONFIG[queue];
  return {
    attempts: cfg.attempts,
    backoff: { type: "exponential", delay: cfg.backoffMs },
    // Keep a bounded history: enough to debug, not enough to fill Redis.
    removeOnComplete: { age: 24 * 3600, count: 1000 },
    // Failed jobs are retained so they can be inspected and replayed.
    removeOnFail: { age: 14 * 24 * 3600 },
  };
}

export class QueueRegistry {
  readonly #queues = new Map<string, Queue>();
  readonly #connection: ConnectionOptions;

  /**
   * Called when an enqueue is dropped because its idempotency key is already
   * taken. Wired to the logger by the caller so a silently skipped job leaves
   * a trace instead of looking like a stalled pipeline.
   */
  onDuplicate?: (info: {
    queue: QueueName;
    jobName: string;
    jobId: string;
    state: string;
    idempotencyKey: string;
  }) => void;

  constructor(connection: ConnectionOptions) {
    this.#connection = connection;
  }

  get(name: QueueName | typeof DEAD_LETTER_QUEUE): Queue {
    let queue = this.#queues.get(name);
    if (!queue) {
      queue = new Queue(name, { connection: this.#connection });
      this.#queues.set(name, queue);
    }
    return queue;
  }

  /**
   * Enqueue a job.
   *
   * `idempotencyKey` becomes the BullMQ job ID, so re-submitting the same
   * logical work is a no-op rather than a duplicate — spec §12.1 "Idempotent
   * external operations" and §11.1 "Use idempotency keys".
   */
  async enqueue(
    queue: QueueName,
    jobName: string,
    payload: JobPayload,
    opts: { idempotencyKey?: string; delayMs?: number; priority?: number } = {},
  ): Promise<string> {
    const jobOptions: JobsOptions = { ...defaultJobOptions(queue) };
    if (opts.idempotencyKey) jobOptions.jobId = toJobId(opts.idempotencyKey);
    if (opts.delayMs !== undefined) jobOptions.delay = opts.delayMs;
    if (opts.priority !== undefined) jobOptions.priority = opts.priority;

    /*
     * Make de-duplication visible.
     *
     * BullMQ's `add` silently returns the existing job when the id is already
     * taken — no error, nothing logged. A stale or over-broad idempotency key
     * therefore drops work on the floor and looks exactly like a pipeline that
     * has stalled: the caller gets a job id back, the job never runs, and there
     * is nothing anywhere to explain why. Checking first costs one Redis round
     * trip per keyed enqueue and turns that into a log line.
     */
    const q = this.get(queue);

    if (jobOptions.jobId) {
      const existing = await q.getJob(jobOptions.jobId);
      if (existing) {
        const state = await existing.getState().catch(() => "unknown");
        this.onDuplicate?.({
          queue, jobName, jobId: jobOptions.jobId, state,
          idempotencyKey: opts.idempotencyKey ?? "",
        });
        return existing.id ?? jobOptions.jobId;
      }
    }

    const job = await q.add(jobName, payload, jobOptions);
    return job.id ?? opts.idempotencyKey ?? "";
  }

  /**
   * Register a repeating job.
   *
   * BullMQ owns the schedule, not a cron process of our own: the repeat state
   * lives in Redis, so it survives a worker restart and does not fire twice
   * when two workers are running. Re-registering the same `key` replaces the
   * schedule rather than adding a second one, which is what makes this safe to
   * call on every boot.
   */
  async schedule(
    queue: QueueName,
    jobName: string,
    payload: JobPayload,
    opts: { key: string; cron: string; timezone?: string },
  ): Promise<void> {
    const q = this.get(queue);

    // Drop any previous definition for this key, including one with a cron
    // expression that has since changed.
    for (const existing of await q.getJobSchedulers()) {
      if (existing.key === opts.key) await q.removeJobScheduler(existing.key);
    }

    await q.upsertJobScheduler(
      opts.key,
      { pattern: opts.cron, ...(opts.timezone ? { tz: opts.timezone } : {}) },
      { name: jobName, data: payload, opts: defaultJobOptions(queue) },
    );
  }

  /** Remove a repeating job. Safe to call when none is registered. */
  /**
   * Remove a one-off job that has not run yet, by the idempotency key it was
   * enqueued with. For a delayed job being moved or cancelled; a job already
   * running is left to finish, and one that finished is simply gone.
   */
  async removeJob(queue: QueueName, idempotencyKey: string): Promise<boolean> {
    const job = await this.get(queue).getJob(toJobId(idempotencyKey));
    if (!job) return false;
    const state = await job.getState().catch(() => "unknown");
    if (state === "active") return false;
    await job.remove();
    return true;
  }

  async unschedule(queue: QueueName, key: string): Promise<void> {
    const q = this.get(queue);
    for (const existing of await q.getJobSchedulers()) {
      if (existing.key === key) await q.removeJobScheduler(existing.key);
    }
  }

  /** What is currently scheduled on a queue — for the UI and for diagnosis. */
  async listSchedules(queue: QueueName): Promise<
    { key: string; pattern: string | undefined; next: number | undefined }[]
  > {
    return (await this.get(queue).getJobSchedulers()).map((s) => ({
      key: s.key,
      pattern: s.pattern ?? undefined,
      next: s.next ?? undefined,
    }));
  }

  /** Re-enqueue with the same key — used by callers that want the job id back. */
  static jobIdFor(idempotencyKey: string): string {
    return toJobId(idempotencyKey);
  }

  /** Move an exhausted job to the dead-letter queue for manual inspection. */
  async toDeadLetter(
    originQueue: QueueName,
    jobName: string,
    payload: JobPayload,
    error: string,
  ): Promise<void> {
    await this.get(DEAD_LETTER_QUEUE).add(
      jobName,
      { ...payload, __originQueue: originQueue, __error: error, __failedAt: new Date().toISOString() },
      { removeOnComplete: false, removeOnFail: false },
    );
  }

  /** Re-enqueue a dead-lettered job onto its original queue (spec §12.1). */
  async replay(deadLetterJobId: string): Promise<string> {
    const dlq = this.get(DEAD_LETTER_QUEUE);
    const job = await dlq.getJob(deadLetterJobId);
    if (!job) throw new Error(`Dead-letter job ${deadLetterJobId} not found`);

    const { __originQueue, __error, __failedAt, ...payload } = job.data as JobPayload & {
      __originQueue: QueueName;
      __error: string;
      __failedAt: string;
    };
    void __error;
    void __failedAt;

    const id = await this.enqueue(__originQueue, job.name, payload as JobPayload);
    await job.remove();
    return id;
  }

  async counts(): Promise<Record<string, Record<string, number>>> {
    const out: Record<string, Record<string, number>> = {};
    for (const name of [...QUEUE_NAMES, DEAD_LETTER_QUEUE]) {
      out[name] = await this.get(name as QueueName).getJobCounts(
        "waiting", "active", "completed", "failed", "delayed",
      );
    }
    return out;
  }

  async close(): Promise<void> {
    await Promise.all([...this.#queues.values()].map((q) => q.close()));
    this.#queues.clear();
  }
}

// ─── Job names ──────────────────────────────────────────────────────────────

export const JOBS = {
  crawlSite: "crawl.site",
  extractProfile: "crawl.extract-profile",
  extractVoice: "crawl.extract-voice",
  indexKnowledge: "crawl.index-knowledge",
  researchKeywords: "research.keywords",
  buildContentPlan: "research.content-plan",
  generateBrief: "ai.generate-brief",
  generateArticle: "ai.generate-article",
  runQualityGates: "qa.run-gates",
  publishArticle: "publish.article",
  publishSocialPost: "publish.social-post",
  /** Read one client's Google reviews, then draft replies to the new ones. */
  syncReviews: "analytics.reviews-sync",
  /** Fires every few hours; queues a review sync for every client with a listing. */
  reviewsSweep: "maintenance.reviews-sweep",
  socialInsightsSweep: "maintenance.social-insights-sweep",
  ingestMetrics: "analytics.ingest",
  refreshContent: "maintenance.refresh",
  /** Fires on a schedule; fans out one plan job per client that is due. */
  scheduledContentRun: "maintenance.scheduled-run",
} as const;

export type JobName = (typeof JOBS)[keyof typeof JOBS];
