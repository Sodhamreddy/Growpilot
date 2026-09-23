import type { TenantContext } from "@ob/core";
import type { Gateway } from "@ob/ai";
import { composeSystemPrompt, BASE_SAFETY, PROMPT_VERSIONS } from "@ob/ai";
import {
  VOICE_EXTRACTION_JSON_SCHEMA, DEFAULT_BANNED_TERMS, DEFAULT_VOICE_PROFILE,
  voiceProfileSchema, type VoiceProfile,
} from "@ob/voice";
import type { CrawledPage } from "@ob/seo";

/**
 * Brand voice extraction — spec §18.2.
 *
 * "Website/content samples → clean text → classify writing patterns →
 *  generate initial voice profile → show profile to customer → customer edits
 *  → save approved voice."
 *
 * This function covers the first three steps and stops. The profile it returns
 * is a DRAFT: it is never marked active, because §18.2 requires the customer to
 * review and approve it first.
 */

export interface ExtractedVoice {
  profile: VoiceProfile;
  bannedTerms: string[];
  preferredTerms: { use: string; insteadOf?: string }[];
  samples: { sourceUrl?: string; text: string }[];
  rationale: string;
}

const VOICE_RULES = `
You are a brand-voice analyst. You are given real copy from a business's own
website. Describe HOW this business writes, not what it sells.

Analyse:
- Tone and its intensity.
- Formality.
- Sentence style and typical length.
- Point of view (do they say "we", "you", or name themselves?).
- Emotional register.
- How they phrase calls to action.
- Vocabulary they clearly prefer (their own term for a service, a customer, a process).
- Spelling convention (US, UK, Australian or Indian English).
- Formatting habits: headings, bullets, examples.

Rules:
- Report only patterns you can see in the supplied copy.
- "preferredTerms" must be the business's own words, taken from the copy.
- "bannedTerms" is for claims this business should not make. Suggest terms only
  when the copy suggests a regulated or sensitive domain.
- Do not describe the business's products or services. That is not voice.
`.trim();

export async function extractBrandVoice(
  gateway: Gateway,
  ctx: TenantContext,
  pages: CrawledPage[],
): Promise<ExtractedVoice> {
  const samples = selectSamples(pages);

  if (samples.length === 0) {
    // No usable prose — return the neutral default rather than guessing.
    return {
      profile: DEFAULT_VOICE_PROFILE,
      bannedTerms: [...DEFAULT_BANNED_TERMS],
      preferredTerms: [],
      samples: [],
      rationale: "The site had too little prose to analyse. A neutral default profile was created; edit it in Voice Settings.",
    };
  }

  const evidence = samples
    .map((s, i) => `--- sample ${i + 1} (${s.sourceUrl}) ---\n${s.text}`)
    .join("\n\n");

  const { system, cacheablePrefixLength } = composeSystemPrompt({
    systemRules: VOICE_RULES,
    safety: BASE_SAFETY,
    sourceEvidence: evidence,
    task: "Produce the brand voice profile for this business from the samples above.",
    outputFormat: "Return only JSON conforming to the schema.",
  });

  const res = await gateway.generate(ctx, {
    taskAlias: "structured_json",
    system,
    cacheableSystemPrefixLength: cacheablePrefixLength,
    messages: [{ role: "user", content: "Analyse the writing style and return the profile." }],
    schema: VOICE_EXTRACTION_JSON_SCHEMA as unknown as Record<string, unknown>,
    promptVersion: PROMPT_VERSIONS.voiceExtraction,
  });

  return normalizeVoice(res.parsed, samples);
}

/**
 * Pick representative prose. Spec §18.1 wants "approved examples" — pages that
 * represent the desired voice — so this favours About and Services copy over
 * legal boilerplate, which is written by lawyers rather than by the brand.
 */
function selectSamples(pages: CrawledPage[]): { sourceUrl: string; text: string }[] {
  const preference = ["about", "home", "services", "product", "blog", "faq", "contact"];

  return pages
    .filter((p) => p.pageType !== "legal" && p.wordCount >= 120)
    .sort((a, b) => {
      const ai = preference.indexOf(a.pageType);
      const bi = preference.indexOf(b.pageType);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    })
    .slice(0, 6)
    .map((p) => ({ sourceUrl: p.url, text: p.text.slice(0, 2500) }));
}

function normalizeVoice(
  parsed: unknown,
  samples: { sourceUrl: string; text: string }[],
): ExtractedVoice {
  const fallback: ExtractedVoice = {
    profile: DEFAULT_VOICE_PROFILE,
    bannedTerms: [...DEFAULT_BANNED_TERMS],
    preferredTerms: [],
    samples: samples.slice(0, 5),
    rationale: "The voice analysis returned an unexpected shape; a neutral default was used.",
  };

  if (!parsed || typeof parsed !== "object") return fallback;
  const raw = parsed as Record<string, unknown>;

  // Validate against the profile schema. A partially valid response falls back
  // field by field rather than discarding the whole analysis.
  const candidate = {
    tone: raw["tone"],
    toneIntensity: raw["toneIntensity"],
    formality: raw["formality"],
    sentenceStyle: raw["sentenceStyle"],
    pointOfView: raw["pointOfView"],
    emotionalStyle: raw["emotionalStyle"],
    ctaStyle: raw["ctaStyle"],
    spelling: raw["spelling"],
    formattingHabits: raw["formattingHabits"],
  };

  const validated = voiceProfileSchema.safeParse(candidate);
  const profile: VoiceProfile = validated.success
    ? validated.data
    : { ...DEFAULT_VOICE_PROFILE, ...pickValid(candidate) };

  // The model's suggestions are additive; the universal banned list always applies.
  const modelBanned = Array.isArray(raw["bannedTerms"])
    ? (raw["bannedTerms"] as unknown[]).filter((t): t is string => typeof t === "string" && t.trim() !== "")
    : [];
  const bannedTerms = [...new Set([...DEFAULT_BANNED_TERMS, ...modelBanned.map((t) => t.trim().toLowerCase())])];

  const preferredTerms = Array.isArray(raw["preferredTerms"])
    ? (raw["preferredTerms"] as Record<string, unknown>[])
        .filter((t) => typeof t["use"] === "string" && t["use"].trim() !== "")
        .map((t) => ({
          use: String(t["use"]).trim(),
          ...(typeof t["insteadOf"] === "string" && t["insteadOf"].trim() !== ""
            ? { insteadOf: String(t["insteadOf"]).trim() }
            : {}),
        }))
    : [];

  return {
    profile,
    bannedTerms,
    preferredTerms,
    samples: samples.slice(0, 5),
    rationale: typeof raw["rationale"] === "string" ? raw["rationale"] : "",
  };
}

/** Keep only the fields that individually satisfy the profile schema. */
function pickValid(candidate: Record<string, unknown>): Partial<VoiceProfile> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(candidate)) {
    const single = voiceProfileSchema.shape[key as keyof VoiceProfile];
    if (single && single.safeParse(value).success) out[key] = value;
  }
  return out as Partial<VoiceProfile>;
}
