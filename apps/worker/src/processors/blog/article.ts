import { eq, and } from "drizzle-orm";
import { AppError, slugify } from "@ob/core";
import {
  articles, articleRevisions, articleScores, qualityGateResults, topics, keywords,
  businesses, sourcePages, businessSources, workspaces, repo,
} from "@ob/db";
import { DEFAULT_VOICE_PROFILE, DEFAULT_BANNED_TERMS } from "@ob/voice";
import { retrieve } from "@ob/kb";
import { runAllGates, statusAfterGates, assertTransition } from "@ob/pipeline";
import { generateArticle, generateBrief } from "@ob/blog";
import { parseHtml } from "@ob/seo";
import { JOBS, payloadFrom } from "@ob/jobs";
import type { WorkerContext } from "../../context.js";
import { contextFromPayload } from "../../context.js";

/**
 * Article generation and QA — spec §6.3.
 *
 * Two processors: generate a draft, then run the gates over it. They are
 * separate jobs so a gate failure can be re-run after a manual edit without
 * paying for generation again.
 */

export interface ArticlePayload {
  workspaceId: string;
  userId: string;
  correlationId: string;
  articleId: string;
}

export async function processGenerateArticle(
  wc: WorkerContext,
  payload: ArticlePayload,
): Promise<{ wordCount: number }> {
  const ctx = contextFromPayload(payload);
  const article = await repo.getArticle(wc.db, ctx, payload.articleId);

  /*
   * Claim the article — or resume a claim this job already made.
   *
   * A retry re-enters here with the article already "generating", because the
   * previous attempt set that and then died (a crash, a timeout, a killed
   * worker). `generating → generating` is not a legal transition and must not
   * become one: it would let a second worker trample an in-flight generation.
   * But it is a legal *resume*, and refusing it meant any generate job that
   * failed once could never succeed again — the article stayed "generating"
   * forever while every retry was rejected as a conflict.
   *
   * BullMQ runs one attempt per job id at a time, so reaching this line with
   * the article already generating means the earlier attempt is gone.
   */
  if (article.status !== "generating") {
    assertTransition(article.status, "generating");
    await wc.db.update(articles).set({ status: "generating" }).where(eq(articles.id, article.id));
  } else {
    wc.logger.warn("Resuming a generation abandoned by an earlier attempt", {
      articleId: article.id,
    });
  }

  try {
    const business = await repo.getBusiness(wc.db, ctx, article.businessId);
    const facts = await repo.listFacts(wc.db, ctx, article.businessId);
    const voice = await repo.getActiveVoice(wc.db, ctx, article.businessId);

    const topic = article.topicId
      ? (await wc.db.select().from(topics)
          .where(and(eq(topics.workspaceId, ctx.workspaceId), eq(topics.id, article.topicId)))
          .limit(1))[0]
      : undefined;

    const primaryKeyword = await resolvePrimaryKeyword(wc, ctx.workspaceId, topic?.primaryKeywordId)
      ?? article.title;

    // Retrieve evidence for this specific topic (spec §4.1 step 2).
    const evidence = await retrieve(wc.db, wc.gateway, ctx, {
      businessId: article.businessId,
      query: `${article.title} ${primaryKeyword}`,
      limit: 8,
    });

    const internalLinkCandidates = await loadInternalLinkCandidates(wc, ctx.workspaceId, article.businessId);

    // Generate the brief if the topic does not already have one.
    let brief = topic?.brief ?? null;
    if (!brief) {
      brief = await generateBrief(wc.gateway, ctx, {
        business,
        facts,
        evidence,
        topicTitle: article.title,
        primaryKeyword,
        secondaryKeywords: topic?.secondaryTerms ?? [],
        intent: topic?.intent ?? "informational",
        internalLinkCandidates,
      });
      if (topic) {
        await wc.db.update(topics).set({ brief, status: "briefed" }).where(eq(topics.id, topic.id));
      }
    }

    const [workspace] = await wc.db.select({ settings: workspaces.settings }).from(workspaces)
      .where(eq(workspaces.id, ctx.workspaceId)).limit(1);
    const setup = workspace?.settings.onboarding;
    const selectedTone = setup?.tone;
    const generated = await generateArticle(wc.gateway, ctx, {
      business,
      facts,
      evidence,
      voice: voice
        ? {
            profile: voice.profile,
            bannedTerms: voice.bannedTerms,
            preferredTerms: voice.preferredTerms,
            samples: voice.samples,
          }
        : { profile: { ...DEFAULT_VOICE_PROFILE, ...(selectedTone ? { tone: [selectedTone] } : {}) }, bannedTerms: [...DEFAULT_BANNED_TERMS], preferredTerms: [], samples: [] },
      brief,
      primaryKeyword,
      secondaryKeywords: topic?.secondaryTerms ?? [],
      title: article.title,
      contentThemes: setup?.contentPillars ?? [],
      /*
       * This client's own writing direction.
       *
       * Read from the business, not the workspace. An agency's clients are
       * rarely in the same trade, and a pharmacy's instructions were reaching
       * a marketing agency's articles.
       */
      ...(business.prompts?.blog?.article?.trim()
        ? { instructions: business.prompts.blog.article }
        : {}),
      ...(business.prompts?.blog?.reference?.trim()
        ? { reference: business.prompts.blog.reference }
        : {}),
    });

    const nextVersion = article.version + 1;

    await wc.db.transaction(async (tx) => {
      await tx.insert(articleRevisions).values({
        workspaceId: ctx.workspaceId,
        articleId: article.id,
        version: nextVersion,
        title: generated.title,
        bodyMarkdown: generated.bodyMarkdown,
        authoredBy: "ai",
      });

      await tx
        .update(articles)
        .set({
          title: generated.title,
          slug: await uniqueSlug(wc, ctx.workspaceId, article.businessId, generated.slug, article.id),
          metaTitle: generated.metaTitle,
          metaDescription: generated.metaDescription,
          bodyMarkdown: generated.bodyMarkdown,
          wordCount: generated.wordCount,
          version: nextVersion,
          status: "qa",
          brandVoiceId: voice?.id ?? null,
          updatedAt: new Date(),
        })
        .where(eq(articles.id, article.id));
    });

    await repo.writeAudit(wc.db, ctx, {
      action: "article.generated",
      entityType: "article",
      entityId: article.id,
      after: { version: nextVersion, wordCount: generated.wordCount },
    });

    await wc.queues.enqueue("qa", JOBS.runQualityGates, payloadFrom(ctx, { articleId: article.id }));

    return { wordCount: generated.wordCount };
  } catch (err) {
    await wc.db.update(articles).set({ status: "failed" }).where(eq(articles.id, article.id));
    throw err;
  }
}

export async function processRunQualityGates(
  wc: WorkerContext,
  payload: ArticlePayload,
): Promise<{ publishable: boolean; score: number }> {
  const ctx = contextFromPayload(payload);
  const article = await repo.getArticle(wc.db, ctx, payload.articleId);

  const business = await repo.getBusiness(wc.db, ctx, article.businessId);
  const facts = await repo.listFacts(wc.db, ctx, article.businessId);
  const voice = await repo.getActiveVoice(wc.db, ctx, article.businessId);

  const [workspace] = await wc.db
    .select({ settings: workspaces.settings })
    .from(workspaces)
    .where(eq(workspaces.id, ctx.workspaceId))
    .limit(1);

  const topic = article.topicId
    ? (await wc.db.select().from(topics)
        .where(and(eq(topics.workspaceId, ctx.workspaceId), eq(topics.id, article.topicId)))
        .limit(1))[0]
    : undefined;

  const primaryKeyword =
    (await resolvePrimaryKeyword(wc, ctx.workspaceId, topic?.primaryKeywordId)) ?? article.title;

  const evidence = await retrieve(wc.db, wc.gateway, ctx, {
    businessId: article.businessId,
    query: `${article.title} ${primaryKeyword}`,
    limit: 10,
  });

  const parsed = extractStructure(article.bodyMarkdown, article.title);

  const result = await runAllGates(wc.gateway, ctx, {
    article: {
      title: article.title,
      slug: article.slug,
      metaTitle: article.metaTitle,
      metaDescription: article.metaDescription,
      bodyMarkdown: article.bodyMarkdown,
      schemaJsonLd: article.schemaJsonLd,
      internalLinks: parsed.internalLinks,
      externalLinks: parsed.externalLinks,
      images: parsed.images,
      headings: parsed.headings,
    },
    primaryKeyword,
    secondaryKeywords: topic?.secondaryTerms ?? [],
    business,
    facts,
    evidence,
    voice: voice
      ? { profile: voice.profile, bannedTerms: voice.bannedTerms, preferredTerms: voice.preferredTerms }
      : null,
    settings: workspace?.settings ?? {},
    hasCta: parsed.hasCta,
    ctaText: parsed.ctaText,
  });

  await wc.db.transaction(async (tx) => {
    // Gate results are versioned — re-running never loses the prior verdict.
    await tx
      .delete(qualityGateResults)
      .where(
        and(
          eq(qualityGateResults.workspaceId, ctx.workspaceId),
          eq(qualityGateResults.articleId, article.id),
          eq(qualityGateResults.articleVersion, article.version),
        ),
      );

    await tx.insert(qualityGateResults).values(
      result.gates.map((g) => ({
        workspaceId: ctx.workspaceId,
        articleId: article.id,
        articleVersion: article.version,
        gate: g.gate,
        verdict: g.verdict,
        score: g.score,
        findings: g.findings,
      })),
    );

    await tx
      .insert(articleScores)
      .values({
        workspaceId: ctx.workspaceId,
        articleId: article.id,
        articleVersion: article.version,
        total: result.score.total,
        components: result.score.components,
      })
      .onConflictDoUpdate({
        target: [articleScores.articleId, articleScores.articleVersion],
        set: { total: result.score.total, components: result.score.components },
      });

    const nextStatus = statusAfterGates(result.publishable, workspace?.settings ?? {});
    assertTransition(article.status, nextStatus);

    await tx
      .update(articles)
      .set({
        status: nextStatus,
        seoScore: result.score.total,
        voiceScore: result.voiceScore,
        updatedAt: new Date(),
      })
      .where(eq(articles.id, article.id));
  });

  await repo.writeAudit(wc.db, ctx, {
    action: "article.gates_run",
    entityType: "article",
    entityId: article.id,
    after: {
      publishable: result.publishable,
      score: result.score.total,
      verdicts: Object.fromEntries(result.gates.map((g) => [g.gate, g.verdict])),
    },
  });

  return { publishable: result.publishable, score: result.score.total };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function resolvePrimaryKeyword(
  wc: WorkerContext,
  workspaceId: string,
  keywordId: string | null | undefined,
): Promise<string | null> {
  if (!keywordId) return null;
  const [row] = await wc.db
    .select({ term: keywords.term })
    .from(keywords)
    .where(and(eq(keywords.workspaceId, workspaceId), eq(keywords.id, keywordId)))
    .limit(1);
  return row?.term ?? null;
}

/** Published pages on the customer's own site, for internal linking. */
async function loadInternalLinkCandidates(
  wc: WorkerContext,
  workspaceId: string,
  businessId: string,
): Promise<{ url: string; title: string }[]> {
  const [source] = await wc.db
    .select({ id: businessSources.id, sitemapUrls: businessSources.sitemapUrls })
    .from(businessSources)
    .where(
      and(eq(businessSources.workspaceId, workspaceId), eq(businessSources.businessId, businessId)),
    )
    .limit(1);
  if (!source) return [];

  const rows = await wc.db
    .select({ url: sourcePages.url, title: sourcePages.title })
    .from(sourcePages)
    .where(and(eq(sourcePages.workspaceId, workspaceId), eq(sourcePages.sourceId, source.id)))
    .limit(40);

  const crawled = rows
    .filter((r) => r.title)
    .map((r) => ({ url: r.url, title: r.title! }));

  if (crawled.length > 0) return crawled;

  /*
   * Fall back to the sitemap.
   *
   * A crawl can be blocked, or stopped by its page budget, and leave no stored
   * pages at all — which left the generator with nothing to link to, so it
   * correctly wrote no internal links and the article looked orphaned.
   *
   * A sitemap is the site's own statement of which URLs exist, so linking to
   * one is not a guess. There is no page title to work from, so the title is
   * derived from the URL's last path segment — good enough for the model to
   * judge relevance, and never presented to a reader as the page's real title.
   */
  return source.sitemapUrls.slice(0, 40).map((url) => ({ url, title: titleFromUrl(url) }));
}

/** "/services/senior-home-care/" → "Senior home care". */
function titleFromUrl(url: string): string {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return url;
  }
  const slug = path.split("/").filter(Boolean).pop();
  if (!slug) return "Home";
  const words = slug.replace(/\.(html?|php|aspx?)$/i, "").replace(/[-_]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Home";
}

/** Slugs are unique per business; append a counter on collision. */
async function uniqueSlug(
  wc: WorkerContext,
  workspaceId: string,
  businessId: string,
  desired: string,
  selfId: string,
): Promise<string> {
  const base = slugify(desired) || "article";
  for (let n = 0; n < 50; n++) {
    const candidate = n === 0 ? base : `${base}-${n + 1}`;
    const [clash] = await wc.db
      .select({ id: articles.id })
      .from(articles)
      .where(
        and(
          eq(articles.workspaceId, workspaceId),
          eq(articles.businessId, businessId),
          eq(articles.slug, candidate),
        ),
      )
      .limit(1);
    if (!clash || clash.id === selfId) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/**
 * Pull structure out of the markdown body.
 *
 * Rendering markdown to HTML and reusing the crawler's parser would double the
 * dependency surface for no gain; these patterns are enough for the checks the
 * gates run.
 */
function extractStructure(markdown: string, title?: string): {
  headings: { level: number; text: string }[];
  internalLinks: { url: string; anchor: string }[];
  externalLinks: { url: string; anchor: string }[];
  images: { src: string; alt: string | null }[];
  hasCta: boolean;
  ctaText: string | null;
} {
  const headings: { level: number; text: string }[] = [];
  for (const m of markdown.matchAll(/^(#{1,6})\s+(.+)$/gm)) {
    headings.push({ level: m[1]!.length, text: m[2]!.trim() });
  }

  /*
   * The title is the H1.
   *
   * It is stored in its own column and rendered as the page heading, so the
   * body deliberately starts at H2 — repeating it inside the markdown would
   * publish two H1s. The SEO gate only ever saw the body, found no `#`, and
   * failed *every* article with "The article has no H1 heading", an error
   * severe enough to block approval. Nothing was wrong with the articles; the
   * gate was reading half the document.
   *
   * Added only when the body does not already carry one, so an article that
   * does open with `#` is still correctly told it has two.
   */
  if (title?.trim() && !headings.some((h) => h.level === 1)) {
    headings.unshift({ level: 1, text: title.trim() });
  }

  const images: { src: string; alt: string | null }[] = [];
  for (const m of markdown.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)) {
    images.push({ src: m[2]!.trim(), alt: m[1]!.trim() || null });
  }

  const internalLinks: { url: string; anchor: string }[] = [];
  const externalLinks: { url: string; anchor: string }[] = [];
  // Negative lookbehind skips image markup, which shares the link syntax.
  for (const m of markdown.matchAll(/(?<!!)\[([^\]]+)\]\(([^)]+)\)/g)) {
    const link = { anchor: m[1]!.trim(), url: m[2]!.trim() };
    if (/^https?:\/\//i.test(link.url)) externalLinks.push(link);
    else internalLinks.push(link);
  }

  const ctaMatch =
    /\b(book|schedule|arrange|request|contact|call|email|buy|order|get started|sign up|learn more)\b[^.!?\n]*/i.exec(
      markdown,
    );

  return {
    headings,
    internalLinks,
    externalLinks,
    images,
    hasCta: ctaMatch !== null,
    ctaText: ctaMatch?.[0]?.trim().slice(0, 120) ?? null,
  };
}

export { parseHtml, businesses };
