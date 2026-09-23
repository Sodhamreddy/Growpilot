import { and, eq, gte, desc, sql, inArray } from "drizzle-orm";
import type { TenantContext } from "@ob/core";
import { assertSameWorkspace, notFound } from "@ob/core";
import type { Database } from "./client.js";
import * as s from "./schema.js";

/**
 * Tenant-scoped repositories — spec §15 "Tenant isolation on every query".
 *
 * Every function takes a `TenantContext` first and injects
 * `eq(table.workspaceId, ctx.workspaceId)` into its WHERE clause. Application
 * code never builds a query against these tables directly, so the isolation
 * filter cannot be omitted by accident.
 */

// ─── Businesses ─────────────────────────────────────────────────────────────

export async function listBusinesses(db: Database, ctx: TenantContext) {
  return db.select().from(s.businesses).where(eq(s.businesses.workspaceId, ctx.workspaceId));
}

export async function getBusiness(db: Database, ctx: TenantContext, id: string) {
  const [row] = await db
    .select()
    .from(s.businesses)
    .where(and(eq(s.businesses.workspaceId, ctx.workspaceId), eq(s.businesses.id, id)))
    .limit(1);
  if (!row) throw notFound("business");
  assertSameWorkspace(ctx, row, "business");
  return row;
}

/** The workspace's primary business — the one onboarding created. */
export async function getPrimaryBusiness(db: Database, ctx: TenantContext) {
  const [workspace] = await db.select({ settings: s.workspaces.settings, completedAt: s.workspaces.onboardingCompletedAt })
    .from(s.workspaces).where(eq(s.workspaces.id, ctx.workspaceId)).limit(1);
  const selectedId = workspace?.settings.onboarding?.businessId;
  if (selectedId) {
    const [selected] = await db
      .select()
      .from(s.businesses)
      .where(and(eq(s.businesses.workspaceId, ctx.workspaceId), eq(s.businesses.id, selectedId)))
      .limit(1);
    if (selected) return selected;
  }
  const [row] = await db
    .select()
    .from(s.businesses)
    .where(eq(s.businesses.workspaceId, ctx.workspaceId))
    .orderBy(workspace?.completedAt ? s.businesses.createdAt : desc(s.businesses.createdAt))
    .limit(1);
  return row ?? null;
}

// ─── Business facts (spec §3.2) ─────────────────────────────────────────────

export async function listFacts(db: Database, ctx: TenantContext, businessId: string) {
  return db
    .select()
    .from(s.businessFacts)
    .where(
      and(
        eq(s.businessFacts.workspaceId, ctx.workspaceId),
        eq(s.businessFacts.businessId, businessId),
        sql`${s.businessFacts.supersededById} is null`,
      ),
    )
    .orderBy(desc(s.businessFacts.confidence));
}

/** Verified facts only — what generation is allowed to state as fact (§15.1). */
export async function listVerifiedFacts(db: Database, ctx: TenantContext, businessId: string) {
  return db
    .select()
    .from(s.businessFacts)
    .where(
      and(
        eq(s.businessFacts.workspaceId, ctx.workspaceId),
        eq(s.businessFacts.businessId, businessId),
        eq(s.businessFacts.verified, true),
        sql`${s.businessFacts.supersededById} is null`,
      ),
    );
}

export async function replaceFacts(
  db: Database,
  ctx: TenantContext,
  businessId: string,
  facts: Omit<typeof s.businessFacts.$inferInsert, "workspaceId" | "businessId">[],
) {
  if (facts.length === 0) return [];
  return db.transaction(async (tx) => {
    // Supersede rather than delete — provenance history is retained.
    await tx
      .update(s.businessFacts)
      .set({ supersededById: sql`${s.businessFacts.id}` })
      .where(
        and(
          eq(s.businessFacts.workspaceId, ctx.workspaceId),
          eq(s.businessFacts.businessId, businessId),
          eq(s.businessFacts.verified, false),
          sql`${s.businessFacts.supersededById} is null`,
        ),
      );
    return tx
      .insert(s.businessFacts)
      .values(facts.map((f) => ({ ...f, workspaceId: ctx.workspaceId, businessId })))
      .returning();
  });
}

// ─── Brand voice (spec §18) ─────────────────────────────────────────────────

export async function getActiveVoice(db: Database, ctx: TenantContext, businessId: string) {
  const [row] = await db
    .select()
    .from(s.brandVoices)
    .where(
      and(
        eq(s.brandVoices.workspaceId, ctx.workspaceId),
        eq(s.brandVoices.businessId, businessId),
        eq(s.brandVoices.isActive, true),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function activateVoice(db: Database, ctx: TenantContext, voiceId: string) {
  return db.transaction(async (tx) => {
    const [voice] = await tx
      .select()
      .from(s.brandVoices)
      .where(and(eq(s.brandVoices.workspaceId, ctx.workspaceId), eq(s.brandVoices.id, voiceId)))
      .limit(1);
    if (!voice) throw notFound("brand voice");

    await tx
      .update(s.brandVoices)
      .set({ isActive: false })
      .where(
        and(
          eq(s.brandVoices.workspaceId, ctx.workspaceId),
          eq(s.brandVoices.businessId, voice.businessId),
        ),
      );

    const [activated] = await tx
      .update(s.brandVoices)
      .set({ isActive: true, approvedAt: new Date(), approvedBy: ctx.userId })
      .where(and(eq(s.brandVoices.workspaceId, ctx.workspaceId), eq(s.brandVoices.id, voiceId)))
      .returning();
    return activated!;
  });
}

// ─── Articles ───────────────────────────────────────────────────────────────

export async function getArticle(db: Database, ctx: TenantContext, id: string) {
  const [row] = await db
    .select()
    .from(s.articles)
    .where(and(eq(s.articles.workspaceId, ctx.workspaceId), eq(s.articles.id, id)))
    .limit(1);
  if (!row) throw notFound("article");
  assertSameWorkspace(ctx, row, "article");
  return row;
}

export async function listArticles(
  db: Database,
  ctx: TenantContext,
  opts: {
    businessId?: string;
    status?: (typeof s.articleStatus.enumValues)[number][];
    limit?: number;
  } = {},
) {
  const conditions = [eq(s.articles.workspaceId, ctx.workspaceId)];
  if (opts.businessId) conditions.push(eq(s.articles.businessId, opts.businessId));
  if (opts.status?.length) conditions.push(inArray(s.articles.status, opts.status));
  return db
    .select()
    .from(s.articles)
    .where(and(...conditions))
    .orderBy(desc(s.articles.updatedAt))
    .limit(opts.limit ?? 50);
}

export async function listGateResults(
  db: Database,
  ctx: TenantContext,
  articleId: string,
  version: number,
) {
  return db
    .select()
    .from(s.qualityGateResults)
    .where(
      and(
        eq(s.qualityGateResults.workspaceId, ctx.workspaceId),
        eq(s.qualityGateResults.articleId, articleId),
        eq(s.qualityGateResults.articleVersion, version),
      ),
    );
}

export async function getScore(db: Database, ctx: TenantContext, articleId: string, version: number) {
  const [row] = await db
    .select()
    .from(s.articleScores)
    .where(
      and(
        eq(s.articleScores.workspaceId, ctx.workspaceId),
        eq(s.articleScores.articleId, articleId),
        eq(s.articleScores.articleVersion, version),
      ),
    )
    .limit(1);
  return row ?? null;
}

// ─── Keywords & topics ──────────────────────────────────────────────────────

export async function listKeywords(
  db: Database,
  ctx: TenantContext,
  businessId: string,
  limit = 200,
) {
  return db
    .select()
    .from(s.keywords)
    .where(and(eq(s.keywords.workspaceId, ctx.workspaceId), eq(s.keywords.businessId, businessId)))
    .orderBy(desc(s.keywords.opportunityScore))
    .limit(limit);
}

export async function listTopics(db: Database, ctx: TenantContext, businessId: string) {
  return db
    .select()
    .from(s.topics)
    .where(and(eq(s.topics.workspaceId, ctx.workspaceId), eq(s.topics.businessId, businessId)))
    .orderBy(desc(s.topics.priority));
}

// ─── AI spend (spec §5.2 per-workspace budgets) ─────────────────────────────

/**
 * Total AI spend in micro-dollars since `since`. Drives the budget guard.
 *
 * The date comparison uses `gte` rather than a raw `sql` template on purpose.
 * Interpolating a JS Date into a raw template gives the driver a parameter with
 * no column type attached, so it falls back to serialising the value as text
 * and throws `The "string" argument must be of type string ... Received an
 * instance of Date`. Because the budget guard runs before every model call,
 * that failure took down every AI request in the product — extraction, keyword
 * research, drafting — while looking like a model problem. `gte` carries the
 * column's timestamp type through to the bind.
 */
export async function aiSpendSince(db: Database, workspaceId: string, since: Date): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${s.aiJobs.costMicros}), 0)` })
    .from(s.aiJobs)
    .where(and(eq(s.aiJobs.workspaceId, workspaceId), gte(s.aiJobs.startedAt, since)));
  return Number(row?.total ?? 0);
}

// ─── Audit (spec §15) ───────────────────────────────────────────────────────

export async function writeAudit(
  db: Database,
  ctx: TenantContext,
  entry: {
    action: string;
    entityType: string;
    entityId?: string;
    before?: unknown;
    after?: unknown;
    ip?: string;
  },
) {
  await db.insert(s.auditLogs).values({
    workspaceId: ctx.workspaceId,
    actorId: ctx.userId,
    actorType: ctx.userId === "system" ? "system" : "user",
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
    correlationId: ctx.correlationId,
    ip: entry.ip ?? null,
  });
}

export async function listAudit(db: Database, ctx: TenantContext, limit = 100) {
  return db
    .select()
    .from(s.auditLogs)
    .where(eq(s.auditLogs.workspaceId, ctx.workspaceId))
    .orderBy(desc(s.auditLogs.createdAt))
    .limit(limit);
}
