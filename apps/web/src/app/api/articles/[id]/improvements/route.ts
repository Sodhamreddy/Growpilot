export const dynamic = "force-dynamic";

import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { AppError, requireRole } from "@ob/core";
import { repo, topics, keywords, workspaces } from "@ob/db";
import { splitSections, suggestScoreImprovements } from "@ob/blog";
import { retrieve } from "@ob/kb";
import { route, parseBody } from "@/lib/api";
import { db, getGateway } from "@/lib/services";
import { scoreImprovementPlanSchema } from "@/lib/score-improvements";

const requestSchema = z.object({ expectedVersion: z.number().int().positive() });
const EDITABLE = new Set(["draft", "needs_changes", "awaiting_approval"]);

/** Suggest improvements for one saved version; applying remains a separate human action. */
export const POST = route(async (ctx, req) => {
  requireRole(ctx, "editor");
  const body = await parseBody(req, requestSchema);
  const segments = new URL(req.url).pathname.split("/");
  const id = z.string().uuid().parse(segments[segments.indexOf("articles") + 1]);
  const database = db();
  const article = await repo.getArticle(database, ctx, id);
  if (body.expectedVersion !== article.version) {
    throw new AppError("conflict", "The draft changed. Refresh before requesting score improvements.", { retryable: false });
  }
  if (!EDITABLE.has(article.status)) {
    throw new AppError("conflict", "Score improvements are available for editable drafts. Wait for checks to finish or request changes first.", { retryable: false });
  }
  if (!article.bodyMarkdown.trim()) {
    throw new AppError("validation_failed", "Generate a draft before asking for score improvements.", { retryable: false });
  }
  const originalStatus = article.status;
  const originalUpdatedAt = article.updatedAt.getTime();
  const [business, facts, gates, score, [workspace], keywordRows, voice] = await Promise.all([
    repo.getBusiness(database, ctx, article.businessId),
    repo.listFacts(database, ctx, article.businessId),
    repo.listGateResults(database, ctx, id, article.version),
    repo.getScore(database, ctx, id, article.version),
    database.select({ settings: workspaces.settings }).from(workspaces)
      .where(eq(workspaces.id, ctx.workspaceId)).limit(1),
    article.topicId ? database.select({ term: keywords.term }).from(topics)
      .leftJoin(keywords, and(eq(keywords.id, topics.primaryKeywordId), eq(keywords.workspaceId, ctx.workspaceId), eq(keywords.businessId, article.businessId)))
      .where(and(eq(topics.id, article.topicId), eq(topics.workspaceId, ctx.workspaceId), eq(topics.businessId, article.businessId))).limit(1) : Promise.resolve([]),
    repo.getActiveVoice(database, ctx, article.businessId),
  ]);
  const minimumScore = workspace?.settings?.minSeoScoreToPublish ?? 70;
  const minimumVoiceScore = workspace?.settings?.minVoiceScoreToPublish ?? 70;
  const gateway = getGateway();
  const primaryKeyword = keywordRows[0]?.term ?? article.title;
  const evidence = await retrieve(database, gateway, ctx, { businessId: article.businessId, query: `${article.title} ${primaryKeyword}`, limit: 8 });
  const proposal = await suggestScoreImprovements(gateway, ctx, {
    business, facts, voice, evidence, article: { title: article.title, metaTitle: article.metaTitle,
      metaDescription: article.metaDescription, bodyMarkdown: article.bodyMarkdown },
    primaryKeyword,
    currentScore: article.seoScore, minimumScore,
    currentVoiceScore: voice ? article.voiceScore : null, minimumVoiceScore,
    gates: gates.map(gate => ({ gate: gate.gate, verdict: gate.verdict, findings: gate.findings })),
    scoreComponents: score?.components ?? [],
  });
  const parsed = scoreImprovementPlanSchema.safeParse(proposal);
  const sections = new Set(splitSections(article.bodyMarkdown).map(section => section.id));
  if (!parsed.success || parsed.data.suggestions.some(suggestion => suggestion.target === "section" && !sections.has(suggestion.sectionId!))) {
    throw new AppError("provider_error", "The AI could not produce usable score suggestions. Please try again.");
  }
  // The model call may take time: a concurrent edit or QA result makes its advice stale.
  const latest = await repo.getArticle(database, ctx, id);
  if (latest.version !== body.expectedVersion || latest.status !== originalStatus || latest.updatedAt.getTime() !== originalUpdatedAt) {
    throw new AppError("conflict", "The draft or its checks changed while suggestions were being prepared. Refresh and try again.", { retryable: false });
  }
  await repo.writeAudit(database, ctx, { action: "article.score_improvements_proposed", entityType: "article", entityId: id,
    after: { version: article.version, currentScore: article.seoScore, minimumScore,
      count: parsed.data.suggestions.length, targets: parsed.data.suggestions.map(suggestion => suggestion.target) } });
  return { ok: true, expectedVersion: article.version, currentScore: article.seoScore, minimumScore,
    currentVoiceScore: voice ? article.voiceScore : null, minimumVoiceScore, hasVoiceProfile: Boolean(voice), ...parsed.data };
}, { rateLimit: { limit: 30, windowSeconds: 3600 } });
