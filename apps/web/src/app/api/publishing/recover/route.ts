import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { AppError, config, open, requireRole } from "@ob/core";
import { articles, integrations, publishJobs, repo } from "@ob/db";
import { wordPressTargetFingerprint, readPost, type WordPressCredential } from "@ob/publish";
import { JOBS, payloadFrom, QueueRegistry } from "@ob/jobs";
import { route, parseBody } from "@/lib/api";
import { db, getQueues } from "@/lib/services";
export const dynamic = "force-dynamic";
export const POST = route(async (ctx, req) => {
  requireRole(ctx, "admin");
  const body = await parseBody(req, z.object({ id: z.string().uuid(), action: z.enum(["reconcile", "retry"]), externalId: z.number().int().positive().optional(), confirmedAbsent: z.boolean().optional() }));
  const database = db();
  const [job] = await database.select().from(publishJobs).where(and(eq(publishJobs.workspaceId, ctx.workspaceId), eq(publishJobs.id, body.id)));
  if (!job || job.provider !== "wordpress") throw new AppError("not_found", "Publish job not found.");
  const queues = getQueues();
  const queued = await queues.get("publish").getJob(QueueRegistry.jobIdFor(`publish-job:${job.id}`));
  if (queued && await queued.getState() === "active") throw new AppError("conflict", "Publishing is still running. Wait before reconciling.");
  if (job.status === "queued" || job.status === "cancelled") throw new AppError("conflict", "This job does not need recovery.");
  if (queued) await queued.remove();
  const article = await repo.getArticle(database, ctx, job.entityId);
  const [integration] = await database.select().from(integrations).where(and(eq(integrations.workspaceId, ctx.workspaceId), eq(integrations.provider, "wordpress"), eq(integrations.scopeKey, article.businessId)));
  if (!integration?.credentialSealed || integration.status !== "connected") throw new AppError("conflict", "Connect WordPress for this client first.");
  const credential = JSON.parse(open(integration.credentialSealed, config().CREDENTIAL_ENCRYPTION_KEY)) as WordPressCredential;
  const targetFingerprint = wordPressTargetFingerprint(credential);
  if (body.action === "reconcile") {
    if (!body.externalId) throw new AppError("validation_failed", "Enter the WordPress post ID.");
    if (job.targetFingerprint !== targetFingerprint) {
      throw new AppError("conflict", "Reconnect the original destination before reconciling this publish.");
    }
    const post = await readPost(credential, body.externalId);
    await database.transaction(async tx => {
      await tx.update(publishJobs).set({ status: "succeeded", externalId: post.externalId, externalUrl: post.externalUrl, lastError: null, completedAt: new Date() }).where(eq(publishJobs.id, job.id));
      await tx.update(articles).set({ publishedUrl: post.externalUrl, ...(post.status === "publish" ? { status: "published" as const, publishedAt: new Date() } : {}) }).where(eq(articles.id, article.id));
    });
  } else {
    if (!body.confirmedAbsent || !["failed", "running"].includes(job.status)) throw new AppError("conflict", "Confirm that no post exists before retrying an interrupted publish.");
    if (job.status === "running" && job.targetFingerprint !== targetFingerprint) throw new AppError("conflict", "Check the original destination before retrying an interrupted publish.");
    const changed = await database.update(publishJobs).set({ status: "queued", integrationId: integration.id, articleVersion: article.version,
      targetFingerprint, scheduledFor: null, lastError: null }).where(and(eq(publishJobs.id, job.id), eq(publishJobs.status, job.status), eq(publishJobs.attempts, job.attempts))).returning({ id: publishJobs.id });
    if (!changed.length) throw new AppError("conflict", "This publish changed. Refresh before recovering it.");
    await queues.enqueue("publish", JOBS.publishArticle, payloadFrom(ctx, { publishJobId: job.id }), { idempotencyKey: `publish-job:${job.id}` });
  }
  await repo.writeAudit(database, ctx, { action: `publish.${body.action}`, entityType: "publish_job", entityId: job.id, after: { externalId: body.externalId ?? null, confirmedAbsent: body.confirmedAbsent ?? false } });
  return { ok: true };
});
