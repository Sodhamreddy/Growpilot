export const dynamic = "force-dynamic";

import { z } from "zod";
import { eq, and, desc, count as countOf } from "drizzle-orm";
import { AppError, requireRole } from "@ob/core";
// URL canonicalisation lives with the crawler, which owns what a
// crawlable address looks like.
import { canonicalizeUrl } from "@ob/seo";
import { starterInstructions } from "@ob/pipeline";
import { businesses, businessSources, workspaces, workspaceMembers, articles, repo } from "@ob/db";
import { JOBS, payloadFrom } from "@ob/jobs";
import { route, parseBody } from "@/lib/api";
import { db, getQueues } from "@/lib/services";

/**
 * Clients — the businesses this workspace manages.
 *
 * An agency runs several businesses from one login. They live in the same
 * workspace, sharing the AI budget, the member list and the publishing policy,
 * because those are the agency's, not the client's. Everything a client owns —
 * its crawl, its facts, its voice, its keywords, its articles — is scoped by
 * `businessId` and never bleeds across.
 *
 * GET    list them, with enough state to tell which need attention
 * POST   add one, and start its crawl
 * PATCH  switch which one the dashboard is showing
 */

/*
 * What a new client can arrive with.
 *
 * Only the name is required. Everything else is optional because the crawl
 * fills most of it, and a form that demands eight fields before it will accept
 * a website is slower than letting the scan do the work.
 *
 * They are accepted here rather than only in Settings for the case the crawl
 * cannot cover: a business whose site is thin, blocked, or not built yet. What
 * a person types is treated as fact and is never overwritten by the crawl.
 */
const createSchema = z.object({
  name: z.string().trim().min(1, "Give the client a name.").max(200),
  websiteUrl: z.string().trim().optional(),
  industry: z.string().trim().max(160).optional(),
  audience: z.string().trim().max(600).optional(),
  description: z.string().trim().max(2000).optional(),
  usp: z.string().trim().max(600).optional(),
  primaryCta: z.string().trim().max(160).optional(),
  gmbName: z.string().trim().max(200).optional(),
});

/** "" and "  " mean "not given", not "set it to empty". */
const given = (v: string | undefined): string | null => {
  const t = v?.trim();
  return t ? t : null;
};

const selectSchema = z.object({
  businessId: z.string().uuid(),
});

export const GET = route(async (ctx) => {
  const database = db();

  const rows = await database
    .select({
      id: businesses.id,
      name: businesses.name,
      industry: businesses.industry,
      websiteUrl: businesses.websiteUrl,
      logoUrl: businesses.logoUrl,
      confirmedAt: businesses.confirmedAt,
      createdAt: businesses.createdAt,
    })
    .from(businesses)
    .where(eq(businesses.workspaceId, ctx.workspaceId))
    .orderBy(desc(businesses.createdAt));

  const [ws] = await database
    .select({ settings: workspaces.settings })
    .from(workspaces)
    .where(eq(workspaces.id, ctx.workspaceId))
    .limit(1);

  // As in the dashboard layout: a stored id that no longer names a client is
  // not a selection, and `??` would not catch it because it is not null.
  const storedId = (await repo.getPrimaryBusiness(database, ctx))?.id;
  return {
    clients: rows,
    selectedId: rows.find((r) => r.id === storedId)?.id ?? rows[0]?.id ?? null,
  };
});

export const POST = route(async (ctx, req) => {
  requireRole(ctx, "admin");
  const body = await parseBody(req, createSchema);
  const database = db();

  const canonicalUrl = body.websiteUrl?.trim()
    ? canonicalizeUrl(
        /^[a-z][a-z0-9+.-]*:/i.test(body.websiteUrl.trim())
          ? body.websiteUrl.trim()
          : `https://${body.websiteUrl.trim()}`,
      )
    : null;

  const result = await database.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: businesses.id })
      .from(businesses)
      .where(and(
        eq(businesses.workspaceId, ctx.workspaceId),
        eq(businesses.name, body.name.trim()),
      ))
      .limit(1);

    if (existing) {
      throw new AppError("conflict", "A client with that name already exists.", {
        retryable: false,
      });
    }

    /*
     * Starter instructions, written from whatever the profile already has.
     *
     * Six empty prompt boxes are not neutral: generation falls back to the
     * built-in prompts, which know nothing about this client, and the first
     * batch of topics comes out generic. Worse, the person is asked to fill
     * six boxes before they have seen any output to react to.
     *
     * With a website this is thin at first and the crawl fills it out (see
     * the same call in the extract processor). Without one, what was typed
     * into the add form is all there is, and it is still better than nothing.
     */
    const prompts = starterInstructions({
      name: body.name.trim(),
      industry: given(body.industry),
      audience: given(body.audience),
      description: given(body.description),
      usp: given(body.usp),
      primaryCta: given(body.primaryCta),
      services: [],
      locations: [],
    });

    const [business] = await tx
      .insert(businesses)
      .values({
        workspaceId: ctx.workspaceId,
        name: body.name.trim(),
        websiteUrl: canonicalUrl,
        industry: given(body.industry),
        audience: given(body.audience),
        description: given(body.description),
        usp: given(body.usp),
        primaryCta: given(body.primaryCta),
        gmbName: given(body.gmbName),
        prompts,
      })
      .returning();

    let sourceId: string | undefined;
    if (canonicalUrl) {
      const [source] = await tx
        .insert(businessSources)
        .values({
          workspaceId: ctx.workspaceId,
          businessId: business!.id,
          url: canonicalUrl,
          canonicalUrl,
          crawlStatus: "pending",
        })
        .returning();
      sourceId = source!.id;
    }

    /*
     * Adding a client selects it.
     *
     * Somebody who just typed a client's name is looking at that client next,
     * and leaving the dashboard on the previous one would make the new row
     * appear to have done nothing.
     */
    await tx.update(workspaceMembers).set({ selectedBusinessId: business!.id })
      .where(and(eq(workspaceMembers.workspaceId, ctx.workspaceId), eq(workspaceMembers.userId, ctx.userId)));

    return { businessId: business!.id, sourceId };
  });

  // The crawl runs outside the transaction: a queued job must never be visible
  // before the row it refers to is committed.
  let crawling = Boolean(result.sourceId);
  let crawlStatus: "pending" | "failed" | "manual" = result.sourceId ? "pending" : "manual";
  let warning: string | null = null;
  if (result.sourceId) {
    try {
      await getQueues().enqueue(
        "crawl",
        JOBS.crawlSite,
        payloadFrom(ctx, { sourceId: result.sourceId, businessId: result.businessId }),
        { idempotencyKey: `crawl:${result.sourceId}` },
      );
    } catch {
      crawling = false;
      crawlStatus = "failed";
      warning = "The client was added, but the website scan could not start. Open Business info to retry.";
      await database
        .update(businessSources)
        .set({ crawlStatus: "failed", lastError: warning })
        .where(and(
          eq(businessSources.workspaceId, ctx.workspaceId),
          eq(businessSources.id, result.sourceId),
        ));
    }
  }

  await repo.writeAudit(database, ctx, {
    action: "client.added",
    entityType: "business",
    entityId: result.businessId,
    after: {
      name: body.name.trim(),
      websiteUrl: canonicalUrl,
      // Which profile fields arrived typed rather than crawled. Worth knowing
      // later when a value disagrees with the website.
      supplied: (["industry", "audience", "description", "usp", "primaryCta", "gmbName"] as const)
        .filter((k) => given(body[k])),
    },
  });

  return {
    ok: true,
    businessId: result.businessId,
    crawling,
    crawlStatus,
    warning,
  };
});

export const PATCH = route(async (ctx, req) => {
  const body = await parseBody(req, selectSchema);
  const database = db();

  // Confirms the business belongs to this workspace before selecting it.
  await repo.getBusiness(database, ctx, body.businessId);

  await database.update(workspaceMembers).set({ selectedBusinessId: body.businessId })
    .where(and(eq(workspaceMembers.workspaceId, ctx.workspaceId), eq(workspaceMembers.userId, ctx.userId)));

  return { ok: true, selectedId: body.businessId };
});

export const DELETE = route(async (ctx, req) => {
  requireRole(ctx, "owner");
  const body = await parseBody(req, selectSchema);
  const database = db();

  const business = await repo.getBusiness(database, ctx, body.businessId);

  /*
   * Count and delete in one transaction.
   *
   * These were two statements with no transaction between them, so a client
   * that had no articles when counted could have its first one committed by a
   * worker before the delete ran — and the cascade then took that article with
   * it. A narrow window, but the guard exists precisely because the loss
   * cannot be undone, and a guard that can be raced is not a guard.
   */
  await database.transaction(async (tx) => {
    // An actual COUNT, not `select({ count: articles.id }).limit(1)` — that
    // returned the first article's UUID, which is truthy for any client with
    // work and so happened to gate correctly while meaning nothing. The number
    // is used in the message below, where a UUID would have been visible.
    const [row] = await tx
      .select({ count: countOf() })
      .from(articles)
      .where(and(
        eq(articles.workspaceId, ctx.workspaceId),
        eq(articles.businessId, body.businessId),
      ));
    const articleCount = row?.count ?? 0;

    /*
     * Refuse to remove a client that has written work.
     *
     * The cascade would take its articles, keywords and crawl history with it,
     * and there is no undo. Requiring the articles to go first makes the loss
     * explicit rather than a side effect of tidying up a list.
     */
    if (articleCount > 0) {
      throw new AppError(
        "conflict",
        `${business.name} has ${articleCount} article${articleCount === 1 ? "" : "s"}. ` +
          "Delete or move them before removing the client.",
        { retryable: false },
      );
    }

    await tx
      .delete(businesses)
      .where(and(
        eq(businesses.workspaceId, ctx.workspaceId),
        eq(businesses.id, body.businessId),
      ));

    /*
     * Clear the selection if it pointed here.
     *
     * Every business-scoped table cascades, so no rows are orphaned — but the
     * selected client is a JSON pointer in workspace settings, which is not a
     * foreign key and so is not cascaded. Left dangling, the layout hands a
     * deleted id to the crawl poller and the switcher, which then compute the
     * highlighted row and the "already selected" guard against a fallback
     * rather than a real selection.
     */
    const [ws] = await tx
      .select({ settings: workspaces.settings })
      .from(workspaces)
      .where(eq(workspaces.id, ctx.workspaceId))
      .limit(1);

    if (ws?.settings.onboarding?.businessId === body.businessId) {
      const onboarding = { ...ws.settings.onboarding };
      delete onboarding.businessId;
      await tx
        .update(workspaces)
        .set({ settings: { ...ws.settings, onboarding }, updatedAt: new Date() })
        .where(eq(workspaces.id, ctx.workspaceId));
    }
  });

  await repo.writeAudit(database, ctx, {
    action: "client.removed",
    entityType: "business",
    entityId: body.businessId,
    before: { name: business.name },
  });

  return { ok: true };
});
