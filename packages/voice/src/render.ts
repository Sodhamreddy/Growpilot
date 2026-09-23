import type { VoiceProfile } from "./profile.js";

/**
 * Render a voice profile as the BRAND VOICE prompt layer — spec §18.4.
 *
 * Critical property: this layer contains style rules ONLY. It must never
 * assert anything about the business, because the spec separates factual
 * context (BUSINESS FACTS) from stylistic instruction precisely so the model
 * cannot confuse the two.
 */

const TONE_GUIDANCE: Record<VoiceProfile["formality"], string> = {
  casual: "Write the way a knowledgeable colleague talks. Contractions are fine.",
  balanced: "Write plainly and professionally. Contractions are fine where natural.",
  formal: "Write formally. Avoid contractions, slang and colloquialisms.",
};

const SENTENCE_GUIDANCE: Record<VoiceProfile["sentenceStyle"], string> = {
  "short-direct": "Keep sentences short and declarative. One idea per sentence.",
  explanatory: "Explain reasoning as you go. Follow a claim with its justification.",
  narrative: "Carry the reader through with connected, flowing prose.",
  detailed: "Be thorough and specific. Include qualifying detail where it aids accuracy.",
};

const POV_GUIDANCE: Record<VoiceProfile["pointOfView"], string> = {
  "first-person": 'Refer to the business as "we" and "our".',
  "second-person": 'Address the reader directly as "you". Refer to the business as "we".',
  "third-person": "Refer to the business by name in the third person. Do not use \"we\" or \"you\".",
  "brand-led": "Lead with the brand name rather than pronouns.",
};

const CTA_GUIDANCE: Record<VoiceProfile["ctaStyle"], string> = {
  "soft-educational": "Close by inviting further reading or a low-commitment next step.",
  consultation: "Close by inviting the reader to book a consultation or conversation.",
  purchase: "Close by directing the reader to buy or start a purchase.",
  "direct-action": "Close with one clear, specific instruction.",
};

const SPELLING_GUIDANCE: Record<VoiceProfile["spelling"], string> = {
  "en-US": "Use US spelling and date conventions.",
  "en-GB": "Use UK spelling and date conventions.",
  "en-AU": "Use Australian spelling and date conventions.",
  "en-IN": "Use Indian English spelling and date conventions.",
};

export interface RenderVoiceInput {
  profile: VoiceProfile;
  bannedTerms: string[];
  preferredTerms: { use: string; insteadOf?: string }[];
  samples: { text: string }[];
  /** Per spec §18.6, voice adapts by channel while staying the same brand. */
  channel?: "article" | "linkedin" | "instagram" | "facebook" | "x" | "review-reply";
}

const CHANNEL_ADAPTATION: Record<NonNullable<RenderVoiceInput["channel"]>, string> = {
  article: "Channel: SEO article. Apply the full brand voice. Be explanatory and aligned to search intent.",
  linkedin: "Channel: LinkedIn. Lead with a professional insight. Keep the brand's expertise forward.",
  instagram: "Channel: Instagram. Be concise, visual and conversational. Shorter sentences than usual.",
  facebook: "Channel: Facebook. Be community-friendly and approachable. Explain plainly.",
  x: "Channel: X. Be direct, compact and insight-led. No filler.",
  "review-reply": "Channel: review reply. Be empathetic, factual and service-oriented. Never argue.",
};

export function renderVoiceLayer(input: RenderVoiceInput): string {
  const { profile } = input;
  const lines: string[] = [];

  lines.push("Apply these style rules. They govern HOW you write, never WHAT is true.");
  lines.push("");

  const intensity = profile.toneIntensity >= 0.7 ? "strongly" : profile.toneIntensity <= 0.3 ? "lightly" : "moderately";
  lines.push(`Tone: ${profile.tone.join(", ")} — expressed ${intensity}.`);
  lines.push(`Formality: ${TONE_GUIDANCE[profile.formality]}`);
  lines.push(`Sentences: ${SENTENCE_GUIDANCE[profile.sentenceStyle]}`);
  lines.push(`Target average sentence length: about ${profile.formattingHabits.avgSentenceWords} words.`);
  lines.push(`Point of view: ${POV_GUIDANCE[profile.pointOfView]}`);
  lines.push(`Emotional register: ${profile.emotionalStyle}.`);
  lines.push(`Call to action: ${CTA_GUIDANCE[profile.ctaStyle]}`);
  lines.push(`Spelling: ${SPELLING_GUIDANCE[profile.spelling]}`);

  const fmt: string[] = [];
  fmt.push(profile.formattingHabits.useHeadings ? "Use descriptive headings." : "Avoid headings.");
  fmt.push(profile.formattingHabits.useBullets ? "Bulleted lists are welcome where they aid scanning." : "Prefer prose over bullet lists.");
  if (profile.formattingHabits.useExamples) fmt.push("Include concrete examples.");
  lines.push(`Formatting: ${fmt.join(" ")}`);

  if (input.preferredTerms.length > 0) {
    lines.push("");
    lines.push("Preferred vocabulary:");
    for (const t of input.preferredTerms) {
      lines.push(t.insteadOf ? `- Say "${t.use}" rather than "${t.insteadOf}".` : `- Prefer the term "${t.use}".`);
    }
  }

  if (input.bannedTerms.length > 0) {
    lines.push("");
    lines.push("Never use these words or phrases, in any casing or inflection:");
    lines.push(input.bannedTerms.map((t) => `"${t}"`).join(", "));
  }

  if (profile.notes?.trim()) {
    lines.push("");
    lines.push(`Additional guidance from the customer: ${profile.notes.trim()}`);
  }

  if (input.channel) {
    lines.push("");
    lines.push(CHANNEL_ADAPTATION[input.channel]);
  }

  if (input.samples.length > 0) {
    lines.push("");
    lines.push("Approved writing samples. Match their rhythm and register, not their content:");
    input.samples.slice(0, 3).forEach((s, i) => {
      lines.push(`--- sample ${i + 1} ---`);
      lines.push(s.text.slice(0, 1200).trim());
    });
  }

  lines.push("");
  lines.push(
    "If a style rule above would require stating something the evidence does not support, " +
      "follow the evidence and ignore the style rule.",
  );

  return lines.join("\n");
}
