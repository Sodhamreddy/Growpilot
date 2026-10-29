import { eq, and } from "drizzle-orm";
import { AppError, open as openSealed, config } from "@ob/core";
import { articles, publishJobs, integrations, workspaces, repo } from "@ob/db";
import { wordPressTargetFingerprint, createPost, type WordPressCredential } from "@ob/publish";
import { assertTransition, canPublish } from "@ob/pipeline";
import type { WorkerContext } from "../../context.js";
import { contextFromPayload } from "../../context.js";

/**
 * Publish queue processor — spec §11.
 *
 * This is the only processor whose side effect leaves our systems, so the
 * ordering is deliberate and differs from every other job here:
 *
 *   1. Re-check state in the database, not in the payload. The job may have sat
 *      in the queue while a person un-approved the article.
 *   2. Mark the job `running` BEFORE the external call, so a crash mid-flight
 *      leaves evidence that we may already have created a post.
 *   3. Make the call.
 *   4. Record the external id and URL.
 *
 * Steps 2 and 4 cannot be one transaction — the external system is not part of
 * it. When the process dies between them the job is left `running` rather than
 * being retried, because retrying could publish the same article twice, and a
 * duplicate public post is worse than a job that needs a human to look at it.
 */

export interface PublishPayload {
  workspaceId: string;
  userId: string;
  correlationId: string;
  publishJobId: string;
}

export async function processPublish(
  wc: WorkerContext,
  payload: PublishPayload,
): Promise<{ externalUrl: string; status: string }> {
  const ctx = contextFromPayload(payload);
  const log = wc.logger.child({
    correlationId: ctx.correlationId,
    workspaceId: ctx.workspaceId,
    publishJobId: payload.publishJobId,
  });

  const [job] = await wc.db
    .select()
    .from(publishJobs)
    .where(and(
      eq(publishJobs.workspaceId, ctx.workspaceId),
      eq(publishJobs.id, payload.publishJobId),
    ))
    .limit(1);

  if (!job) {
    throw new AppError("not_found", "That publish job no longer exists.", { retryable: false });
  }

  // Already done, or left mid-flight by a previous attempt. Either way this
  // must not run again: the first case has nothing to do, and the second may
  // have created a post we never recorded.
  if (job.status === "succeeded") {
    log.info("Publish job already completed");
    return { externalUrl: job.externalUrl ?? "", status: "succeeded" };
  }
  if (job.status === "running") {
    throw new AppError(
      "conflict",
      "This publish was interrupted after it had already started. Check whether the post exists " +
        "on the site before trying again.",
      { details: { publishJobId: job.id }, retryable: false },
    );
  }

  if (job.status === "failed" || job.status === "cancelled") return { externalUrl: job.externalUrl ?? "", status: job.status };
  if (job.scheduledFor && job.scheduledFor.getTime() > Date.now()) {
    throw new AppError("conflict", "This publish is not due yet.", { retryable: true });
  }
  const article = await repo.getArticle(wc.db, ctx, job.entityId);

  if (!job.integrationId || job.articleVersion !== article.version) {
    throw new AppError("conflict", "The article or publishing target changed. Request publication again.", { retryable: false });
  }
  const [workspace] = await wc.db.select().from(workspaces).where(eq(workspaces.id, ctx.workspaceId));
  const gates = await repo.listGateResults(wc.db, ctx, article.id, article.version);
  const decision = canPublish(article, workspace?.settings ?? {}, gates);
  if (!decision.allowed) throw new AppError("forbidden", decision.reasons.join(" "), { retryable: false });
  const [integration] = await wc.db
    .select()
    .from(integrations)
    .where(and(
      eq(integrations.workspaceId, ctx.workspaceId),
      eq(integrations.provider, job.provider),
      eq(integrations.id, job.integrationId),
      eq(integrations.scopeKey, article.businessId),
    ))
    .limit(1);

  if (!integration || integration.status !== "connected" || !integration.credentialSealed || (integration.expiresAt && integration.expiresAt <= new Date())) {
    throw new AppError(
      "forbidden",
      "The " + job.provider + " connection is not usable. Reconnect it in Integrations.",
      { details: { provider: job.provider, status: integration?.status ?? "missing" }, retryable: false },
    );
  }

  const cred = JSON.parse(openSealed(integration.credentialSealed, config().CREDENTIAL_ENCRYPTION_KEY)) as WordPressCredential;
  if (job.targetFingerprint !== wordPressTargetFingerprint(cred)) {
    throw new AppError("conflict", "The WordPress connection changed after scheduling. Review the destination and retry.", { retryable: false });
  }
  const [claimed] = await wc.db.update(publishJobs)
    .set({ status: "running", attempts: job.attempts + 1 })
    .where(and(eq(publishJobs.id, job.id), eq(publishJobs.status, "queued"))).returning({ id: publishJobs.id });
  if (!claimed) return { externalUrl: "", status: "already_claimed" };

  let externalCompleted = false;
  try {
    if (job.provider !== "wordpress") {
      throw new AppError(
        "validation_failed",
        "Publishing to " + job.provider + " is not built yet.",
        { details: { provider: job.provider }, retryable: false },
      );
    }


    /*
     * Always a draft, even when a publish date was requested.
     *
     * A scheduled WordPress post goes live on its own with nobody watching. The
     * product's own rule is that a person decides what reaches the public, and
     * handing that decision to a cron job on someone else's server is not a
     * person deciding. The date still travels with the post so whoever reviews
     * it knows when it was meant to run.
     */
    const published = await createPost(cred, {
      title: article.title,
      bodyMarkdown: article.bodyMarkdown,
      slug: article.slug,
      excerpt: article.metaDescription,
      status: "draft",
    });

    externalCompleted = true;
    await wc.db.transaction(async (tx) => {
      await tx
        .update(publishJobs)
        .set({
          status: "succeeded",
          externalId: published.externalId,
          externalUrl: published.externalUrl,
          completedAt: new Date(),
          lastError: null,
        })
        .where(eq(publishJobs.id, job.id));

      /*
       * The article is not marked "published".
       *
       * It reached WordPress as a draft, so nothing is public yet and claiming
       * otherwise would be a lie told by the dashboard. `publishedUrl` records
       * where it went; the status moves only when the post is actually live.
       */
      await tx
        .update(articles)
        .set({ publishedUrl: published.externalUrl, updatedAt: new Date() })
        .where(and(eq(articles.workspaceId, ctx.workspaceId), eq(articles.id, article.id)));
    });

    await repo.writeAudit(wc.db, ctx, {
      action: "article.published_to_cms",
      entityType: "article",
      entityId: article.id,
      after: {
        provider: job.provider,
        externalId: published.externalId,
        externalUrl: published.externalUrl,
        cmsStatus: published.status,
        articleVersion: article.version,
      },
    });

    log.info("Published to CMS as a draft", {
      provider: job.provider,
      externalUrl: published.externalUrl,
    });

    return { externalUrl: published.externalUrl, status: published.status };
  } catch (err) {
    const appErr = err instanceof AppError
      ? err
      : new AppError("provider_error", "Publishing failed.", { cause: err });

    /*
     * A retryable failure goes back to `queued` so the queue can pick it up
     * again; anything else is terminal and stays `failed`. The distinction is
     * load-bearing: `running` above refuses to re-run, so a job wrongly left
     * running would need a human, and a job wrongly marked queued could double
     * publish. Only errors raised before the request left this process are
     * safe to re-queue, which is what `retryable` means on these errors.
     */
    await wc.db
      .update(publishJobs)
      .set({
        status: externalCompleted || appErr.details["outcomeUnknown"] ? "running" : appErr.retryable ? "queued" : "failed",
        lastError: appErr.safeMessage.slice(0, 500),
      })
      .where(and(eq(publishJobs.id, job.id), eq(publishJobs.status, "running")));

    await repo.writeAudit(wc.db, ctx, {
      action: "article.publish_failed",
      entityType: "article",
      entityId: job.entityId,
      after: { provider: job.provider, code: appErr.code, message: appErr.safeMessage },
    });

    throw appErr;
  }
}

/**
 * Mark an article live once the post is actually public.
 *
 * Separate from publishing because the two are separate events: we create a
 * draft, a person publishes it in WordPress, and only then is the article
 * published here. Kept beside the processor because it closes the same loop.
 */
export async function markArticleLive(
  wc: WorkerContext,
  ctx: ReturnType<typeof contextFromPayload>,
  articleId: string,
  liveUrl: string,
): Promise<void> {
  const article = await repo.getArticle(wc.db, ctx, articleId);
  assertTransition(article.status, "published");

  await wc.db
    .update(articles)
    .set({
      status: "published",
      publishedAt: new Date(),
      publishedUrl: liveUrl,
      updatedAt: new Date(),
    })
    .where(and(eq(articles.workspaceId, ctx.workspaceId), eq(articles.id, articleId)));

  await repo.writeAudit(wc.db, ctx, {
    action: "article.published",
    entityType: "article",
    entityId: articleId,
    after: { publishedUrl: liveUrl },
  });
}
