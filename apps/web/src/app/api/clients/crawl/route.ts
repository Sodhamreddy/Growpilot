export const dynamic = "force-dynamic";

import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { AppError, requireRole } from "@ob/core";
import { businesses, businessSources, repo } from "@ob/db";
import { JOBS, payloadFrom } from "@ob/jobs";
import { canonicalizeUrl } from "@ob/seo";
import { route, parseBody } from "@/lib/api";
import { db, getQueues } from "@/lib/services";

const requestSchema = z.object({
  businessId: z.string().uuid(),
  websiteUrl: z.string().trim().max(2048).optional(),
});

function websiteAddress(value: string): string {
  const withProtocol = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
  let parsed: URL;
  try {
    parsed = new URL(withProtocol);
  } catch {
    throw new AppError("validation_failed", "Enter a valid website address.", { retryable: false });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new AppError("validation_failed", "Use an http or https website address.", { retryable: false });
  }
  return canonicalizeUrl(parsed.toString());
}

/** Current automatic website-import status for one client. */
export const GET = route(async (ctx, req) => {
  const businessId = new URL(req.url).searchParams.get("businessId");
  if (!businessId) {
    throw new AppError("validation_failed", "Choose a client first.", { retryable: false });
  }

  await repo.getBusiness(db(), ctx, businessId);
  const rows = await db()
    .select({
      id: businessSources.id,
      url: businessSources.canonicalUrl,
      status: businessSources.crawlStatus,
      pagesDiscovered: businessSources.pagesDiscovered,
      pagesFetched: businessSources.pagesFetched,
      lastCrawledAt: businessSources.lastCrawledAt,
      lastError: businessSources.lastError,
    })
    .from(businessSources)
    .where(and(
      eq(businessSources.workspaceId, ctx.workspaceId),
      eq(businessSources.businessId, businessId),
    ))
    .orderBy(desc(businessSources.createdAt))
    .limit(1);

  return { source: rows[0] ?? null };
});

/** Start, retry, or refresh a client's automatic website import. */
export const POST = route(async (ctx, req) => {
  requireRole(ctx, "admin");
  const body = await parseBody(req, requestSchema);
  const database = db();
  const business = await repo.getBusiness(database, ctx, body.businessId);
  const rawUrl = body.websiteUrl?.trim() || business.websiteUrl?.trim();

  if (!rawUrl) {
    throw new AppError(
      "validation_failed",
      "Add the client's website address to use automatic setup.",
      { retryable: false },
    );
  }

  const canonicalUrl = websiteAddress(rawUrl);
  const attemptId = crypto.randomUUID();

  const result = await database.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(businessSources)
      .where(and(
        eq(businessSources.workspaceId, ctx.workspaceId),
        eq(businessSources.businessId, business.id),
        eq(businessSources.canonicalUrl, canonicalUrl),
      ))
      .orderBy(desc(businessSources.createdAt))
      .limit(1);

    if (existing?.crawlStatus === "running") {
      return { sourceId: existing.id, enqueue: false, status: existing.crawlStatus };
    }

    let sourceId: string;
    if (existing) {
      sourceId = existing.id;
      await tx
        .update(businessSources)
        .set({
          url: canonicalUrl,
          crawlStatus: "pending",
          pagesDiscovered: 0,
          pagesFetched: 0,
          lastError: null,
        })
        .where(eq(businessSources.id, existing.id));
    } else {
      const [created] = await tx
        .insert(businessSources)
        .values({
          workspaceId: ctx.workspaceId,
          businessId: business.id,
          url: canonicalUrl,
          canonicalUrl,
          crawlStatus: "pending",
        })
        .returning({ id: businessSources.id });
      sourceId = created!.id;
    }

    // Fresh website data must be reviewed before it can ground generated work.
    await tx
      .update(businesses)
      .set({
        websiteUrl: canonicalUrl,
        confirmedAt: null,
        confirmedBy: null,
        updatedAt: new Date(),
      })
      .where(and(
        eq(businesses.workspaceId, ctx.workspaceId),
        eq(businesses.id, business.id),
      ));

    return { sourceId, enqueue: true, status: "pending" as const };
  });

  if (result.enqueue) {
    try {
      await getQueues().enqueue(
        "crawl",
        JOBS.crawlSite,
        payloadFrom(ctx, { sourceId: result.sourceId, businessId: business.id }),
        { idempotencyKey: `crawl:${result.sourceId}:${attemptId}` },
      );
    } catch (error) {
      await database
        .update(businessSources)
        .set({
          crawlStatus: "failed",
          lastError: "We could not start the website scan. Please try again.",
        })
        .where(and(
          eq(businessSources.workspaceId, ctx.workspaceId),
          eq(businessSources.id, result.sourceId),
        ));
      throw new AppError("internal", "We could not start the website scan. Please try again.", {
        retryable: true,
        cause: error,
      });
    }
  }

  await repo.writeAudit(database, ctx, {
    action: "business.crawl_requested",
    entityType: "business",
    entityId: business.id,
    after: { websiteUrl: canonicalUrl, sourceId: result.sourceId },
  });

  return {
    ok: true,
    source: {
      id: result.sourceId,
      url: canonicalUrl,
      status: result.status,
      pagesDiscovered: 0,
      pagesFetched: 0,
      lastCrawledAt: null,
      lastError: null,
    },
  };
}, { rateLimit: { limit: 30, windowSeconds: 3600 } });
