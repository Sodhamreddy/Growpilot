import { z } from "zod";

export const scoreImprovementSuggestionSchema = z.object({
  id: z.string().min(1).max(80), title: z.string().trim().min(1).max(120), reason: z.string().trim().min(1).max(700),
  priority: z.enum(["high", "medium", "low"]), target: z.enum(["title", "metaTitle", "metaDescription", "section"]),
  sectionId: z.string().min(1).max(8).optional(), instruction: z.string().trim().min(3).max(1000).optional(),
  value: z.string().trim().min(1).max(200).optional(),
}).superRefine((suggestion, ctx) => {
  if (suggestion.target === "section") {
    if (!suggestion.sectionId || !suggestion.instruction || suggestion.value !== undefined) {
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
});
