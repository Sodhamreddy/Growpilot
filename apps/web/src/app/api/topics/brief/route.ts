export const dynamic = "force-dynamic";

import { z } from "zod";
import { and, eq, asc } from "drizzle-orm";
import { AppError, requireRole } from "@ob/core";
import { repo, sourcePages, businessSources, keywords } from "@ob/db";
import { generateBrief } from "@ob/blog";
import { retrieve } from "@ob/kb";
import { route, parseBody } from "@/lib/api";
import { db, getGateway } from "@/lib/services";
import { contentBriefSchema } from "@/lib/content-brief";

const schema = z.object({
  businessId: z.string().uuid(), title: z.string().trim().min(4).max(200),
  primaryKeyword: z.string().trim().min(2).max(120),
  intent: z.enum(["informational", "commercial", "transactional", "local"]),
  rationale: z.string().max(1000).optional(),
  instructions: z.string().trim().max(4000).optional(),
  previousBrief: contentBriefSchema.optional(),
});

export const POST = route(async (ctx, req) => {
  requireRole(ctx, "editor");
  const body = await parseBody(req, schema);
  const database = db();
  const business = await repo.getBusiness(database, ctx, body.businessId);
  if (!business.confirmedAt) throw new AppError("validation_failed", "Confirm the business profile before preparing a brief.");
  const facts = await repo.listFacts(database, ctx, business.id);
  if (!facts.some(fact => fact.key === "service")) throw new AppError("validation_failed", "Add at least one service before preparing a brief.");
  const gateway = getGateway();
  const [evidence, pages, [keyword]] = await Promise.all([
    retrieve(database, gateway, ctx, { businessId: business.id, query: `${body.title} ${body.primaryKeyword}`, limit: 8 }),
    database.select({ url: sourcePages.url, title: sourcePages.title }).from(sourcePages)
      .innerJoin(businessSources, eq(businessSources.id, sourcePages.sourceId))
      .where(and(eq(sourcePages.workspaceId, ctx.workspaceId), eq(businessSources.workspaceId, ctx.workspaceId), eq(businessSources.businessId, business.id)))
      .orderBy(asc(sourcePages.url)).limit(40),
    database.select({ term: keywords.term, volume: keywords.volume, intent: keywords.intent }).from(keywords)
      .where(and(eq(keywords.workspaceId, ctx.workspaceId), eq(keywords.businessId, business.id), eq(keywords.term, body.primaryKeyword.toLowerCase())))
      .orderBy(asc(keywords.location)).limit(1),
  ]);
  const brief = await generateBrief(gateway, ctx, {
    business, facts, evidence, topicTitle: body.title, primaryKeyword: body.primaryKeyword,
    secondaryKeywords: [], intent: body.intent,
    internalLinkCandidates: pages.filter(page => /^https?:\/\//i.test(page.url)).map(page => ({ url: page.url, title: page.title ?? page.url })),
    instructions: [business.prompts?.blog?.article, body.rationale ? `Suggested angle: ${body.rationale}` : "", body.instructions].filter(Boolean).join("\n\n"),
    ...(body.previousBrief ? { previousBrief: body.previousBrief } : {}),
  });
  const sources = new Map<string, { url: string; title: string }>();
  for (const item of evidence) {
    if (item.sourceUrl && /^https?:\/\//i.test(item.sourceUrl)) sources.set(item.sourceUrl, { url: item.sourceUrl, title: item.heading || item.sourceUrl });
  }
  for (const fact of facts) {
    if (fact.sourceUrl && /^https?:\/\//i.test(fact.sourceUrl) && !sources.has(fact.sourceUrl)) sources.set(fact.sourceUrl, { url: fact.sourceUrl, title: pages.find(page => page.url === fact.sourceUrl)?.title || fact.sourceUrl });
  }
  await repo.writeAudit(database, ctx, { action: "topic.brief_previewed", entityType: "business", entityId: business.id,
    after: { title: body.title, refined: Boolean(body.previousBrief) } });
  return { ok: true, brief: contentBriefSchema.parse(brief), sources: [...sources.values()],
    keyword: { term: body.primaryKeyword, volume: keyword?.volume ?? null, intent: keyword?.intent ?? body.intent } };
}, { rateLimit: { limit: 30, windowSeconds: 3600 } });
