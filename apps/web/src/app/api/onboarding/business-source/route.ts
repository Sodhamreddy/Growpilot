export const dynamic = "force-dynamic";

import { z } from "zod";
import { eq, desc, and } from "drizzle-orm";
import { AppError, requireRole } from "@ob/core";
import { businesses, businessSources, businessLocations, businessFacts, workspaces, repo } from "@ob/db";
import { canonicalizeUrl } from "@ob/seo";
import { JOBS, payloadFrom } from "@ob/jobs";
import { route, parseBody } from "@/lib/api";
import { db, getQueues } from "@/lib/services";

const schema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("website"),
    url: z.string().trim().min(1, "Enter your website address.")
      .transform((value) => /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`)
      .pipe(z.string().url("Enter a valid website address.").refine((value) =>
        ["https:", "http:"].includes(new URL(value).protocol), "Use an http or https website address.")),
  }),
  z.object({
    source: z.literal("manual"),
    name: z.string().trim().min(1, "Enter the business name.").max(200),
    offer: z.string().trim().min(1, "Describe what the business offers.").max(2000),
    audience: z.string().trim().min(1, "Describe who it serves.").max(1000),
    serviceArea: z.string().trim().max(500).optional(),
  }),
]);

export const POST = route(async (ctx, req) => {
  requireRole(ctx, "admin");
  const body = await parseBody(req, schema);
  const database = db();
  const canonicalUrl = body.source === "website" ? canonicalizeUrl(body.url) : null;
  const crawlAttemptId = crypto.randomUUID();

  // Serialize retries for this workspace. A retry reuses the same source/job.
  const result = await database.transaction(async (tx) => {
    const [ws] = await tx.select().from(workspaces)
      .where(eq(workspaces.id, ctx.workspaceId)).for("update").limit(1);
    if (!ws) throw new AppError("not_found", "Workspace not found.");
    if (ws.onboardingCompletedAt) throw new AppError("validation_failed", "Setup is already complete. Edit your business from Settings.");
    const previous = ws.settings.onboarding ?? {};
    const sameSource = previous.businessId && previous.sourceMode === body.source &&
      (body.source === "manual" || previous.sourceUrl === canonicalUrl);
    let businessId = sameSource ? previous.businessId : undefined;
    if (businessId) {
      const [owned] = await tx.select({ id: businesses.id }).from(businesses)
        .where(and(eq(businesses.id, businessId), eq(businesses.workspaceId, ctx.workspaceId))).limit(1);
      businessId = owned?.id;
    }
    if (!businessId) {
      const [business] = await tx.insert(businesses).values({
        workspaceId: ctx.workspaceId,
        name: body.source === "manual" ? body.name : new URL(canonicalUrl!).hostname,
        websiteUrl: canonicalUrl,
      }).returning();
      businessId = business!.id;
    }
    let sourceId: string | undefined;
    let shouldEnqueue = false;
    if (body.source === "manual") {
      /*
       * Independent statements go together.
       *
       * Every statement inside a transaction is a round trip, and against a
       * managed database in another region that is ~260ms each — so the shape
       * of this block, not the work in it, is what the customer waits for.
       * The profile update and the two deletes touch different tables and do
       * not read each other, so they are grouped; only the inserts that must
       * land after their deletes stay sequential.
       *
       * Measured honestly, this saves very little today: postgres.js issues
       * statements one at a time on a transaction's single connection, so the
       * grouping does not overlap the round trips (2247ms → 2158ms). It is kept
       * because it states the real dependencies rather than implying an order
       * that does not exist, and a driver that pipelines would benefit. The
       * latency itself is inherent to a database in another region.
       */
      await Promise.all([
        tx.update(businesses).set({ name: body.name, description: body.offer, audience: body.audience,
          confirmedAt: null, confirmedBy: null, updatedAt: new Date() })
          .where(and(eq(businesses.id, businessId), eq(businesses.workspaceId, ctx.workspaceId))),
        tx.delete(businessFacts).where(and(eq(businessFacts.workspaceId, ctx.workspaceId), eq(businessFacts.businessId, businessId))),
        tx.delete(businessLocations).where(and(eq(businessLocations.workspaceId, ctx.workspaceId), eq(businessLocations.businessId, businessId))),
      ]);

      await Promise.all([
        tx.insert(businessFacts).values([
          { key: "service", value: body.offer }, { key: "audience", value: body.audience },
          ...(body.serviceArea ? [{ key: "service_area", value: body.serviceArea }] : []),
        ].map((fact) => ({ ...fact, workspaceId: ctx.workspaceId, businessId: businessId!, confidence: 1, verified: false }))),
        ...(body.serviceArea
          ? [tx.insert(businessLocations).values({
              workspaceId: ctx.workspaceId, businessId, label: body.serviceArea, confidence: 1,
            })]
          : []),
      ]);
    } else {
      const [existing] = await tx.select().from(businessSources)
        .where(and(eq(businessSources.workspaceId, ctx.workspaceId), eq(businessSources.businessId, businessId), eq(businessSources.canonicalUrl, canonicalUrl!)))
        .orderBy(desc(businessSources.createdAt)).limit(1);
      /*
       * Reuse the row; never insert a second one for the same URL.
       *
       * `business_sources` is unique on (business_id, canonical_url), so the
       * previous "insert a fresh row when the last attempt failed" path could
       * only ever succeed the first time. Retrying a blocked or failed crawl —
       * which is exactly what someone does after a 403 — hit the constraint and
       * surfaced as "Something went wrong on our side", a generic 500 for an
       * entirely expected action.
       *
       * Resetting the existing row is also the more honest model: it is the
       * same source being tried again, not a new one, and keeping one row per
       * URL means the crawl history stays readable.
       */
      if (existing) {
        sourceId = existing.id;
        if (["failed", "blocked"].includes(existing.crawlStatus)) {
          shouldEnqueue = true;
          await tx
            .update(businessSources)
            .set({
              crawlStatus: "pending",
              lastError: null,
              url: body.url,
              pagesDiscovered: 0,
              pagesFetched: 0,
            })
            .where(eq(businessSources.id, existing.id));
        }
      } else {
        const [source] = await tx.insert(businessSources).values({ workspaceId: ctx.workspaceId,
          businessId, url: body.url, canonicalUrl: canonicalUrl!, crawlStatus: "pending" }).returning();
        sourceId = source!.id;
        shouldEnqueue = true;
      }
    }
    // Changing the source invalidates its review, while keeping the user's setup choices.
    const completedSteps = (previous.completedSteps ?? []).filter((step) => !["source", "detecting", "confirm", "colors", "pillars"].includes(step));
    completedSteps.push("source");
    if (body.source === "manual") completedSteps.push("detecting");
    await tx.update(workspaces).set({
      onboardingStep: body.source === "manual" ? "confirm" : "detecting",
      settings: { ...ws.settings, onboarding: { ...previous, businessId, sourceMode: body.source,
        sourceUrl: canonicalUrl ?? "", completedSteps,
        ...(body.source === "manual" ? { manual: { name: body.name, offer: body.offer, audience: body.audience, serviceArea: body.serviceArea ?? "" } } : {}),
      } }, updatedAt: new Date(),
    }).where(eq(workspaces.id, ctx.workspaceId));
    return { businessId, sourceId, shouldEnqueue };
  });
  if (result.sourceId && result.shouldEnqueue) {
    try {
      await getQueues().enqueue("crawl", JOBS.crawlSite,
        payloadFrom(ctx, { sourceId: result.sourceId, businessId: result.businessId }),
        { idempotencyKey: `crawl:${result.sourceId}:${crawlAttemptId}` });
    } catch (error) {
      // Leave the row retryable. A second submit will reset it and create a
      // fresh attempt instead of finding a permanent "pending" source with no
      // job behind it.
      await database.update(businessSources).set({
        crawlStatus: "failed",
        lastError: "We could not start the website scan. Please try again.",
      }).where(and(
        eq(businessSources.workspaceId, ctx.workspaceId),
        eq(businessSources.id, result.sourceId),
      ));
      throw error;
    }
  }
  return { businessId: result.businessId, sourceId: result.sourceId,
    mode: body.source, nextStep: body.source === "manual" ? "confirm" : "detecting" };
}, { rateLimit: { limit: 30, windowSeconds: 3600 } });

/*
 * Polled by the onboarding screen every few seconds.
 *
 * Two round trips, deliberately. Resolving the business first is not
 * incidental: `getPrimaryBusiness` honours the workspace's *selected* business
 * from onboarding settings, so switching from a website to a manual profile
 * correctly reports no sources. Collapsing this into one join over the
 * workspace returns the newest source belonging to any business — which
 * resurrects the abandoned website crawl on the manual path.
 *
 * The cost is one extra round trip on a polled endpoint. That is worth paying
 * for an answer that is right.
 */
export const GET = route(async (ctx) => {
  const database = db();
  const business = await repo.getPrimaryBusiness(database, ctx);
  if (!business) return { sources: [] };

  const rows = await database
    .select({
      id: businessSources.id,
      businessId: businessSources.businessId,
      url: businessSources.canonicalUrl,
      status: businessSources.crawlStatus,
      pagesDiscovered: businessSources.pagesDiscovered,
      pagesFetched: businessSources.pagesFetched,
      lastError: businessSources.lastError,
    })
    .from(businessSources)
    .where(and(
      eq(businessSources.workspaceId, ctx.workspaceId),
      eq(businessSources.businessId, business.id),
    ))
    .orderBy(desc(businessSources.createdAt))
    .limit(1);

  return { sources: rows };
});
