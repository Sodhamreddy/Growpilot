import { requireTenant } from "@/lib/auth";
import { db } from "@/lib/services";
import { and, eq, ne, asc, desc, sql } from "drizzle-orm";
import { repo, topics, keywords, integrations, articles, auditLogs, users, publishJobs } from "@ob/db";
import { publishStatusView } from "@/lib/publish-status";
import { loadSignOffs, loadTeamSetup, reviewProcessFor, teamReviewView } from "@/lib/team-review-server";
import { splitSections } from "@ob/blog";
import { containsKeyphrase, countKeyphrase } from "@ob/core";
import { ArticleReviewWorkspace } from "@/components/ArticleReviewWorkspace";
import { currentBlogAccess } from "@/lib/blog-access-server";

export const dynamic = "force-dynamic";

const ACTIVITY_LIMIT = 50;

export default async function ArticlePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireTenant();
  const { id } = await params;
  const database = db();
  const article = await repo.getArticle(database, ctx, id);
  const [gates, connected, next, score, activity, [delivery], reviewProcess, access] = await Promise.all([
    repo.listGateResults(database, ctx, id, article.version),
    database.select({ provider: integrations.provider }).from(integrations).where(and(
      eq(integrations.workspaceId, ctx.workspaceId), eq(integrations.scopeKey, article.businessId),
      eq(integrations.provider, "wordpress"), eq(integrations.status, "connected"))).limit(1),
    database.select({ id: articles.id }).from(articles).where(and(
      eq(articles.workspaceId, ctx.workspaceId), eq(articles.businessId, article.businessId),
      ne(articles.id, article.id), eq(articles.status, "awaiting_approval"))).orderBy(asc(articles.createdAt)).limit(1),
    repo.getScore(database, ctx, id, article.version),
    // This article's audit trail: the same records the workspace home page shows, narrowed to one article.
    database.select({ id: auditLogs.id, action: auditLogs.action, actorId: auditLogs.actorId, actorType: auditLogs.actorType,
      after: auditLogs.after, createdAt: auditLogs.createdAt, actorName: users.name, actorEmail: users.email })
      .from(auditLogs).leftJoin(users, sql`${users.id}::text = ${auditLogs.actorId}`)
      .where(and(eq(auditLogs.workspaceId, ctx.workspaceId), eq(auditLogs.entityType, "article"), eq(auditLogs.entityId, id)))
      .orderBy(desc(auditLogs.createdAt)).limit(ACTIVITY_LIMIT),
    // The latest WordPress delivery: publishing creates a draft there, which the page links to.
    database.select({ status: publishJobs.status, articleVersion: publishJobs.articleVersion, externalId: publishJobs.externalId,
      externalUrl: publishJobs.externalUrl, lastError: publishJobs.lastError }).from(publishJobs)
      .where(and(eq(publishJobs.workspaceId, ctx.workspaceId), eq(publishJobs.entityType, "article"), eq(publishJobs.entityId, id)))
      .orderBy(desc(publishJobs.createdAt)).limit(1),
    reviewProcessFor(database, ctx),
    currentBlogAccess(),
  ]);
  // Team review: who signed off each level of this version, and what the viewer may do next.
  const setup = reviewProcess === "team" ? await loadTeamSetup(database, ctx) : null;
  const teamReview = setup?.process === "team" ? teamReviewView({
    article, setup, signOffs: await loadSignOffs(database, ctx, [id]), actor: { userId: ctx.userId, role: ctx.role },
    delivered: delivery?.status === "succeeded" && delivery.articleVersion === article.version,
  }) : null;
  const [topic] = article.topicId ? await database.select({ keywordId: topics.primaryKeywordId, secondaryTerms: topics.secondaryTerms }).from(topics)
    .where(and(eq(topics.workspaceId, ctx.workspaceId), eq(topics.id, article.topicId))).limit(1) : [];
  const [keyword] = topic?.keywordId ? await database.select({ term: keywords.term, volume: keywords.volume, intent: keywords.intent })
    .from(keywords).where(and(eq(keywords.workspaceId, ctx.workspaceId), eq(keywords.id, topic.keywordId))).limit(1) : [];

  // Only actual links in the saved draft contribute to the sources count.
  const sources = [...new Map([...article.bodyMarkdown.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gi)]
    .map((match) => [match[2]!, { title: match[1]!, url: match[2]! }] as const)).values()];
  const canEdit = ["owner", "admin", "editor"].includes(ctx.role);
  const primary = keyword?.term.trim().toLowerCase();
  // Measured exactly as the SEO score measures it, so the checklist and the score agree.
  const keywordUse = keyword ? {
    inSeoTitle: containsKeyphrase(article.metaTitle?.trim() || article.title, keyword.term),
    inMetaDescription: containsKeyphrase(article.metaDescription, keyword.term),
    inTitle: containsKeyphrase(article.title, keyword.term),
    bodyCount: countKeyphrase(article.bodyMarkdown, keyword.term),
  } : null;
  const secondaryKeywords = [...new Set((topic?.secondaryTerms ?? []).map((term) => term.trim()).filter((term) => term && term.toLowerCase() !== primary))].slice(0, 8);

  return <ArticleReviewWorkspace key={`${article.id}:${article.version}:${article.status}`}
    article={{ id: article.id, title: article.title, slug: article.slug, metaTitle: article.metaTitle,
      metaDescription: article.metaDescription, bodyMarkdown: article.bodyMarkdown, status: article.status,
      version: article.version, wordCount: article.wordCount, seoScore: article.seoScore,
      createdAt: article.createdAt.toISOString(), publishedUrl: article.publishedUrl }}
    keyword={keyword ?? null} keywordUse={keywordUse} secondaryKeywords={secondaryKeywords} sources={sources}
    sections={splitSections(article.bodyMarkdown).map((section) => ({ id: section.id, heading: section.heading, level: section.level }))}
    gates={gates.map((gate) => ({ gate: gate.gate, verdict: gate.verdict, findings: gate.findings }))}
    scoreBreakdown={(score?.components ?? []).map((part) => ({ key: part.key, label: part.label, weight: part.weight, score: part.score, reasons: part.reasons.slice(0, 2) }))}
    activity={activity.map((entry) => {
      const after = entry.after && typeof entry.after === "object" ? entry.after as Record<string, unknown> : {};
      const actor = entry.actorType !== "user" ? "GrowPilot" : entry.actorId === ctx.userId ? "You"
        : entry.actorName?.trim() || entry.actorEmail?.split("@")[0] || "A teammate";
      return { id: entry.id, action: entry.action, actor, at: entry.createdAt.toISOString(),
        version: typeof after["version"] === "number" ? after["version"] : null,
        note: typeof after["note"] === "string" && after["note"].trim() ? after["note"].trim().slice(0, 600) : null };
    })} activityLimit={ACTIVITY_LIMIT}
    canEdit={canEdit} canReview={canEdit} teamReview={teamReview}
    blogOnly={access.blogOnly} teamRole={access.teamLabel}
    canPublish={teamReview ? teamReview.can.publish : ctx.role === "owner" || ctx.role === "admin"}
    publishTarget={connected[0]?.provider ?? null} delivery={delivery ? publishStatusView(delivery) : null} nextArticleId={next[0]?.id ?? null} />;
}
