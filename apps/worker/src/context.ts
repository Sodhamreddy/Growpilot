import IORedis from "ioredis";
import { config, createLogger, systemContext, type Logger, type TenantContext } from "@ob/core";
import { getDb, repo, reserveAiBudget, recordAiUsage, type Database } from "@ob/db";
import { Gateway, buildProviders } from "@ob/ai";
import { QueueRegistry } from "@ob/jobs";

/**
 * Shared runtime wiring for the worker process.
 *
 * The Gateway's dependencies are bound here: job recording and the budget
 * lookup both hit the database, which is what makes the per-workspace spend
 * ceiling in spec §5.2 real rather than advisory.
 */

export interface WorkerContext {
  db: Database;
  gateway: Gateway;
  queues: QueueRegistry;
  redis: IORedis;
  logger: Logger;
  cfg: ReturnType<typeof config>;
}

export function createWorkerContext(): WorkerContext {
  const cfg = config();
  const logger = createLogger(cfg.LOG_LEVEL, { service: "worker" });
  /*
   * The worker waits longer for a connection than the web app does.
   *
   * A page load that stalls is an annoyance the customer can retry; a crawl
   * that dies halfway through is minutes of work and API spend thrown away.
   * Managed Postgres can also be slow to hand out the first connection after
   * an idle period, and failing a long job over that is the wrong trade.
   */
  process.env.DATABASE_CONNECT_TIMEOUT ??= "120";
  const db = getDb(cfg.DATABASE_URL);

  const redis = new IORedis(cfg.REDIS_URL, {
    maxRetriesPerRequest: null, // required by BullMQ
    enableReadyCheck: false,
  });

  const gateway = new Gateway({
    providers: buildProviders({
      ANTHROPIC_API_KEY: cfg.ANTHROPIC_API_KEY,
      GOOGLE_API_KEY: cfg.GOOGLE_API_KEY,
      AI_MOCK: cfg.AI_MOCK,
    }),
    logger,
    reserveBudget: (workspaceId, estimate) => reserveAiBudget(db, workspaceId, estimate),
    recordJob: async (record) => {
      const { aiJobs } = await import("@ob/db");
      await recordAiUsage(db, {
        workspaceId: record.workspaceId,
        correlationId: record.correlationId,
        taskAlias: record.taskAlias,
        provider: record.provider,
        model: record.model,
        promptVersion: record.promptVersion,
        status: record.status,
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        cacheReadTokens: record.cacheReadTokens,
        costMicros: record.costMicros,
        latencyMs: record.latencyMs,
        attemptIndex: record.attemptIndex,
        error: record.error ?? null,
        finishedAt: new Date(),
      }, record.reservationId);
    },
    spendThisPeriod: async (workspaceId) => {
      const start = startOfMonth();
      return repo.aiSpendSince(db, workspaceId, start);
    },
    budgetFor: async (workspaceId) => {
      const { workspaces } = await import("@ob/db");
      const { eq } = await import("drizzle-orm");
      const [row] = await db
        .select({ budget: workspaces.aiBudgetMicros })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1);
      return row?.budget ?? 0;
    },
  });

  const queues = new QueueRegistry(redis);
  // A job dropped for a duplicate key is indistinguishable from a stalled
  // pipeline unless it says so.
  queues.onDuplicate = (info) => {
    logger.warn("Enqueue skipped — a job with this idempotency key already exists", info);
  };

  return { db, gateway, queues, redis, logger, cfg };
}

export function startOfMonth(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Rebuild a tenant context from a job payload (spec §12.1 correlation IDs). */
export function contextFromPayload(payload: {
  workspaceId: string;
  userId: string;
  correlationId: string;
}): TenantContext {
  return payload.userId === "system"
    ? systemContext(payload.workspaceId, payload.correlationId)
    : {
        userId: payload.userId,
        workspaceId: payload.workspaceId,
        role: "admin",
        correlationId: payload.correlationId,
      };
}
