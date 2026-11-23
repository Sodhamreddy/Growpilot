import { z } from "zod";

export const scoreImprovementSuggestionSchema = z.object({
  id: z.string().min(1).max(80), title: z.string().trim().min(1).max(120), reason: z.string().trim().min(1).max(700),
  priority: z.enum(["high", "medium", "low"]), target: z.enum(["title", "metaTitle", "metaDescription", "section", "article"]),
  checks: z.array(z.enum(["seo", "brand", "facts", "readability", "links", "conversion", "risk", "publishing"])).max(8).optional(),
  sectionId: z.string().min(1).max(8).optional(), instruction: z.string().trim().min(3).max(3000).optional(),
  value: z.string().trim().min(1).max(200).optional(),
}).superRefine((suggestion, ctx) => {
  if (suggestion.target === "article") {
    if (!suggestion.instruction || suggestion.sectionId !== undefined || suggestion.value !== undefined) {
      ctx.addIssue({ code: "custom", message: "An article improvement needs an instruction without a section or metadata value." });
    }
    return;
  }
  if (suggestion.target === "section") {
    if (!suggestion.sectionId || !suggestion.instruction || suggestion.instruction.length > 1000 || suggestion.value !== undefined) {
      ctx.addIssue({ code: "custom", message: "A section suggestion needs an existing section and an instruction." });
    }
    return;
  }
  const max = suggestion.target === "metaTitle" ? 70 : suggestion.target === "metaDescription" ? 160 : 200;
  if (!suggestion.value || suggestion.value.length > max || suggestion.sectionId !== undefined || suggestion.instruction !== undefined) {
    ctx.addIssue({ code: "custom", message: "A metadata suggestion needs a bounded replacement value." });
  }
});

export const scoreImprovementPlanSchema = z.object({
  summary: z.string().trim().min(1).max(1500), suggestions: z.array(scoreImprovementSuggestionSchema).max(8),
  followUps: z.array(z.object({ area: z.enum(["seo", "brand", "facts", "readability", "links", "conversion", "risk", "publishing"]),
    message: z.string().trim().min(1).max(500), action: z.string().trim().min(1).max(500) })).max(8).optional(),
}).superRefine((plan, ctx) => {
  if (plan.suggestions.some(suggestion => suggestion.target === "article") && plan.suggestions.some(suggestion => suggestion.target === "section")) {
    ctx.addIssue({ code: "custom", message: "Whole-article improvements cannot overlap individual section changes." });
  }
});
