import { eq, and } from "drizzle-orm";
import { keywords, keywordClusters, repo } from "@ob/db";
import { generateSeedKeywords, clusterKeywords, opportunityScore, StubKeywordProvider, type KeywordDataProvider } from "@ob/blog";
import { JOBS, payloadFrom } from "@ob/jobs";
import type { WorkerContext } from "../../context.js";
import { contextFromPayload } from "../../context.js";

/**
 * Keyword research — spec §6.1.
 *
 * Seed generation, intent classification, clustering and prioritisation all
 * run here. Volume and difficulty come from `KeywordDataProvider`; with no
 * provider credential configured this is the stub, which returns nulls rather
 * than invented numbers.
 */

export interface ResearchPayload {
  workspaceId: string;
  userId: string;
  correlationId: string;
  businessId: string;
  location?: string;
}

let provider: KeywordDataProvider = new StubKeywordProvider();

/** Swap in a real provider (SE Ranking, DataForSEO, …) at startup. */
export function setKeywordProvider(next: KeywordDataProvider): void {
  provider = next;
}

export async function processResearchKeywords(
  wc: WorkerContext,
  payload: ResearchPayload,
): Promise<{ keywords: number; clusters: number }> {
  const ctx = contextFromPayload(payload);
  const business = await repo.getBusiness(wc.db, ctx, payload.businessId);
  const facts = await repo.listFacts(wc.db, ctx, payload.businessId);

  const services = facts.filter((f) => f.key === "service").map((f) => f.value);
  const locations = payload.location ? [payload.location] : [];

  const seeds = await generateSeedKeywords(wc.gateway, ctx, {
    business,
    facts,
    services,
    locations,
  });

  if (seeds.length === 0) {
    wc.logger.warn("Keyword research produced no seeds", { businessId: payload.businessId });
    return { keywords: 0, clusters: 0 };
  }

  // Enrich with provider metrics. Missing data stays null.
  const metrics = await provider.metrics(seeds.map((s) => s.term), {
    ...(payload.location ? { location: payload.location } : {}),
  });
  const metricByTerm = new Map(metrics.map((m) => [m.term, m]));

  const enriched = seeds.map((seed) => {
    const m = metricByTerm.get(seed.term);
    return {
      ...seed,
      volume: m?.volume ?? null,
      difficulty: m?.difficulty ?? null,
      cpcMicros: m?.cpcMicros ?? null,
      opportunityScore: opportunityScore({
        relevance: seed.relevance,
        intent: seed.intent,
        volume: m?.volume ?? null,
        difficulty: m?.difficulty ?? null,
      }),
    };
  });

  const clusters = clusterKeywords(
    enriched.map((k) => ({ term: k.term, intent: k.intent, volume: k.volume })),
  );

  const location = payload.location ?? "";

  await wc.db.transaction(async (tx) => {
    // Clusters are rebuilt on every run; keywords are upserted so historical
    // rows keep their IDs and any topic still referencing them stays valid.
    await tx
      .delete(keywordClusters)
      .where(
        and(
          eq(keywordClusters.workspaceId, ctx.workspaceId),
          eq(keywordClusters.businessId, payload.businessId),
        ),
      );

    const clusterRows = clusters.length
      ? await tx
          .insert(keywordClusters)
          .values(
            clusters.map((c) => ({
              workspaceId: ctx.workspaceId,
              businessId: payload.businessId,
              label: c.label,
              intent: c.intent,
              totalVolume: c.totalVolume,
            })),
          )
          .returning()
      : [];

    const clusterIdByTerm = new Map<string, string>();
    clusters.forEach((c, i) => {
      const row = clusterRows[i];
      if (!row) return;
      for (const term of c.terms) clusterIdByTerm.set(term, row.id);
    });

    for (const k of enriched) {
      await tx
        .insert(keywords)
        .values({
          workspaceId: ctx.workspaceId,
          businessId: payload.businessId,
          term: k.term,
          intent: k.intent,
          volume: k.volume,
          difficulty: k.difficulty,
          cpcMicros: k.cpcMicros,
          relevance: k.relevance,
          location,
          clusterId: clusterIdByTerm.get(k.term) ?? null,
          opportunityScore: k.opportunityScore,
          provider: provider.name,
          refreshedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [keywords.businessId, keywords.term, keywords.location],
          set: {
            intent: k.intent,
            volume: k.volume,
            difficulty: k.difficulty,
            cpcMicros: k.cpcMicros,
            relevance: k.relevance,
            clusterId: clusterIdByTerm.get(k.term) ?? null,
            opportunityScore: k.opportunityScore,
            provider: provider.name,
            refreshedAt: new Date(),
          },
        });
    }
  });

  await repo.writeAudit(wc.db, ctx, {
    action: "keywords.researched",
    entityType: "business",
    entityId: payload.businessId,
    after: { keywords: enriched.length, clusters: clusters.length, provider: provider.name },
  });

  // Research on its own leaves the customer with a keyword list and no plan.
  // Chaining straight into planning is what makes the loop in §1 continuous.
  /*
   * Key the plan to this research run, not to the calendar day.
   *
   * A date-stamped key meant the plan could be built at most once per business
   * per day: every later run that day hit an existing job id, BullMQ returned
   * it without queueing anything, and research finished having produced a
   * keyword list and no plan — with nothing logged to say why. Scoping the key
   * to the correlation id keeps the property that actually matters (a retried
   * research job does not plan twice) and lets a genuine re-run replan.
   */
  await wc.queues.enqueue(
    "research",
    JOBS.buildContentPlan,
    payloadFrom(ctx, { businessId: payload.businessId }),
    { idempotencyKey: `plan:${payload.businessId}:${ctx.correlationId}` },
  );

  return { keywords: enriched.length, clusters: clusters.length };
}
