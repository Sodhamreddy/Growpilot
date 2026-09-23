import { eq, and, isNull, sql } from "drizzle-orm";
import { AppError } from "@ob/core";
import {
  businessSources, sourcePages, businesses, businessFacts, businessLocations, brandVoices,
} from "@ob/db";
import { crawlSite, canonicalizeUrl } from "@ob/seo";
import { chunkPage } from "@ob/kb";
import { indexChunks, clearChunks } from "@ob/kb";
import {
  extractBusinessProfile, extractBrandVoice, profileUpdates, fillMissingInstructions,
} from "@ob/pipeline";
import { JOBS, payloadFrom } from "@ob/jobs";
import { repo } from "@ob/db";
import type { WorkerContext } from "../../context.js";
import { contextFromPayload } from "../../context.js";

/**
 * Crawl queue processors — spec §3 and §12.
 *
 * The chain is: crawl the site → extract the profile → extract the voice →
 * index the knowledge base. Each stage enqueues the next rather than doing
 * everything in one job, so a failure in extraction does not force a re-crawl.
 */

export interface CrawlPayload {
  workspaceId: string;
  userId: string;
  correlationId: string;
  sourceId: string;
  businessId: string;
}

export async function processCrawlSite(
  wc: WorkerContext,
  payload: CrawlPayload,
  signal: AbortSignal,
): Promise<{ pagesFetched: number; warnings: string[] }> {
  const ctx = contextFromPayload(payload);
  const log = wc.logger.child({ correlationId: ctx.correlationId, workspaceId: ctx.workspaceId });

  const [source] = await wc.db
    .select()
    .from(businessSources)
    .where(and(eq(businessSources.workspaceId, ctx.workspaceId), eq(businessSources.id, payload.sourceId)))
    .limit(1);

  if (!source) throw new AppError("not_found", "That crawl source no longer exists.", { retryable: false });

  await wc.db
    .update(businessSources)
    .set({ crawlStatus: "running", lastError: null })
    .where(eq(businessSources.id, source.id));

  try {
    const result = await crawlSite(
      source.canonicalUrl,
      {
        maxPages: wc.cfg.CRAWL_MAX_PAGES,
        maxDepth: wc.cfg.CRAWL_MAX_DEPTH,
        timeoutMs: wc.cfg.CRAWL_TIMEOUT_MS,
        userAgent: wc.cfg.CRAWL_USER_AGENT,
        // Optional. When the rendering service is running, pages a static
        // fetcher cannot read are retried through a real browser.
        ...(wc.cfg.CRAWLER_SERVICE_URL
          ? { renderServiceUrl: wc.cfg.CRAWLER_SERVICE_URL }
          : {}),
      },
      log,
    );

    if (signal.aborted) throw new AppError("internal", "The crawl was cancelled.");

    // Replace the page set atomically so a partial crawl never half-updates.
    await wc.db.transaction(async (tx) => {
      await tx.delete(sourcePages).where(eq(sourcePages.sourceId, source.id));
      for (const page of result.pages) {
        await tx.insert(sourcePages).values({
          workspaceId: ctx.workspaceId,
          sourceId: source.id,
          url: page.url,
          httpStatus: page.httpStatus,
          title: page.title,
          metaDescription: page.metaDescription,
          canonical: page.canonical,
          h1: page.h1,
          pageType: page.pageType,
          wordCount: page.wordCount,
          text: page.text.slice(0, 200_000),
          headings: page.headings,
          jsonLd: page.jsonLd,
          openGraph: page.openGraph,
          internalLinks: page.internalLinks.slice(0, 200),
        });
      }
      await tx
        .update(businessSources)
        .set({
          crawlStatus: "running",
          pagesDiscovered: result.discovered,
          pagesFetched: result.pages.length,
          brandColors: result.brandColors,
          // The site's own list of its URLs — kept as internal link targets
          // even when few pages were actually fetched.
          sitemapUrls: result.sitemapUrls.slice(0, 500),
          lastCrawledAt: new Date(),
          lastError: null,
        })
        .where(eq(businessSources.id, source.id));

      // Seed the logo only when the customer has not already chosen one. A
      // later re-crawl must never overwrite a deliberate brand edit.
      if (result.logoUrl) {
        await tx
          .update(businesses)
          .set({ logoUrl: result.logoUrl, updatedAt: new Date() })
          .where(and(
            eq(businesses.workspaceId, ctx.workspaceId),
            eq(businesses.id, payload.businessId),
            isNull(businesses.logoUrl),
          ));
      }

      /*
       * Social accounts from the site's own footer.
       *
       * Same rule as the logo: seed an empty list, never touch one a person
       * has edited. Somebody who removed an account we found had a reason,
       * and re-adding it on the next crawl would undo that silently.
       *
       * These decide which content categories the client gets, so finding
       * them automatically is the difference between a social plan shaped
       * around the networks they actually run and a generic one. Before this,
       * every client in the system had an empty list because nobody fills in
       * a form asking for handles they have already published.
       */
      if (result.socialProfiles.length > 0) {
        await tx
          .update(businesses)
          .set({ socialProfiles: result.socialProfiles, updatedAt: new Date() })
          .where(and(
            eq(businesses.workspaceId, ctx.workspaceId),
            eq(businesses.id, payload.businessId),
            sql`jsonb_array_length(${businesses.socialProfiles}) = 0`,
          ));
      }
    });

    await repo.writeAudit(wc.db, ctx, {
      action: "business.crawled",
      entityType: "business_source",
      entityId: source.id,
      after: { pagesFetched: result.pages.length, warnings: result.warnings },
    });

    // Extraction and voice analysis both read the pages we just stored.
    await wc.queues.enqueue("crawl", JOBS.extractProfile, payloadFrom(ctx, {
      sourceId: source.id,
      businessId: payload.businessId,
    }));

    log.info("Crawl complete", { pages: result.pages.length, jsHeavy: result.jsHeavy });
    return { pagesFetched: result.pages.length, warnings: result.warnings };
  } catch (err) {
    const appErr = err instanceof AppError ? err : new AppError("internal", "The crawl failed.", { cause: err });
    await wc.db
      .update(businessSources)
      .set({
        crawlStatus: appErr.code === "crawl_blocked" ? "blocked" : "failed",
        lastError: appErr.safeMessage,
      })
      .where(eq(businessSources.id, source.id));
    throw appErr;
  }
}

export async function processExtractProfile(
  wc: WorkerContext,
  payload: CrawlPayload,
): Promise<{ facts: number }> {
  const ctx = contextFromPayload(payload);
  const pages = await loadPages(wc, ctx.workspaceId, payload.sourceId);
  if (pages.length === 0) {
    throw new AppError("not_found", "No crawled pages are available to extract from.", { retryable: false });
  }

  const extracted = await extractBusinessProfile(wc.gateway, ctx, pages);

  /*
   * What the business already says about itself, so extraction can leave it
   * alone. The rule lives in profileUpdates, beside the extraction it guards,
   * where it is covered by tests; read there for why.
   */
  await wc.db.transaction(async (tx) => {
    /*
     * Read inside the transaction, and lock the row.
     *
     * Extraction takes a while, and both merges below decide what to write by
     * asking what is already there. Reading that before the transaction meant
     * deciding against a snapshot that could be minutes old: a customer who
     * saved a hand-written instruction, or corrected their industry, while the
     * crawl was extracting had it overwritten by a merge that still believed
     * the box was empty. No error, nothing in the audit log, and the one
     * instruction in the box that was actually thought about is the one lost.
     *
     * FOR UPDATE holds the row until this commits, so a concurrent save either
     * lands first and is seen here, or waits and applies on top.
     */
    const [current] = await tx
      .select({
        name: businesses.name,
        industry: businesses.industry,
        audience: businesses.audience,
        description: businesses.description,
        usp: businesses.usp,
        primaryCta: businesses.primaryCta,
        prompts: businesses.prompts,
      })
      .from(businesses)
      .where(and(eq(businesses.workspaceId, ctx.workspaceId), eq(businesses.id, payload.businessId)))
      .limit(1)
      .for("update");

    const profile = profileUpdates(extracted, current ?? {});

    /*
     * Top up the writing instructions from the profile we now have.
     *
     * The client was created with starter instructions built from whatever
     * was typed into the add form, which for a client added by URL is just a
     * name. The crawl is the first point at which the services, audience and
     * locations exist, so it is the first point the instructions can be
     * specific to this business rather than generic.
     *
     * Only empty boxes are filled. Anything the customer has written is left
     * alone, so this stays safe to run on every re-crawl.
     */
    const merged = { ...(current ?? {}), ...profile };
    const updates = {
      ...profile,
      prompts: fillMissingInstructions(current?.prompts, {
        name: merged.name ?? "",
        industry: merged.industry ?? null,
        audience: merged.audience ?? null,
        description: merged.description ?? null,
        usp: merged.usp ?? null,
        primaryCta: merged.primaryCta ?? null,
        services: extracted.services.map((s) => s.name),
        locations: [...new Set(
          extracted.locations.map((l) => l.locality).filter((v): v is string => Boolean(v)),
        )],
      }),
      updatedAt: new Date(),
    };

    await tx
      .update(businesses)
      .set(updates)
      .where(and(eq(businesses.workspaceId, ctx.workspaceId), eq(businesses.id, payload.businessId)));

    // Facts are replaced wholesale, but customer-verified ones survive
    // (see repo.replaceFacts) so a re-crawl never discards human corrections.
    await tx
      .delete(businessFacts)
      .where(
        and(
          eq(businessFacts.workspaceId, ctx.workspaceId),
          eq(businessFacts.businessId, payload.businessId),
          eq(businessFacts.verified, false),
        ),
      );

    const rows = [
      ...extracted.facts.map((f) => ({
        key: f.key,
        value: f.value,
        sourceUrl: f.sourceUrl,
        sourceQuote: f.quote,
        confidence: f.confidence,
      })),
      ...extracted.services.map((s) => ({
        key: "service",
        value: s.description ? `${s.name} — ${s.description}` : s.name,
        sourceUrl: s.sourceUrl,
        sourceQuote: s.quote,
        confidence: s.confidence,
      })),
    ];

    if (rows.length > 0) {
      await tx.insert(businessFacts).values(
        rows.map((r) => ({ ...r, workspaceId: ctx.workspaceId, businessId: payload.businessId })),
      );
    }

    if (extracted.locations.length > 0) {
      await tx
        .delete(businessLocations)
        .where(
          and(
            eq(businessLocations.workspaceId, ctx.workspaceId),
            eq(businessLocations.businessId, payload.businessId),
          ),
        );
      await tx.insert(businessLocations).values(
        extracted.locations.map((l) => ({
          workspaceId: ctx.workspaceId,
          businessId: payload.businessId,
          label: l.label,
          streetAddress: l.streetAddress ?? null,
          locality: l.locality ?? null,
          region: l.region ?? null,
          postalCode: l.postalCode ?? null,
          country: l.country ?? null,
          phone: l.phone ?? null,
          sourceUrl: l.sourceUrl,
          confidence: l.confidence,
        })),
      );
    }
  });

  await repo.writeAudit(wc.db, ctx, {
    action: "business.profile_extracted",
    entityType: "business",
    entityId: payload.businessId,
    after: { facts: extracted.facts.length, services: extracted.services.length },
  });

  await wc.queues.enqueue("crawl", JOBS.extractVoice, payloadFrom(ctx, {
    sourceId: payload.sourceId,
    businessId: payload.businessId,
  }));

  return { facts: extracted.facts.length };
}

export async function processExtractVoice(
  wc: WorkerContext,
  payload: CrawlPayload,
): Promise<{ voiceId: string }> {
  const ctx = contextFromPayload(payload);
  const pages = await loadPages(wc, ctx.workspaceId, payload.sourceId);
  const extracted = await extractBrandVoice(wc.gateway, ctx, pages);

  // Version the profile rather than overwriting: §18.2 requires the customer
  // to approve, and an approved voice must never be silently replaced.
  const existing = await wc.db
    .select({ version: brandVoices.version })
    .from(brandVoices)
    .where(
      and(eq(brandVoices.workspaceId, ctx.workspaceId), eq(brandVoices.businessId, payload.businessId)),
    );
  const nextVersion = Math.max(0, ...existing.map((v) => v.version)) + 1;

  const [voice] = await wc.db
    .insert(brandVoices)
    .values({
      workspaceId: ctx.workspaceId,
      businessId: payload.businessId,
      version: nextVersion,
      profile: extracted.profile,
      bannedTerms: extracted.bannedTerms,
      preferredTerms: extracted.preferredTerms,
      samples: extracted.samples,
      // Draft only. Activation is an explicit customer action (spec §18.2).
      isActive: false,
    })
    .returning();

  await repo.writeAudit(wc.db, ctx, {
    action: "voice.extracted",
    entityType: "brand_voice",
    entityId: voice!.id,
    after: { version: nextVersion, rationale: extracted.rationale },
  });

  await wc.queues.enqueue("crawl", JOBS.indexKnowledge, payloadFrom(ctx, {
    sourceId: payload.sourceId,
    businessId: payload.businessId,
  }));

  return { voiceId: voice!.id };
}

export async function processIndexKnowledge(
  wc: WorkerContext,
  payload: CrawlPayload,
): Promise<{ chunks: number }> {
  const ctx = contextFromPayload(payload);
  const pages = await loadPages(wc, ctx.workspaceId, payload.sourceId);

  await clearChunks(wc.db, ctx, payload.businessId, "page");

  const chunks = pages.flatMap((page) =>
    chunkPage({ title: page.title, headings: page.headings, text: page.text }).map((c) => ({
      kind: "page",
      sourceUrl: page.url,
      heading: c.heading,
      content: c.content,
      tokenCount: c.tokenCount,
    })),
  );

  const count = await indexChunks(wc.db, wc.gateway, ctx, payload.businessId, chunks);
  wc.logger.info("Knowledge base indexed", { workspaceId: ctx.workspaceId, chunks: count });
  // Onboarding may proceed only after profile, voice and knowledge are ready.
  await wc.db.update(businessSources).set({ crawlStatus: "succeeded", lastError: null })
    .where(and(eq(businessSources.workspaceId, ctx.workspaceId), eq(businessSources.id, payload.sourceId)));
  return { chunks: count };
}

async function loadPages(wc: WorkerContext, workspaceId: string, sourceId: string) {
  const rows = await wc.db
    .select()
    .from(sourcePages)
    .where(and(eq(sourcePages.workspaceId, workspaceId), eq(sourcePages.sourceId, sourceId)));

  return rows.map((r) => ({
    url: r.url,
    httpStatus: r.httpStatus ?? 200,
    depth: 0,
    title: r.title,
    metaDescription: r.metaDescription,
    canonical: r.canonical,
    robotsMeta: null,
    h1: r.h1,
    headings: r.headings,
    text: r.text,
    wordCount: r.wordCount,
    openGraph: r.openGraph,
    jsonLd: r.jsonLd,
    internalLinks: r.internalLinks,
    externalLinks: [],
    images: [],
    lang: null,
    pageType: (r.pageType ?? "other") as "home" | "about" | "services" | "product" | "location" | "contact" | "faq" | "blog" | "legal" | "other",
  }));
}

export { canonicalizeUrl };
