import { and, eq, sql } from "drizzle-orm";
import { AppError } from "@ob/core";
import { socialTopics } from "@ob/db";

/** Keep the database's full timestamp precision for concurrent edit detection. */
export const socialRevision = sql<string>`extract(epoch from ${socialTopics.updatedAt})::text`;

export function unchangedSocialTopic(workspaceId: string, topic: { id: string; revision: string }) {
  return and(eq(socialTopics.workspaceId, workspaceId), eq(socialTopics.id, topic.id),
    sql`${socialRevision} = ${topic.revision}`);
}

export function requireSocialWrite(rows: { id: string }[]): void {
  if (!rows.length) throw new AppError("conflict", "This post changed while you were working. Refresh it before trying again.", { retryable: false });
}
