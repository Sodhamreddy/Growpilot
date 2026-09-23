import { z } from "zod";

/**
 * Brand voice profile — spec §18.3.
 *
 * Voice is stored as structured rules plus approved examples and retrieved at
 * generation time. It is explicitly NOT a per-customer fine-tuned model
 * (spec §18.8).
 */

export const voiceProfileSchema = z.object({
  tone: z.array(z.string().min(1)).min(1).max(5),
  toneIntensity: z.number().min(0).max(1),
  formality: z.enum(["casual", "balanced", "formal"]),
  sentenceStyle: z.enum(["short-direct", "explanatory", "narrative", "detailed"]),
  pointOfView: z.enum(["first-person", "second-person", "third-person", "brand-led"]),
  emotionalStyle: z.enum(["practical", "encouraging", "authoritative", "warm", "neutral"]),
  ctaStyle: z.enum(["soft-educational", "consultation", "purchase", "direct-action"]),
  spelling: z.enum(["en-US", "en-GB", "en-AU", "en-IN"]),
  formattingHabits: z.object({
    useHeadings: z.boolean(),
    useBullets: z.boolean(),
    avgSentenceWords: z.number().int().min(5).max(60),
    useExamples: z.boolean(),
  }),
  notes: z.string().max(2000).optional(),
});

export type VoiceProfile = z.infer<typeof voiceProfileSchema>;

export const preferredTermSchema = z.object({
  use: z.string().min(1).max(100),
  insteadOf: z.string().max(100).optional(),
});

export const voiceRulesSchema = z.object({
  profile: voiceProfileSchema,
  bannedTerms: z.array(z.string().min(1).max(100)).max(200),
  preferredTerms: z.array(preferredTermSchema).max(200),
  samples: z
    .array(z.object({ sourceUrl: z.string().url().optional(), text: z.string().min(50).max(5000) }))
    .max(10),
});

export type VoiceRules = z.infer<typeof voiceRulesSchema>;

/**
 * Terms that are unsafe for any business to claim. Seeded into every new voice
 * profile's banned list — spec §18.3 example row ("Guaranteed, #1, instant
 * results") and §15.1's risk gate.
 */
export const DEFAULT_BANNED_TERMS = [
  "guaranteed",
  "guarantee results",
  "#1",
  "number one",
  "best in the world",
  "instant results",
  "risk-free",
  "miracle",
  "cure",
  "100% effective",
  "unbeatable",
  "world-class leader",
] as const;

export const DEFAULT_VOICE_PROFILE: VoiceProfile = {
  tone: ["professional", "clear"],
  toneIntensity: 0.5,
  formality: "balanced",
  sentenceStyle: "explanatory",
  pointOfView: "second-person",
  emotionalStyle: "practical",
  ctaStyle: "consultation",
  spelling: "en-US",
  formattingHabits: {
    useHeadings: true,
    useBullets: true,
    avgSentenceWords: 18,
    useExamples: true,
  },
};

/** JSON Schema handed to the model for voice extraction (structured output). */
export const VOICE_EXTRACTION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["tone", "toneIntensity", "formality", "sentenceStyle", "pointOfView",
             "emotionalStyle", "ctaStyle", "spelling", "formattingHabits",
             "bannedTerms", "preferredTerms", "rationale"],
  properties: {
    tone: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 },
    toneIntensity: { type: "number", minimum: 0, maximum: 1 },
    formality: { type: "string", enum: ["casual", "balanced", "formal"] },
    sentenceStyle: { type: "string", enum: ["short-direct", "explanatory", "narrative", "detailed"] },
    pointOfView: { type: "string", enum: ["first-person", "second-person", "third-person", "brand-led"] },
    emotionalStyle: { type: "string", enum: ["practical", "encouraging", "authoritative", "warm", "neutral"] },
    ctaStyle: { type: "string", enum: ["soft-educational", "consultation", "purchase", "direct-action"] },
    spelling: { type: "string", enum: ["en-US", "en-GB", "en-AU", "en-IN"] },
    formattingHabits: {
      type: "object",
      additionalProperties: false,
      required: ["useHeadings", "useBullets", "avgSentenceWords", "useExamples"],
      properties: {
        useHeadings: { type: "boolean" },
        useBullets: { type: "boolean" },
        avgSentenceWords: { type: "integer", minimum: 5, maximum: 60 },
        useExamples: { type: "boolean" },
      },
    },
    bannedTerms: { type: "array", items: { type: "string" }, maxItems: 50 },
    preferredTerms: {
      type: "array",
      maxItems: 50,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["use"],
        properties: { use: { type: "string" }, insteadOf: { type: "string" } },
      },
    },
    rationale: { type: "string" },
  },
} as const;
