import { and, eq, gte, inArray, sql } from "drizzle-orm";
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

  /*
   * Replace the window, do not append to it.
   *
   * Every run re-fetches the same days, so appending would multiply each
   * day's figure by the number of syncs — a chart that climbs because the job
   * ran, not because anything happened. Deleting the covered range first
   * makes a re-run idempotent.
   */
  const earliest = rows.reduce((min, row) => (row.date < min ? row.date : min), rows[0]!.date);

  await wc.db.transaction(async (tx) => {
    await tx.delete(metricSnapshots).where(and(
      eq(metricSnapshots.workspaceId, ctx.workspaceId),
      // Only the sources this job owns. A blanket delete would take Search
      // Console and GA4 rows with it, which share this table.
      inArray(metricSnapshots.source, ["facebook", "instagram"]),
      gte(metricSnapshots.date, earliest),
      // And only this client's: an agency syncs several businesses into one
      // workspace, and clearing the window for all of them would delete rows
      // this run is not about to replace.
      sql`${metricSnapshots.dimensions}->>'businessId' = ${payload.businessId}`,
    ));

    await tx.insert(metricSnapshots).values(rows.map((row) => ({
      workspaceId: ctx.workspaceId,
      source: row.source,
      metric: row.metric,
      date: row.date,
      value: row.value,
      dimensions: row.dimensions,
    })));
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
