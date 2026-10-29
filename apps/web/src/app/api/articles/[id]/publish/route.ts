import { wordPressTargetFingerprint, type WordPressCredential } from "@ob/publish";
export const dynamic = "force-dynamic";

import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { AppError, idempotencyKey, open, config } from "@ob/core";
import { articles, publishJobs, integrations, workspaces, repo } from "@ob/db";
import { canPublish, assertMayPublish } from "@ob/pipeline";
import { JOBS, payloadFrom } from "@ob/jobs";
import { route, parseBody } from "@/lib/api";
import { db, getQueues } from "@/lib/services";

/**
 * POST /api/articles/:id/publish — spec §11, §14.
 *
 * Publishing is outward-facing and effectively irreversible, so this route is
 * the strictest in the codebase:
 *   - admin role required
 *   - `canPublish` re-evaluated against live state, not the caller's belief
 *   - the target integration must be connected and unexpired
 *   - a deterministic idempotency key means a double-submit cannot publish twice
 *
 * The route records intent; the publish queue performs the external call.
 */

const schema = z.object({
  provider: z.enum(["wordpress", "webflow", "ghost", "webhook"]),
  scheduledFor: z.string().datetime().optional(),
});

export const POST = route(async (ctx, req) => {
  assertMayPublish(ctx);
  const body = await parseBody(req, schema);
  if (body.provider !== "wordpress") throw new AppError("validation_failed", "This publishing connector is not available yet.");
  const id = articleIdFrom(req);
  const database = db();

  const article = await repo.getArticle(database, ctx, id);

  const [workspace] = await database
    .select({ settings: workspaces.settings })
    .from(workspaces)
    .where(eq(workspaces.id, ctx.workspaceId))
    .limit(1);

  const gates = await repo.listGateResults(database, ctx, id, article.version);

  const decision = canPublish(
    {
      status: article.status,
      seoScore: article.seoScore,
      voiceScore: article.voiceScore,
      approvedAt: article.approvedAt,
    },
    workspace?.settings ?? {},
    gates.map((g) => ({ gate: g.gate, verdict: g.verdict })),
  );

  if (!decision.allowed) {
    throw new AppError("forbidden", "This article cannot be published yet.", {
      details: { reasons: decision.reasons },
      retryable: false,
    });
  }

  // The integration must be usable right now (spec §11.1: pause connections
  // after repeated authorization failures).
  const [integration] = await database
    .select()
    .from(integrations)
    .where(
      and(eq(integrations.workspaceId, ctx.workspaceId), eq(integrations.provider, body.provider), eq(integrations.scopeKey, article.businessId)),
    )
    .limit(1);

  if (!integration) {
    throw new AppError("validation_failed", `No ${body.provider} connection is set up for this workspace.`, {
      details: { provider: body.provider },
      retryable: false,
    });
  }

  if (integration.status !== "connected" || !integration.credentialSealed) {
    throw new AppError("forbidden", `The ${body.provider} connection is ${integration.status}. Reconnect it in Integrations.`, {
      details: { provider: body.provider, status: integration.status },
      retryable: false,
    });
  }

  if (integration.expiresAt && integration.expiresAt < new Date()) {
    throw new AppError("forbidden", `The ${body.provider} connection has expired. Reconnect it in Integrations.`, {
      details: { provider: body.provider },
      retryable: false,
    });
  }

  // Keyed on the article version: republishing an unchanged version is a
  // no-op, publishing a revised version is a new job (spec §11.1).
  const key = idempotencyKey("publish", body.provider, id, article.version);

  const [existing] = await database
    .select({ id: publishJobs.id, status: publishJobs.status, externalUrl: publishJobs.externalUrl, scheduledFor: publishJobs.scheduledFor })
    .from(publishJobs)
    .where(
      and(eq(publishJobs.workspaceId, ctx.workspaceId), eq(publishJobs.idempotencyKey, key)),
    )
    .limit(1);

  if (existing) {
    if (existing.status === "queued") await getQueues().enqueue("publish", JOBS.publishArticle,
      payloadFrom(ctx, { publishJobId: existing.id }), { idempotencyKey: `publish-job:${existing.id}`, delayMs: Math.max(0, (existing.scheduledFor?.getTime() ?? Date.now()) - Date.now()) });
    return {
      ok: true,
      deduplicated: true,
      publishJobId: existing.id,
      status: existing.status,
      externalUrl: existing.externalUrl,
    };
  }

  const scheduledFor = body.scheduledFor ? new Date(body.scheduledFor) : null;

  const [job] = await database
    .insert(publishJobs)
    .values({
      workspaceId: ctx.workspaceId,
      provider: body.provider,
      integrationId: integration.id,
      articleVersion: article.version,
      targetFingerprint: wordPressTargetFingerprint(JSON.parse(open(integration.credentialSealed, config().CREDENTIAL_ENCRYPTION_KEY)) as WordPressCredential),
      entityType: "article",
      entityId: id,
      idempotencyKey: key,
      status: "queued",
      scheduledFor,
    })
    .onConflictDoNothing({ target: [publishJobs.workspaceId, publishJobs.idempotencyKey] })
    .returning();

  if (!job) throw new AppError("conflict", "A publish request already exists. Refresh to see its status.");

  if (scheduledFor) {
    await database.update(articles).set({ status: "scheduled" }).where(eq(articles.id, id));
  }

  await repo.writeAudit(database, ctx, {
    action: "article.publish_requested",
    entityType: "article",
    entityId: id,
    after: {
      provider: body.provider,
      version: article.version,
      scheduledFor: scheduledFor?.toISOString() ?? "immediate",
      publishJobId: job!.id,
    },
  });

  /*
   * Hand the job to the publish queue.
   *
   * The row above is the record of intent and carries the idempotency
   * guarantee; the queue performs the external call. The queued job carries
   * only the publish job id — every fact it needs is re-read from the database
   * by the worker, because a job can sit in the queue while someone
   * un-approves the article, and a payload snapshot would not notice.
   */
  await getQueues().enqueue(
    "publish",
    JOBS.publishArticle,
    payloadFrom(ctx, { publishJobId: job!.id }),
    { idempotencyKey: `publish-job:${job!.id}`, ...(scheduledFor ? { delayMs: Math.max(0, scheduledFor.getTime() - Date.now()) } : {}) },
  );

  return {
    ok: true,
    publishJobId: job!.id,
    status: "queued",
    scheduledFor: scheduledFor?.toISOString() ?? null,
  };
});

function articleIdFrom(req: Request): string {
  const segments = new URL(req.url).pathname.split("/");
  return segments[segments.indexOf("articles") + 1] ?? "";
}
