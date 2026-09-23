import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Load the monorepo-root .env before anything reads process.env. A real
// environment variable (container, CI) always wins over the file.
loadEnv({
  path: join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".env"),
  override: false,
});

import { Worker, type Job } from "bullmq";
import { AppError, toAppError } from "@ob/core";
import { JOBS, QUEUE_CONFIG, QUEUE_NAMES, type QueueName, type JobPayload } from "@ob/jobs";
import { createWorkerContext, type WorkerContext } from "./context.js";
/*
 * Processors are grouped by the module that owns them.
 *
 * `shared/` is work every module needs — crawling the site, extracting the
 * profile and the voice, indexing the knowledge base. `blog/` is the article
 * loop. Social and GMB get their own directories as they are built, and a
 * processor never reaches across into another module's folder.
 */
import {
  processCrawlSite, processExtractProfile, processExtractVoice, processIndexKnowledge,
  type CrawlPayload,
} from "./processors/shared/crawl.js";
import {
  processGenerateArticle, processRunQualityGates, type ArticlePayload,
} from "./processors/blog/article.js";
import { processResearchKeywords, type ResearchPayload } from "./processors/blog/research.js";
import { processBuildContentPlan, type PlanPayload } from "./processors/blog/plan.js";
import { processPublish, type PublishPayload } from "./processors/blog/publish.js";
import { processSocialInsights } from "./processors/social/insights.js";
import {
  processScheduledRun, restoreSchedules, type ScheduledRunPayload,
} from "./processors/blog/scheduled.js";

/**
 * Worker entrypoint — spec §12.
 *
 * One BullMQ Worker per queue, each with its own concurrency. Failures that
 * exhaust their retries are moved to the dead-letter queue rather than
 * vanishing, so §12.1's "replayable failed jobs" is satisfied.
 */

type Processor = (wc: WorkerContext, payload: never, signal: AbortSignal) => Promise<unknown>;

const PROCESSORS: Record<string, Processor> = {
  [JOBS.crawlSite]: processCrawlSite as Processor,
  [JOBS.extractProfile]: processExtractProfile as Processor,
  [JOBS.extractVoice]: processExtractVoice as Processor,
  [JOBS.indexKnowledge]: processIndexKnowledge as Processor,
  [JOBS.researchKeywords]: processResearchKeywords as Processor,
  [JOBS.buildContentPlan]: processBuildContentPlan as Processor,
  [JOBS.generateArticle]: processGenerateArticle as Processor,
  [JOBS.runQualityGates]: processRunQualityGates as Processor,
  [JOBS.publishArticle]: processPublish as Processor,
  [JOBS.scheduledContentRun]: processScheduledRun as Processor,
  // The job name has existed since the queues were defined; this is the
  // processor it was reserved for.
  [JOBS.ingestMetrics]: processSocialInsights as Processor,
};

/** Wall-clock ceiling per job, so a hung provider cannot occupy a slot forever. */
const JOB_TIMEOUT_MS: Record<QueueName, number> = {
  crawl: 15 * 60_000,
  research: 10 * 60_000,
  ai: 20 * 60_000,
  qa: 15 * 60_000,
  publish: 5 * 60_000,
  analytics: 10 * 60_000,
  maintenance: 30 * 60_000,
};

/**
 * Render an error cause for the log.
 *
 * Only the top frames of the stack: enough to locate the failure, short enough
 * not to bury the rest of the line. The logger redacts secrets on the way out.
 */
function describeCause(cause: unknown): unknown {
  if (cause === undefined || cause === null) return undefined;
  if (cause instanceof Error) {
    const frames = (cause.stack ?? "").split(/\r?\n/).slice(0, 4).map((f) => f.trim());
    return { name: cause.name, message: cause.message, stack: frames.join(" | ") };
  }
  return String(cause);
}

/**
 * Record a terminal job failure on whatever row the job was driving, so a
 * dead job never leaves a record stuck in an in-progress state.
 */
async function markJobEntityFailed(
  wc: WorkerContext,
  jobName: string,
  payload: JobPayload,
  reason: string,
): Promise<void> {
  const { businessSources, articles } = await import("@ob/db");
  const { eq, and, inArray } = await import("drizzle-orm");

  if ([JOBS.crawlSite, JOBS.extractProfile, JOBS.extractVoice, JOBS.indexKnowledge].some((name) => name === jobName) && typeof payload["sourceId"] === "string") {
    await wc.db
      .update(businessSources)
      .set({ crawlStatus: "failed", lastError: reason.slice(0, 500) })
      .where(
        and(
          eq(businessSources.workspaceId, payload.workspaceId),
          eq(businessSources.id, payload["sourceId"]),
          // Only rows still in flight — never overwrite a finished crawl.
          inArray(businessSources.crawlStatus, ["pending", "running"]),
        ),
      );
    return;
  }

  if (jobName === JOBS.generateArticle && typeof payload["articleId"] === "string") {
    await wc.db
      .update(articles)
      .set({ status: "failed", updatedAt: new Date() })
      .where(
        and(
          eq(articles.workspaceId, payload.workspaceId),
          eq(articles.id, payload["articleId"]),
          inArray(articles.status, ["draft", "generating"]),
        ),
      );
  }
}

/**
 * Reclaim rows left mid-flight by a worker that died.
 *
 * `markJobEntityFailed` runs from the "failed" event, which needs a live
 * worker to fire it. A process that is killed — OOM, a crash, a deploy, Ctrl+C
 * during a job — never emits it, so the row it was driving stays "running" or
 * "generating" forever. The UI polls those states indefinitely and the customer
 * sees a spinner that will never resolve, with no error to explain it.
 *
 * Anything still in flight when a worker boots cannot belong to this process,
 * so it is stale by definition: no job is running yet. The cutoff only guards
 * against a second worker starting alongside a healthy one, where a genuinely
 * active job could otherwise be marked failed out from under it.
 */
async function reclaimStaleWork(wc: WorkerContext): Promise<void> {
  const { businessSources, articles } = await import("@ob/db");
  const { and, inArray, lt } = await import("drizzle-orm");

  const cutoff = new Date(Date.now() - Math.max(...Object.values(JOB_TIMEOUT_MS)));
  const reason = "The worker stopped before this finished. Run it again.";

  try {
    const staleCrawls = await wc.db
      .update(businessSources)
      .set({ crawlStatus: "failed", lastError: reason })
      .where(and(
        inArray(businessSources.crawlStatus, ["pending", "running"]),
        lt(businessSources.createdAt, cutoff),
      ))
      .returning({ id: businessSources.id });

    const staleArticles = await wc.db
      .update(articles)
      .set({ status: "failed", updatedAt: new Date() })
      .where(and(
        inArray(articles.status, ["generating"]),
        lt(articles.updatedAt, cutoff),
      ))
      .returning({ id: articles.id });

    if (staleCrawls.length > 0 || staleArticles.length > 0) {
      wc.logger.warn("Reclaimed work abandoned by a previous worker", {
        crawls: staleCrawls.length,
        articles: staleArticles.length,
      });
    }
  } catch (err) {
    // Never let recovery stop the worker from coming up.
    wc.logger.error("Could not reclaim stale work", { error: String(err) });
  }
}

async function main(): Promise<void> {
  const wc = createWorkerContext();
  wc.logger.info("Worker starting", {
    queues: QUEUE_NAMES.join(","),
    aiMock: wc.cfg.AI_MOCK === 1,
  });

  await reclaimStaleWork(wc);

  /*
   * Redis holds the repeat definitions, the database holds the intent. Restoring
   * on boot means a flushed Redis or a fresh environment cannot leave schedules
   * that are configured but firing nowhere.
   */
  await restoreSchedules(wc);

  const workers: Worker[] = [];

  for (const queueName of QUEUE_NAMES) {
    const cfg = QUEUE_CONFIG[queueName];

    const worker = new Worker(
      queueName,
      async (job: Job<JobPayload>) => {
        const processor = PROCESSORS[job.name];
        if (!processor) {
          // An unknown job name is a deploy-skew bug, not a transient fault.
          throw new AppError("internal", `No processor is registered for "${job.name}".`, {
            retryable: false,
          });
        }

        const log = wc.logger.child({
          queue: queueName,
          jobId: job.id ?? "",
          jobName: job.name,
          correlationId: job.data.correlationId,
          workspaceId: job.data.workspaceId,
          attempt: job.attemptsMade + 1,
        });

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), JOB_TIMEOUT_MS[queueName]);
        const started = Date.now();

        try {
          log.info("Job started");
          const result = await processor(wc, job.data as never, controller.signal);
          log.info("Job succeeded", { durationMs: Date.now() - started });
          return result;
        } catch (err) {
          const appErr = toAppError(err);
          // `safeMessage` is written for end users and says nothing useful to
          // an operator. The underlying cause is what makes a failure
          // diagnosable, so it is logged too — the logger redacts secrets.
          const cause = appErr.cause;
          log.error("Job failed", {
            code: appErr.code,
            retryable: appErr.retryable,
            durationMs: Date.now() - started,
            message: appErr.safeMessage,
            details: appErr.details,
            cause: describeCause(cause),
          });

          // A non-retryable failure should not burn the remaining attempts.
          if (!appErr.retryable) {
            await job.discard();
          }
          throw appErr;
        } finally {
          clearTimeout(timer);
        }
      },
      {
        connection: wc.redis,
        concurrency: cfg.concurrency,
        // Provider-facing queues get a rate limit (spec §12.1).
        ...(queueName === "ai" || queueName === "publish"
          ? { limiter: { max: 30, duration: 60_000 } }
          : {}),
      },
    );

    worker.on("failed", (job, err) => {
      if (!job) return;
      const exhausted = job.attemptsMade >= (job.opts.attempts ?? 1);
      if (exhausted) {
        /*
         * Close out any row the job was tracking.
         *
         * A processor updates its own row in its catch block, but a job can die
         * before the processor runs at all — a timeout, a discard, a crash. The
         * row is then left "pending" forever and the onboarding screen polls it
         * indefinitely with no way to know the work is dead. This is the last
         * chance to record that.
         */
        void markJobEntityFailed(wc, job.name, job.data as JobPayload, err.message).catch(
          (markErr: unknown) => {
            wc.logger.error("Could not mark entity failed", { error: String(markErr) });
          },
        );

        void wc.queues
          .toDeadLetter(queueName, job.name, job.data as JobPayload, err.message)
          .then(() => {
            wc.logger.warn("Job moved to dead-letter queue", {
              queue: queueName,
              jobId: job.id ?? "",
              jobName: job.name,
            });
          })
          .catch((dlqErr: unknown) => {
            wc.logger.error("Failed to dead-letter a job", { error: String(dlqErr) });
          });
      }
    });

    worker.on("error", (err) => {
      wc.logger.error("Worker error", { queue: queueName, error: String(err) });
    });

    workers.push(worker);
  }

  wc.logger.info("Worker ready", { workers: workers.length });

  /*
   * Heartbeat.
   *
   * Without the worker running, enqueued jobs sit in Redis and the dashboard
   * silently shows nothing — a crawl appears to hang forever. This key lets the
   * web app say "the worker is not running" instead of leaving the user to
   * guess. TTL is 3x the interval, so one missed beat is not a false alarm.
   */
  const HEARTBEAT_KEY = "worker:heartbeat";
  const beat = () =>
    wc.redis.set(HEARTBEAT_KEY, new Date().toISOString(), "EX", 45).catch(() => {
      // A failed heartbeat must never take the worker down.
    });
  void beat();
  const heartbeat = setInterval(() => void beat(), 15_000);

  // ── Graceful shutdown ──
  // Stop accepting new jobs, let in-flight work finish, then close connections.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    wc.logger.info("Shutting down", { signal });

    clearInterval(heartbeat);
    await wc.redis.del("worker:heartbeat").catch(() => {});
    await Promise.all(workers.map((w) => w.close()));
    await wc.queues.close();
    await wc.redis.quit();

    wc.logger.info("Shutdown complete");
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  process.on("unhandledRejection", (reason) => {
    wc.logger.error("Unhandled rejection", { reason: String(reason) });
  });
}

main().catch((err: unknown) => {
  console.error("Worker failed to start:", err);
  process.exit(1);
});
