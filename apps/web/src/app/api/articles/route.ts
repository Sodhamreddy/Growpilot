export const dynamic = "force-dynamic";

import { z } from "zod";
import { requireRole, slugify } from "@ob/core";
import { articles, repo } from "@ob/db";
import { route, parseBody } from "@/lib/api";
import { db } from "@/lib/services";

/** GET /api/articles · POST /api/articles */

export const GET = route(async (ctx, req) => {
  const url = new URL(req.url);
  const status = url.searchParams.getAll("status");
  const rows = await repo.listArticles(db(), ctx, {
    ...(status.length ? { status: status as never } : {}),
    limit: Math.min(100, Number(url.searchParams.get("limit") ?? 50)),
  });

  return {
    articles: rows.map((a) => ({
      id: a.id,
      title: a.title,
      slug: a.slug,
      status: a.status,
      version: a.version,
      seoScore: a.seoScore,
      voiceScore: a.voiceScore,
      wordCount: a.wordCount,
      updatedAt: a.updatedAt,
      publishedUrl: a.publishedUrl,
    })),
  };
});

const createSchema = z.object({
  businessId: z.string().uuid(),
  title: z.string().min(3, "Give the article a title.").max(300),
  topicId: z.string().uuid().optional(),
});

export const POST = route(async (ctx, req) => {
  requireRole(ctx, "editor");
  const body = await parseBody(req, createSchema);
  const database = db();

  // Confirms the business belongs to this workspace before anything is written.
  await repo.getBusiness(database, ctx, body.businessId);

  const [article] = await database
    .insert(articles)
    .values({
      workspaceId: ctx.workspaceId,
      businessId: body.businessId,
      topicId: body.topicId ?? null,
      title: body.title,
      slug: `${slugify(body.title) || "article"}-${Date.now().toString(36)}`,
      status: "draft",
    })
    .returning();

  await repo.writeAudit(database, ctx, {
    action: "article.created",
    entityType: "article",
    entityId: article!.id,
    after: { title: body.title },
  });

  return { article: { id: article!.id, title: article!.title, status: article!.status } };
});
