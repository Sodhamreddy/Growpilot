import { requireTenant } from "@/lib/auth";
import { db } from "@/lib/services";
import { and, eq, ne, asc } from "drizzle-orm";
import { repo, topics, keywords, integrations, articles } from "@ob/db";
import { splitSections } from "@ob/blog";
import { ArticleReviewWorkspace } from "@/components/ArticleReviewWorkspace";

export const dynamic = "force-dynamic";

export default async function ArticlePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireTenant();
  const { id } = await params;
  const database = db();
  const article = await repo.getArticle(database, ctx, id);
  const [gates, connected, next] = await Promise.all([
    repo.listGateResults(database, ctx, id, article.version),
    database.select({ provider: integrations.provider }).from(integrations).where(and(
      eq(integrations.workspaceId, ctx.workspaceId), eq(integrations.scopeKey, article.businessId),
      eq(integrations.provider, "wordpress"), eq(integrations.status, "connected"))).limit(1),
    database.select({ id: articles.id }).from(articles).where(and(
      eq(articles.workspaceId, ctx.workspaceId), eq(articles.businessId, article.businessId),
      ne(articles.id, article.id), eq(articles.status, "awaiting_approval"))).orderBy(asc(articles.createdAt)).limit(1),
  ]);
  const [topic] = article.topicId ? await database.select({ keywordId: topics.primaryKeywordId }).from(topics)
    .where(and(eq(topics.workspaceId, ctx.workspaceId), eq(topics.id, article.topicId))).limit(1) : [];
  const [keyword] = topic?.keywordId ? await database.select({ term: keywords.term, volume: keywords.volume, intent: keywords.intent })
    .from(keywords).where(and(eq(keywords.workspaceId, ctx.workspaceId), eq(keywords.id, topic.keywordId))).limit(1) : [];

  // Only actual links in the saved draft contribute to the sources count.
  const sources = [...new Map([...article.bodyMarkdown.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gi)]
    .map((match) => [match[2]!, { title: match[1]!, url: match[2]! }] as const)).values()];
  const canEdit = ["owner", "admin", "editor"].includes(ctx.role);

  return <ArticleReviewWorkspace key={`${article.id}:${article.version}:${article.status}`}
    article={{ id: article.id, title: article.title, slug: article.slug, metaTitle: article.metaTitle,
      metaDescription: article.metaDescription, bodyMarkdown: article.bodyMarkdown, status: article.status,
      version: article.version, wordCount: article.wordCount, seoScore: article.seoScore,
      createdAt: article.createdAt.toISOString(), publishedUrl: article.publishedUrl }}
    keyword={keyword ?? null} sources={sources}
    sections={splitSections(article.bodyMarkdown).map((section) => ({ id: section.id, heading: section.heading, level: section.level }))}
    gates={gates.map((gate) => ({ gate: gate.gate, verdict: gate.verdict, findings: gate.findings }))}
    canEdit={canEdit} canReview={canEdit} canPublish={ctx.role === "owner" || ctx.role === "admin"}
    publishTarget={connected[0]?.provider ?? null} nextArticleId={next[0]?.id ?? null} />;
}
