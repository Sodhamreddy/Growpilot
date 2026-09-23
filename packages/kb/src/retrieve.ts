import { and, eq, sql } from "drizzle-orm";
import type { TenantContext } from "@ob/core";
import type { Database } from "@ob/db";
import { knowledgeChunks } from "@ob/db";
import type { Gateway } from "@ob/ai";

/**
 * Retrieval — spec §4.1.
 *
 * "Retrieve only relevant business facts and evidence." Every query is bounded
 * by BOTH workspace and business, so one customer's corpus can never surface in
 * another's generation (spec §15 "Separate customer RAG data").
 */

export interface RetrievedChunk {
  id: string;
  content: string;
  heading: string | null;
  sourceUrl: string | null;
  kind: string;
  /** Cosine similarity, 0–1. Higher is closer. */
  similarity: number;
}

export interface RetrieveOptions {
  businessId: string;
  query: string;
  limit?: number;
  /** Drop anything below this similarity rather than padding with noise. */
  minSimilarity?: number;
  kinds?: string[];
}

export async function retrieve(
  db: Database,
  gateway: Gateway,
  ctx: TenantContext,
  opts: RetrieveOptions,
): Promise<RetrievedChunk[]> {
  const limit = opts.limit ?? 8;
  const minSimilarity = opts.minSimilarity ?? 0.15;

  const { vectors } = await gateway.embed(ctx, { texts: [opts.query] });
  const queryVector = vectors[0];
  if (!queryVector) return [];

  const literal = toVectorLiteral(queryVector);

  const conditions = [
    eq(knowledgeChunks.workspaceId, ctx.workspaceId),
    eq(knowledgeChunks.businessId, opts.businessId),
    sql`${knowledgeChunks.embedding} is not null`,
  ];
  if (opts.kinds?.length) {
    conditions.push(sql`${knowledgeChunks.kind} = any(${opts.kinds})`);
  }

  // `<=>` is pgvector's cosine distance; similarity is 1 - distance.
  const rows = await db
    .select({
      id: knowledgeChunks.id,
      content: knowledgeChunks.content,
      heading: knowledgeChunks.heading,
      sourceUrl: knowledgeChunks.sourceUrl,
      kind: knowledgeChunks.kind,
      distance: sql<number>`${knowledgeChunks.embedding} <=> ${literal}::vector`,
    })
    .from(knowledgeChunks)
    .where(and(...conditions))
    .orderBy(sql`${knowledgeChunks.embedding} <=> ${literal}::vector`)
    .limit(limit * 2);

  return rows
    .map((r) => ({
      id: r.id,
      content: r.content,
      heading: r.heading,
      sourceUrl: r.sourceUrl,
      kind: r.kind,
      similarity: 1 - Number(r.distance),
    }))
    .filter((r) => r.similarity >= minSimilarity)
    .slice(0, limit);
}

/** Index chunks for a business. Embeddings are computed in batches. */
export async function indexChunks(
  db: Database,
  gateway: Gateway,
  ctx: TenantContext,
  businessId: string,
  chunks: {
    kind: string;
    refId?: string;
    sourceUrl?: string;
    heading?: string | null;
    content: string;
    tokenCount: number;
  }[],
  batchSize = 64,
): Promise<number> {
  let inserted = 0;

  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const { vectors } = await gateway.embed(ctx, { texts: batch.map((c) => c.content) });

    const values = batch.map((c, j) => ({
      workspaceId: ctx.workspaceId,
      businessId,
      kind: c.kind,
      refId: c.refId ?? null,
      sourceUrl: c.sourceUrl ?? null,
      heading: c.heading ?? null,
      content: c.content,
      tokenCount: c.tokenCount,
      embedding: vectors[j] ?? null,
    }));

    await db.insert(knowledgeChunks).values(values);
    inserted += values.length;
  }

  return inserted;
}

/** Drop a business's chunks of a given kind before a re-index. */
export async function clearChunks(
  db: Database,
  ctx: TenantContext,
  businessId: string,
  kind?: string,
): Promise<void> {
  const conditions = [
    eq(knowledgeChunks.workspaceId, ctx.workspaceId),
    eq(knowledgeChunks.businessId, businessId),
  ];
  if (kind) conditions.push(eq(knowledgeChunks.kind, kind));
  await db.delete(knowledgeChunks).where(and(...conditions));
}

/** pgvector accepts a bracketed, comma-separated literal. */
function toVectorLiteral(vector: number[]): string {
  return `[${vector.map((v) => (Number.isFinite(v) ? v.toFixed(6) : "0")).join(",")}]`;
}
