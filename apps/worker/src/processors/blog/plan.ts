import { eq, and, desc } from "drizzle-orm";
import { topics, keywords, keywordClusters, articles, repo } from "@ob/db";
import { slugify } from "@ob/core";
import { buildContentPlan, type ClusterInput } from "@ob/blog";
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

  const clusters: ClusterInput[] = clusterRows.map((c) => ({
    id: c.id,
    label: c.label,
    intent: c.intent,
    terms: keywordRows
      .filter((k) => k.clusterId === c.id)
      .map((k) => ({
        id: k.id, term: k.term, relevance: k.relevance,
        opportunityScore: k.opportunityScore, volume: k.volume,
      })),
  })).filter((c) => c.terms.length > 0);

  // Keywords that never got clustered still deserve a plan slot — each becomes
  // a single-term cluster rather than being silently dropped.
  const clustered = new Set(clusters.flatMap((c) => c.terms.map((t) => t.id)));
  for (const k of keywordRows.filter((k) => !clustered.has(k.id)).slice(0, 10)) {
    clusters.push({
      id: k.clusterId ?? k.id,
      label: k.term,
      intent: k.intent,
      terms: [{
        id: k.id, term: k.term, relevance: k.relevance,
        opportunityScore: k.opportunityScore, volume: k.volume,
      }],
    });
  }

  const planned = buildContentPlan(clusters, { limit: 12, cadencePerWeek: 2 });

  // Never duplicate a topic that already exists for the same keyword.
  const existing = await wc.db
    .select({ keywordId: topics.primaryKeywordId })
    .from(topics)
    .where(and(eq(topics.workspaceId, ctx.workspaceId), eq(topics.businessId, payload.businessId)));
  const taken = new Set(existing.map((t) => t.keywordId).filter(Boolean));

  const fresh = planned.filter((p) => !taken.has(p.primaryKeywordId));
  if (fresh.length === 0) {
    log.info("Content plan already covers every keyword");
    return { topics: 0, drafted: 0 };
  }

  const inserted = await wc.db
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
    .returning();

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
  const draftCount = Math.min(payload.draftCount ?? 0, inserted.length);
  let drafted = 0;

  for (const topic of inserted.slice(0, draftCount)) {
    const [article] = await wc.db
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
