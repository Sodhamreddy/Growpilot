import { eq, and, desc, asc, sql, gte, inArray } from "drizzle-orm";
import { topics, keywords, keywordClusters, articles, metricSnapshots, repo } from "@ob/db";
import { slugify } from "@ob/core";
import { buildContentPlan, searchPerformanceBoost, measurementWindow, type ClusterInput } from "@ob/blog";
import { JOBS, payloadFrom } from "@ob/jobs";
import type { WorkerContext } from "../../context.js";
import { contextFromPayload } from "../../context.js";

/**
 * Content plan construction — spec §6.2.
 *
 * Runs automatically after keyword research so the customer returns to a plan
 * rather than an empty calendar. Then drafts the highest-priority topics,
 * which is where the loop in §1 ("planning → AI generation → quality gates →
 * approval") actually starts producing something a person can review.
 */

export interface PlanPayload {
  workspaceId: string;
  userId: string;
  correlationId: string;
  businessId: string;
  /** How many of the planned topics to draft immediately. */
  draftCount?: number;
}

export async function processBuildContentPlan(
  wc: WorkerContext,
  payload: PlanPayload,
): Promise<{ topics: number; drafted: number }> {
  const ctx = contextFromPayload(payload);
  const log = wc.logger.child({ correlationId: ctx.correlationId, workspaceId: ctx.workspaceId });

  const clusterRows = await wc.db
    .select()
    .from(keywordClusters)
    .where(and(
      eq(keywordClusters.workspaceId, ctx.workspaceId),
      eq(keywordClusters.businessId, payload.businessId),
    ));

  const keywordRows = await wc.db
    .select({
      id: keywords.id, term: keywords.term, clusterId: keywords.clusterId,
      opportunityScore: keywords.opportunityScore, volume: keywords.volume,
      relevance: keywords.relevance, intent: keywords.intent,
    })
    .from(keywords)
    .where(and(
      eq(keywords.workspaceId, ctx.workspaceId),
      eq(keywords.businessId, payload.businessId),
    ))
    .orderBy(desc(keywords.opportunityScore));

  if (keywordRows.length === 0) {
    log.warn("No keywords to plan from");
    return { topics: 0, drafted: 0 };
  }

  const performance = await wc.db.select({ query: sql<string>`${metricSnapshots.dimensions}->>'query'`, metric: metricSnapshots.metric, total: sql<string>`sum(${metricSnapshots.value})` })
    .from(metricSnapshots).where(and(eq(metricSnapshots.workspaceId, ctx.workspaceId), eq(metricSnapshots.source, "google_search_console"),
      sql`${metricSnapshots.dimensions}->>'businessId' = ${payload.businessId}`, gte(metricSnapshots.date, measurementWindow().start),
      sql`${metricSnapshots.metric} in ('search_query_clicks', 'search_query_impressions')`)).groupBy(sql`${metricSnapshots.dimensions}->>'query'`, metricSnapshots.metric);
  const observed = new Map<string, { impressions: number; clicks: number }>();
  for (const row of performance) {
    const term = row.query.trim().toLowerCase();
    const value = observed.get(term) ?? { impressions: 0, clicks: 0 };
    value[row.metric === "search_query_clicks" ? "clicks" : "impressions"] += Number(row.total);
    observed.set(term, value);
  }
  const boost = (term: string) => { const p = observed.get(term.trim().toLowerCase()); return p ? searchPerformanceBoost(p.impressions, p.clicks) : 0; };

  const clusters: ClusterInput[] = clusterRows.map((c) => ({
    id: c.id,
    label: c.label,
    intent: c.intent,
    terms: keywordRows
      .filter((k) => k.clusterId === c.id)
      .map((k) => ({
        id: k.id, term: k.term, relevance: k.relevance,
        opportunityScore: k.opportunityScore, volume: k.volume, performanceBoost: boost(k.term),
      })),
  })).filter((c) => c.terms.length > 0);

  // Keywords that never got clustered still deserve a plan slot — each becomes
  // a single-term cluster rather than being silently dropped.
  const clustered = new Set(clusters.flatMap((c) => c.terms.map((t) => t.id)));
  for (const k of keywordRows.filter((k) => !clustered.has(k.id))) {
    clusters.push({
      id: k.clusterId ?? k.id,
      label: k.term,
      intent: k.intent,
      terms: [{
        id: k.id, term: k.term, relevance: k.relevance,
        opportunityScore: k.opportunityScore, volume: k.volume, performanceBoost: boost(k.term),
      }],
    });
  }

  // Never duplicate a topic that already exists for the same keyword.
  const existing = await wc.db
    .select({ keywordId: topics.primaryKeywordId })
    .from(topics)
    .where(and(eq(topics.workspaceId, ctx.workspaceId), eq(topics.businessId, payload.businessId)));
  const taken = new Set(existing.map((t) => t.keywordId).filter(Boolean));

  const fresh = buildContentPlan(clusters, { limit: 12, cadencePerWeek: 2, excludedKeywordIds: taken as Set<string> });

  const inserted = fresh.length ? await wc.db
    .insert(topics)
    .values(fresh.map((p) => ({
      workspaceId: ctx.workspaceId,
      businessId: payload.businessId,
      title: p.title,
      primaryKeywordId: p.primaryKeywordId,
      secondaryTerms: p.secondaryTerms,
      intent: p.intent,
      priority: p.priority,
      publishDate: p.publishDate,
      status: "planned" as const,
    })))
    .returning() : [];

  await repo.writeAudit(wc.db, ctx, {
    action: "content_plan.built",
    entityType: "business",
    entityId: payload.businessId,
    after: { topics: inserted.length, clusters: clusters.length },
  });

  /*
   * Nothing is drafted unless the caller asks for it.
   *
   * This used to write the top three automatically, on the reasoning that a
   * customer returning to an empty page has nothing to react to. In practice
   * it produced three articles nobody chose, on topics nobody read, each
   * costing a model call and arriving already needing changes.
   *
   * The scheduled weekly run still passes a count, because that is a choice
   * somebody made once in settings. A plan built from keyword research is not.
   */
  const draftCount = Math.max(0, Math.min(Math.floor(payload.draftCount ?? 0), 12));
  // Include previously planned topics: research creates a plan without drafts.
  // Draft articles left by an interrupted enqueue are safe to enqueue again.
  const candidates = draftCount ? await wc.db.select().from(topics).where(and(
    eq(topics.workspaceId, ctx.workspaceId), eq(topics.businessId, payload.businessId),
    inArray(topics.status, ["planned", "briefed"]),
  )).orderBy(desc(topics.priority), asc(topics.createdAt)) : [];
  let drafted = 0;

  for (const topic of candidates) {
    if (drafted >= draftCount) break;
    const article = await wc.db.transaction(async (tx) => {
      await tx.select({ id: topics.id }).from(topics).where(eq(topics.id, topic.id)).for("update");
      const [existingArticle] = await tx.select().from(articles).where(and(
        eq(articles.workspaceId, ctx.workspaceId), eq(articles.topicId, topic.id),
      )).limit(1);
      if (existingArticle) return existingArticle.status === "draft" && !existingArticle.bodyMarkdown ? existingArticle : null;
      const [created] = await tx
      .insert(articles)
      .values({
        workspaceId: ctx.workspaceId,
        businessId: payload.businessId,
        topicId: topic.id,
        title: topic.title,
        slug: `${slugify(topic.title) || "article"}-${Date.now().toString(36)}-${drafted}`,
        status: "draft",
      })
      .returning();
      return created;
    });
    if (!article) continue;

    await wc.queues.enqueue(
      "ai",
      JOBS.generateArticle,
      payloadFrom(ctx, { articleId: article!.id }),
      { idempotencyKey: `generate:${article!.id}:v1` },
    );
    drafted++;
  }

  log.info("Content plan built", { topics: inserted.length, drafted });
  return { topics: inserted.length, drafted };
}
