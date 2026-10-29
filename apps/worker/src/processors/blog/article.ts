import { eq, and } from "drizzle-orm";
import { AppError, slugify } from "@ob/core";
import {
  articles, articleRevisions, articleScores, qualityGateResults, topics, keywords,
  businesses, sourcePages, businessSources, workspaces, repo,
  type ContentBrief,
} from "@ob/db";
import { DEFAULT_VOICE_PROFILE, DEFAULT_BANNED_TERMS } from "@ob/voice";
import { retrieve } from "@ob/kb";
import { runAllGates, statusAfterGates, assertTransition, type GateContext } from "@ob/pipeline";
import { generateArticle, generateBrief, improveGeneratedArticleQuality, type GeneratedArticle } from "@ob/blog";
import { parseHtml, extractStructure } from "@ob/seo";
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
  articleVersion?: number;
  /** Only the generation job sets this. Manual QA never rewrites an article. */
  generationQuality?: { brief: ContentBrief; primaryKeyword: string };
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
    const generatedSlug = await uniqueSlug(wc, ctx.workspaceId, article.businessId, generated.slug, article.id);

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
          slug: generatedSlug,
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

    await wc.queues.enqueue("qa", JOBS.runQualityGates, payloadFrom(ctx, {
      articleId: article.id, articleVersion: nextVersion, generationQuality: { brief, primaryKeyword },
    }));

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

  if (payload.articleVersion !== undefined && payload.articleVersion !== article.version) {
    throw new AppError("conflict", "The article changed. Run QA on the current version.", { retryable: false });
  }
  if (!["draft", "qa", "needs_changes", "awaiting_approval"].includes(article.status)) {
    throw new AppError("conflict", "This article is no longer an editable draft for QA.", { retryable: false });
  }
  if (article.status !== "qa") assertTransition(article.status, "qa");
  const [claimed] = await wc.db.update(articles).set({ status: "qa", approvedAt: null, approvedBy: null })
    .where(and(eq(articles.id, article.id), eq(articles.workspaceId, ctx.workspaceId),
      eq(articles.version, article.version), eq(articles.status, article.status))).returning({ id: articles.id });
  if (!claimed) throw new AppError("conflict", "The article changed before QA started. Refresh and try again.", { retryable: false });

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
    (await resolvePrimaryKeyword(wc, ctx.workspaceId, topic?.primaryKeywordId)) ?? payload.generationQuality?.primaryKeyword ?? article.title;

  const evidence = await retrieve(wc.db, wc.gateway, ctx, {
    businessId: article.businessId,
    query: `${article.title} ${primaryKeyword}`,
    limit: 10,
  });

  const parsed = extractStructure(article.bodyMarkdown, article.title, business.websiteUrl);

  const gateContext: GateContext = {
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
    searchIntent: topic?.intent ?? payload.generationQuality?.brief.searchIntent,
    business,
    facts,
    evidence,
    voice: voice
      ? { profile: voice.profile, bannedTerms: voice.bannedTerms, preferredTerms: voice.preferredTerms }
      : null,
    settings: workspace?.settings ?? {},
    hasCta: parsed.hasCta,
    ctaText: parsed.ctaText,
  };
  let result = await runAllGates(wc.gateway, ctx, gateContext);
  let improved: GeneratedArticle | null = null;
  let improvementAttempts = 0;
  const initialScore = result.score.total;
  const minimumScore = Math.max(70, workspace?.settings.minSeoScoreToPublish ?? 70);

  if (payload.generationQuality && payload.articleVersion === article.version) {
    const setup = workspace?.settings.onboarding;
    const quality = await improveGeneratedArticleQuality(wc.gateway, ctx, {
      business, facts, evidence,
      voice: voice ? { profile: voice.profile, bannedTerms: voice.bannedTerms, preferredTerms: voice.preferredTerms, samples: voice.samples }
        : { profile: { ...DEFAULT_VOICE_PROFILE, ...(setup?.tone ? { tone: [setup.tone] } : {}) }, bannedTerms: [...DEFAULT_BANNED_TERMS], preferredTerms: [], samples: [] },
      brief: payload.generationQuality.brief, primaryKeyword, secondaryKeywords: topic?.secondaryTerms ?? [],
      title: article.title, contentThemes: setup?.contentPillars ?? [],
      instructions: business.prompts?.blog?.article, reference: business.prompts?.blog?.reference,
    }, {
      title: article.title, slug: article.slug, metaTitle: article.metaTitle ?? "", metaDescription: article.metaDescription ?? "",
      bodyMarkdown: article.bodyMarkdown, internalLinks: parsed.internalLinks, wordCount: article.wordCount ?? 0,
    }, result, async (candidate) => {
      const structure = extractStructure(candidate.bodyMarkdown, candidate.title, business.websiteUrl);
      return runAllGates(wc.gateway, ctx, {
        ...gateContext,
        article: { ...gateContext.article, ...candidate, ...structure },
        hasCta: structure.hasCta, ctaText: structure.ctaText,
      });
    }, minimumScore);
    result = quality.assessment;
    improvementAttempts = quality.attempts;
    if (quality.improved) improved = quality.article;

    if (result.score.total < minimumScore) {
      const message = `The generated draft scored ${result.score.total.toFixed(1)}, below the minimum of ${minimumScore}, after bounded quality improvement. Review the findings before approval.`;
      const seo = result.gates.find((gate) => gate.gate === "seo");
      if (seo) { seo.verdict = "fail"; seo.findings.push({ severity: "error", message, suggestion: "Improve the flagged content or add verified facts and relevant source pages, then run quality checks again.", location: "generationQuality" }); }
      result.publishable = false;
      result.blockingReasons.push(message);
    }
  }
  const scoredVersion = article.version + (improved ? 1 : 0);
  const improvedSlug = improved ? await uniqueSlug(wc, ctx.workspaceId, article.businessId, improved.slug, article.id) : null;

  await wc.db.transaction(async (tx) => {
    const nextStatus = statusAfterGates(result.publishable, workspace?.settings ?? {});
    assertTransition("qa", nextStatus);
    const [saved] = await tx.update(articles).set({
      status: nextStatus, seoScore: result.score.total, voiceScore: result.voiceScore, updatedAt: new Date(),
      ...(improved ? { title: improved.title, slug: improvedSlug!, metaTitle: improved.metaTitle, metaDescription: improved.metaDescription,
        bodyMarkdown: improved.bodyMarkdown, wordCount: improved.wordCount, version: scoredVersion } : {}),
    }).where(and(eq(articles.id, article.id), eq(articles.workspaceId, ctx.workspaceId),
      eq(articles.version, article.version), eq(articles.status, "qa"))).returning({ id: articles.id });
    if (!saved) throw new AppError("conflict", "The article changed during QA. Run QA again for the latest version.", { retryable: false });
    if (improved) await tx.insert(articleRevisions).values({ workspaceId: ctx.workspaceId, articleId: article.id,
      version: scoredVersion, title: improved.title, bodyMarkdown: improved.bodyMarkdown, authoredBy: "ai" });
    // Gate results are versioned — re-running never loses the prior verdict.
    await tx
      .delete(qualityGateResults)
      .where(
        and(
          eq(qualityGateResults.workspaceId, ctx.workspaceId),
          eq(qualityGateResults.articleId, article.id),
          eq(qualityGateResults.articleVersion, scoredVersion),
        ),
      );

    await tx.insert(qualityGateResults).values(
      result.gates.map((g) => ({
        workspaceId: ctx.workspaceId,
        articleId: article.id,
        articleVersion: scoredVersion,
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
        articleVersion: scoredVersion,
        total: result.score.total,
        components: result.score.components,
      })
      .onConflictDoUpdate({
        target: [articleScores.articleId, articleScores.articleVersion],
        set: { total: result.score.total, components: result.score.components },
      });

  });

  await repo.writeAudit(wc.db, ctx, {
    action: "article.gates_run",
    entityType: "article",
    entityId: article.id,
    after: {
      publishable: result.publishable,
      score: result.score.total,
      version: scoredVersion,
      ...(payload.generationQuality ? { initialScore, improvementAttempts, improved: Boolean(improved) } : {}),
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

export { parseHtml, businesses, extractStructure };
