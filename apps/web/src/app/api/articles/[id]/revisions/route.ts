export const dynamic = "force-dynamic";

import { and, desc, eq } from "drizzle-orm";
import { AppError } from "@ob/core";
import { articleRevisions, repo } from "@ob/db";
import { route } from "@/lib/api";
import { db } from "@/lib/services";

export const GET = route(async (ctx, req) => {
  const url = new URL(req.url);
  const segments = url.pathname.split("/");
  const id = segments[segments.indexOf("articles") + 1] ?? "";
  const database = db();
  await repo.getArticle(database, ctx, id);
  const scope = and(eq(articleRevisions.workspaceId, ctx.workspaceId), eq(articleRevisions.articleId, id));
  const version = url.searchParams.get("version");
  if (version !== null) {
    if (!/^\d+$/.test(version) || !Number.isSafeInteger(Number(version))) {
      throw new AppError("validation_failed", "Choose a valid version.", { retryable: false });
    }
    const [revision] = await database.select().from(articleRevisions)
      .where(and(scope, eq(articleRevisions.version, Number(version)))).limit(1);
    if (!revision) throw new AppError("not_found", "That saved version is unavailable.", { retryable: false });
    return { revision };
  }
  const revisions = await database.select({ version: articleRevisions.version, title: articleRevisions.title,
    authoredBy: articleRevisions.authoredBy, createdAt: articleRevisions.createdAt }).from(articleRevisions)
    .where(scope).orderBy(desc(articleRevisions.version)).limit(100);
  return { revisions };
});
