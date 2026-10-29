import { and, eq, isNotNull, or, sql } from "drizzle-orm";
import { JOBS } from "@ob/jobs";
import { AppError, open } from "@ob/core";
import { businesses, integrations, metricSnapshots } from "@ob/db";
import {
  fetchPageInsights, fetchInstagramInsights, fetchRecentPosts,
  fetchRecentInstagramPosts,
  GraphError, type MetaPage, type MetricRow,
} from "@ob/social";
import type { WorkerContext } from "../../context.js";
import { contextFromPayload } from "../../context.js";

/**
 * Pull Facebook and Instagram numbers into metric_snapshots.
 *
 * Runs on the analytics queue as JOBS.ingestMetrics. The job name existed from
 * the start with nothing behind it; this is what it was reserved for.
 *
 * ── Why a window rather than only yesterday ──
 *
 * Meta revises recent figures for a few days as late attribution lands, so a
 * sync that only ever fetched yesterday would leave the last week permanently
 * understated. Re-fetching a window and replacing what it covers means the
 * numbers converge on Meta's own, and a missed night repairs itself rather
 * than leaving a hole in the chart.
 *
 * ── Failure handling ──
 *
 * Not every failure means the connection is broken, and treating them alike is
 * how a customer gets told to reconnect over a rate limit. A Graph error that
 * `describeGraphError` marked permanent — an unreviewed app, a retired metric
 * — is recorded on the integration and not retried, because retrying nightly
 * would never fix it. Anything else is left for the next run.
 */

export interface InsightsPayload {
  workspaceId: string;
  userId: string;
  correlationId: string;
  /** Which client's numbers these are; stored as a dimension. */
  businessId: string;
  /** How many days to refresh. Defaults to a fortnight. */
  days?: number;
}

interface SealedCredential {
  userToken: string;
  pages: { id: string; name: string; accessToken: string; instagramId?: string }[];
}

const DEFAULT_DAYS = 14;

export async function processSocialInsights(
  wc: WorkerContext,
  payload: InsightsPayload,
): Promise<{ rows: number; sources: string[] }> {
  const ctx = contextFromPayload(payload);
  const log = wc.logger.child({ correlationId: ctx.correlationId, workspaceId: ctx.workspaceId });
  const days = payload.days ?? DEFAULT_DAYS;

  const [connection] = await wc.db
    .select()
    .from(integrations)
    .where(and(
      eq(integrations.workspaceId, ctx.workspaceId),
      eq(integrations.provider, "facebook"),
    ))
    .limit(1);

  if (!connection?.credentialSealed) {
    throw new AppError("not_found", "Facebook is not connected for this workspace.", {
      retryable: false,
    });
  }

  let credential: SealedCredential;
  try {
    credential = JSON.parse(open(connection.credentialSealed, wc.cfg.CREDENTIAL_ENCRYPTION_KEY)) as SealedCredential;
  } catch {
    // A credential that will not unseal is not a transient problem: the key
    // rotated, or the blob is corrupt. Reconnecting is the only fix.
    await markFailed(wc, ctx.workspaceId, "The stored Facebook credential could not be read. Reconnect the account.");
    throw new AppError("internal", "The stored Facebook credential could not be read.", {
      retryable: false,
    });
  }

  /*
   * Only this client's page.
   *
   * The connection can administer pages for many unrelated businesses, so
   * syncing all of them would attribute every page's audience to whichever
   * client this job happens to be for. The page is chosen per client and
   * stored on the business row; no choice means nothing to sync, which is
   * honest rather than defaulting to the first page in the list.
   */
  const [business] = await wc.db
    .select({ metaPageId: businesses.metaPageId, name: businesses.name })
    .from(businesses)
    .where(and(
      eq(businesses.workspaceId, ctx.workspaceId),
      eq(businesses.id, payload.businessId),
    ))
    .limit(1);

  if (!business?.metaPageId) {
    log.info("No Facebook Page chosen for this client", { businessId: payload.businessId });
    return { rows: 0, sources: [] };
  }

  const selected = credential.pages.filter((p) => p.id === business.metaPageId);
  if (selected.length === 0) {
    // The stored choice is no longer reachable with this token — the page was
    // removed from the account, or someone reconnected with a different one.
    await markFailed(wc, ctx.workspaceId,
      `The Facebook Page saved for ${business.name} is not reachable with the current connection. Choose it again.`);
    return { rows: 0, sources: [] };
  }

  const dimensions = { businessId: payload.businessId };
  const rows: MetricRow[] = [];
  const sources = new Set<string>();

  for (const raw of selected) {
    const page: MetaPage = {
      id: raw.id,
      name: raw.name,
      accessToken: raw.accessToken,
      ...(raw.instagramId ? { instagramId: raw.instagramId } : {}),
    };

    try {
      const pageRows = await fetchPageInsights(page, days, dimensions);
      rows.push(...pageRows);
      if (pageRows.length > 0) sources.add("facebook");

      /*
       * Post-level numbers are best-effort.
       *
       * They fill a table that is useful and not load-bearing, and they are
       * the call most likely to be throttled because it fans out per post.
       * Losing them must not cost the account totals already fetched above.
       */
      try {
        rows.push(...await fetchRecentPosts(page, 25, dimensions));
      } catch (err) {
        log.warn("Post insights skipped", { page: page.id, error: String(err) });
      }

      if (page.instagramId) {
        const igRows = await fetchInstagramInsights(page, days, dimensions);
        rows.push(...igRows);
        if (igRows.length > 0) sources.add("instagram");
        try {
          rows.push(...await fetchRecentInstagramPosts(page, 25, dimensions));
        } catch (err) {
          log.warn("Instagram post insights skipped", { page: page.id, error: String(err) });
        }
      }
    } catch (err) {
      if (err instanceof GraphError && err.permanent) {
        await markFailed(wc, ctx.workspaceId, err.message);
        throw new AppError("internal", err.message, { retryable: false });
      }
      throw err;
    }
  }

  if (rows.length === 0) {
    log.info("No insight rows returned", { days });
    return { rows: 0, sources: [] };
  }

  // Replace only the exact points returned. Post dates can be much older than
  // daily insight dates, and an omitted/failed metric must not erase history.
  await wc.db.transaction(async (tx) => {
    const [current] = await tx.select({ metaPageId: businesses.metaPageId }).from(businesses)
      .where(and(eq(businesses.workspaceId, ctx.workspaceId), eq(businesses.id, payload.businessId)))
      .for("update");
    if (current?.metaPageId !== business.metaPageId) {
      throw new AppError("conflict", "The selected Facebook Page changed during sync. Refresh its insights again.", { retryable: false });
    }
    for (let offset = 0; offset < rows.length; offset += 100) {
      const batch = rows.slice(offset, offset + 100);
      await tx.delete(metricSnapshots).where(and(
        eq(metricSnapshots.workspaceId, ctx.workspaceId),
        sql`${metricSnapshots.dimensions}->>'businessId' = ${payload.businessId}`,
        or(...batch.map((row) => and(
          eq(metricSnapshots.source, row.source), eq(metricSnapshots.metric, row.metric),
          eq(metricSnapshots.date, row.date),
          row.dimensions.postId
            ? sql`${metricSnapshots.dimensions}->>'postId' = ${row.dimensions.postId}`
            : sql`${metricSnapshots.dimensions}->>'postId' IS NULL`,
        ))),
      ));
      await tx.insert(metricSnapshots).values(batch.map((row) => ({
        workspaceId: ctx.workspaceId, source: row.source, metric: row.metric,
        date: row.date, value: row.value, dimensions: row.dimensions,
      })));
    }
  });

  log.info("Social insights ingested", { rows: rows.length, sources: [...sources] });
  return { rows: rows.length, sources: [...sources] };
}

/** Record why a connection stopped working, so the UI can explain it. */
async function markFailed(wc: WorkerContext, workspaceId: string, message: string): Promise<void> {
  for (const provider of ["facebook", "instagram"]) {
    await wc.db
      .update(integrations)
      .set({ status: "error", lastError: message })
      .where(and(
        eq(integrations.workspaceId, workspaceId),
        eq(integrations.provider, provider),
      ));
  }
}

/** Refresh all selected Pages daily; individual failures remain isolated jobs. */
export async function processSocialInsightsSweep(wc: WorkerContext) {
  const rows = await wc.db.select({ id: businesses.id, workspaceId: businesses.workspaceId })
    .from(businesses).innerJoin(integrations, and(
      eq(integrations.workspaceId, businesses.workspaceId), eq(integrations.provider, "facebook"),
      eq(integrations.status, "connected"),
    )).where(isNotNull(businesses.metaPageId));
  const window = Math.floor(Date.now() / 86_400_000);
  for (const b of rows) {
    await wc.queues.enqueue("analytics", JOBS.ingestMetrics, {
      workspaceId: b.workspaceId, businessId: b.id, userId: "system",
      correlationId: `meta-${b.id.slice(0, 8)}-${window}`,
    }, { idempotencyKey: `meta-insights:${b.id}:${window}` });
  }
  return { queued: rows.length };
}
