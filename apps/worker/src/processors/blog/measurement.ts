import { and, eq, sql, gte, lte } from "drizzle-orm";
import { open } from "@ob/core";
import { integrations, metricSnapshots } from "@ob/db";
import { fetchMeasurement, measurementWindow, type MeasurementProvider, type MeasurementCredential } from "@ob/blog";
import type { WorkerContext } from "../../context.js";

export async function processMeasurement(wc: WorkerContext, payload: { workspaceId: string; integrationId: string }) {
  const [connection] = await wc.db.select().from(integrations).where(and(eq(integrations.id, payload.integrationId), eq(integrations.workspaceId, payload.workspaceId)));
  if (!connection || connection.status !== "connected" || !connection.credentialSealed) return;
  if (!["google_search_console", "google_analytics"].includes(connection.provider)) return;
  const credential = JSON.parse(open(connection.credentialSealed, wc.cfg.CREDENTIAL_ENCRYPTION_KEY)) as MeasurementCredential;
  try {
    const window = measurementWindow();
    const rows = await fetchMeasurement(connection.provider as MeasurementProvider, credential);
    await wc.db.transaction(async tx => {
      // Serialize replacement of the same client's measurement snapshot.
      const [current] = await tx.select().from(integrations).where(eq(integrations.id, connection.id)).for("update");
      if (!current || current.status !== "connected" || current.credentialSealed !== connection.credentialSealed) return;
      await tx.delete(metricSnapshots).where(and(eq(metricSnapshots.workspaceId, payload.workspaceId), eq(metricSnapshots.source, connection.provider), gte(metricSnapshots.date, window.start), lte(metricSnapshots.date, window.end),
        sql`${metricSnapshots.dimensions}->>'businessId' = ${connection.scopeKey}`));
      // Keep each insert below PostgreSQL's bind parameter limit. All batches
      // remain in this transaction so a failed batch rolls back the deletion.
      for (let offset = 0; offset < rows.length; offset += 1000) {
        await tx.insert(metricSnapshots).values(rows.slice(offset, offset + 1000).map(r => ({ ...r, workspaceId: payload.workspaceId, source: connection.provider,
          dimensions: { ...r.dimensions, businessId: connection.scopeKey } })));
      }
      await tx.update(integrations).set({ lastError: null, consecutiveFailures: 0 }).where(eq(integrations.id, connection.id));
    });
    return { rows: rows.length };
  } catch (error) {
    await wc.db.update(integrations).set({ lastError: "Measurement sync failed. Check service account access.", consecutiveFailures: sql`${integrations.consecutiveFailures} + 1` }).where(eq(integrations.id, connection.id));
    throw error;
  }
}
export async function sweepMeasurements(wc: WorkerContext) {
  const rows = await wc.db.select().from(integrations).where(eq(integrations.status, "connected"));
  for (const row of rows.filter(r => ["google_search_console", "google_analytics"].includes(r.provider))) {
    await wc.queues.enqueue("analytics", "analytics.measurement", { workspaceId: row.workspaceId, userId: "system", correlationId: `measurement-${row.id}`, integrationId: row.id },
      { idempotencyKey: `measurement:${row.id}:${new Date().toISOString().slice(0, 10)}` });
  }
}
