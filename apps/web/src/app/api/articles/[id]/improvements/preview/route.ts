export const dynamic = "force-dynamic";

import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { AppError, requireRole } from "@ob/core";
import { repo, topics, keywords, workspaces } from "@ob/db";
import { previewScoreImprovements } from "@ob/blog";
import { route, parseBody } from "@/lib/api";
import { scoreImprovementSuggestionSchema } from "@/lib/score-improvements";
import { db, getGateway } from "@/lib/services";

const schema = z.object({
  expectedVersion: z.number().int().positive(),
  suggestions: z.array(scoreImprovementSuggestionSchema).min(1).max(8),
}).superRefine((body, ctx) => {
  const ids = new Set<string>(), targets = new Set<string>();
  for (const suggestion of body.suggestions) {
    const target = `${suggestion.target}:${suggestion.sectionId ?? ""}`;
    if (ids.has(suggestion.id) || targets.has(target)) ctx.addIssue({ code: "custom", message: "Select each field or section only once." });
    ids.add(suggestion.id); targets.add(target);
  }
});
const EDITABLE = new Set(["draft", "needs_changes", "awaiting_approval"]);

/** Prepare a single, combined patch. The normal versioned PATCH saves only after review. */
export const POST = route(async (ctx, req) => {
  requireRole(ctx, "editor");
  const body = await parseBody(req, schema);
  const segments = new URL(req.url).pathname.split("/");
  const id = z.string().uuid().parse(segments[segments.indexOf("articles") + 1]);
  const database = db();
  const article = await repo.getArticle(database, ctx, id);
  if (article.version !== body.expectedVersion) throw stale();
  if (!EDITABLE.has(article.status) || !article.bodyMarkdown.trim()) {
    throw new AppError("conflict", "Wait for checks to finish or request changes before preparing edits to this draft.", { retryable: false });
  }
  const [business, facts, voice, [workspace], keywordRows] = await Promise.all([
    repo.getBusiness(database, ctx, article.businessId), repo.listFacts(database, ctx, article.businessId),
    repo.getActiveVoice(database, ctx, article.businessId),
    database.select({ settings: workspaces.settings }).from(workspaces).where(eq(workspaces.id, ctx.workspaceId)).limit(1),
    article.topicId ? database.select({ term: keywords.term }).from(topics)
      .leftJoin(keywords, and(eq(keywords.id, topics.primaryKeywordId), eq(keywords.workspaceId, ctx.workspaceId), eq(keywords.businessId, article.businessId)))
      .where(and(eq(topics.id, article.topicId), eq(topics.workspaceId, ctx.workspaceId), eq(topics.businessId, article.businessId))).limit(1) : Promise.resolve([]),
  ]);
  const preview = await previewScoreImprovements(getGateway(), ctx, {
    business, facts, voice, article, primaryKeyword: keywordRows[0]?.term ?? article.title,
    currentScore: article.seoScore, minimumScore: workspace?.settings?.minSeoScoreToPublish ?? 70,
    gates: [], scoreComponents: [], suggestions: body.suggestions,
  });
  const latest = await repo.getArticle(database, ctx, id);
  if (latest.version !== article.version || latest.status !== article.status || latest.updatedAt.getTime() !== article.updatedAt.getTime()) throw stale();
  await repo.writeAudit(database, ctx, { action: "article.score_improvements_previewed", entityType: "article", entityId: id,
    after: { version: article.version, count: preview.changes.length, changed: preview.changes.filter(change => change.changed).length } });
  return { ok: true, expectedVersion: article.version, ...preview };
}, { rateLimit: { limit: 30, windowSeconds: 3600 } });

const stale = () => new AppError("conflict", "The draft or its checks changed. Request fresh suggestions before preparing these changes.", { retryable: false });
