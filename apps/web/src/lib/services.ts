import { config, createLogger } from "@ob/core";
import { getDb, repo, aiJobs, workspaces, type Database } from "@ob/db";
import { Gateway, buildProviders } from "@ob/ai";
import { QueueRegistry } from "@ob/jobs";
import { eq } from "drizzle-orm";
import { getRedis } from "./redis";

/**
 * Server-side singletons.
 *
 * The web process enqueues work and reads state; the worker executes it. The
 * Gateway is wired here too because a few interactive paths (previewing a voice
 * rewrite, for example) generate synchronously.
 */

// Lazily constructed. Reading config at module scope would make a production
// build require runtime secrets, which it must not.
let logger: ReturnType<typeof createLogger> | undefined;
function log() {
  logger ??= createLogger(config().LOG_LEVEL, { service: "web" });
  return logger;
}

let queues: QueueRegistry | undefined;
let gateway: Gateway | undefined;

export function db(): Database {
  return getDb(config().DATABASE_URL);
}

export function getQueues(): QueueRegistry {
  queues ??= (() => {
    const registry = new QueueRegistry(getRedis());
    // Without this, an enqueue dropped for a duplicate idempotency key returns
    // success to the caller and the UI reports that work has started when
    // nothing was queued at all.
    registry.onDuplicate = (info) => {
      createLogger(config().LOG_LEVEL, { service: "web" }).warn(
        "Enqueue skipped — a job with this idempotency key already exists",
        info,
      );
    };
    return registry;
  })();
  return queues;
}

export function getGateway(): Gateway {
  const cfg = config();
  gateway ??= new Gateway({
    providers: buildProviders({
      ANTHROPIC_API_KEY: cfg.ANTHROPIC_API_KEY,
      GOOGLE_API_KEY: cfg.GOOGLE_API_KEY,
      AI_MOCK: cfg.AI_MOCK,
    }),
    logger: log(),
    recordJob: async (r) => {
      await db().insert(aiJobs).values({
        workspaceId: r.workspaceId,
        correlationId: r.correlationId,
        taskAlias: r.taskAlias,
        provider: r.provider,
        model: r.model,
        promptVersion: r.promptVersion,
        status: r.status,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        cacheReadTokens: r.cacheReadTokens,
        costMicros: r.costMicros,
        latencyMs: r.latencyMs,
        attemptIndex: r.attemptIndex,
        error: r.error ?? null,
        finishedAt: new Date(),
      });
    },
    spendThisPeriod: async (workspaceId) => {
      const now = new Date();
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      return repo.aiSpendSince(db(), workspaceId, start);
    },
    budgetFor: async (workspaceId) => {
      const [row] = await db()
        .select({ budget: workspaces.aiBudgetMicros })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1);
      return row?.budget ?? 0;
    },
  });
  return gateway;
}
