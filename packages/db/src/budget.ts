import { and, eq, gte, sql } from "drizzle-orm";
import { AppError } from "@ob/core";
import type { Database } from "./client.js";
import { aiJobs, aiReservations, workspaces } from "./schema.js";

export async function reserveAiBudget(db: Database, workspaceId: string, estimate: number): Promise<string> {
  if (!Number.isSafeInteger(estimate) || estimate < 0) throw new AppError("validation_failed", "Invalid AI cost estimate.");
  return db.transaction(async (tx) => {
    const [workspace] = await tx.select({ budget: workspaces.aiBudgetMicros }).from(workspaces)
      .where(eq(workspaces.id, workspaceId)).for("update");
    if (!workspace) throw new AppError("not_found", "Workspace not found.");
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const [spent] = await tx.select({ total: sql<string>`coalesce(sum(${aiJobs.costMicros}), 0)` }).from(aiJobs)
      .where(and(eq(aiJobs.workspaceId, workspaceId), gte(aiJobs.startedAt, start)));
    const [reserved] = await tx.select({ total: sql<string>`coalesce(sum(${aiReservations.costMicros}), 0)` }).from(aiReservations)
      .where(and(eq(aiReservations.workspaceId, workspaceId), gte(aiReservations.createdAt, start)));
    if (workspace.budget > 0 && Number(spent!.total) + Number(reserved!.total) + estimate > workspace.budget) {
      throw new AppError("budget_exceeded", "This request would exceed the remaining AI budget, including work in progress.", { retryable: false });
    }
    const [row] = await tx.insert(aiReservations).values({ workspaceId, costMicros: estimate }).returning({ id: aiReservations.id });
    return row!.id;
  });
}

export async function recordAiUsage(db: Database, record: typeof aiJobs.$inferInsert, reservationId?: string): Promise<void> {
  await db.transaction(async (tx) => {
    // Settlement and reservation share a lock so spent + held cannot be read between transfers.
    await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, record.workspaceId)).for("update");
    await tx.insert(aiJobs).values(record);
    if (reservationId) await tx.delete(aiReservations).where(and(eq(aiReservations.id, reservationId), eq(aiReservations.workspaceId, record.workspaceId)));
  });
}
