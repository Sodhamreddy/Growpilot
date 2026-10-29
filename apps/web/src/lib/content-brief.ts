import { z } from "zod";
import type { ContentBrief } from "@ob/db";

export const contentBriefSchema = z.object({
  angle: z.string().trim().min(1).max(3000),
  audience: z.string().trim().min(1).max(1000),
  searchIntent: z.string().trim().min(1).max(100),
  outline: z.array(z.object({ heading: z.string().trim().min(1).max(300), level: z.number().int().min(2).max(4), guidance: z.string().max(10000) })).min(1).max(14),
  mustCoverFacts: z.array(z.string().max(2000)).max(12),
  internalLinkTargets: z.array(z.object({ url: z.string().url().max(2000).refine(url => /^https?:\/\//i.test(url), "Use an HTTP or HTTPS link."), anchor: z.string().max(300) })).max(20),
  targetWordCount: z.number().int().min(400).max(4000),
  ctaGuidance: z.string().max(3000),
});

export const mustIncludeSchema = z.array(z.string().trim().min(1).max(500)).max(12);

/** Existing workers read outline guidance; keep user direction distinct from verified facts. */
export function withMustInclude(brief: ContentBrief, instructions: string[]): ContentBrief {
  if (!instructions.length) return brief;
  const [first, ...rest] = brief.outline;
  if (!first) return brief;
  return { ...brief, outline: [{ ...first, guidance: [first.guidance,
    "User's must-include editorial requirements (not independently verified facts):",
    ...instructions.map(item => `- ${item}`),
    "Do not invent evidence for these requirements. Flag unsupported claims for review.",
  ].join("\n") }, ...rest] };
}
