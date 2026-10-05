import type { TenantContext } from "@ob/core";
import type { Gateway } from "@ob/ai";
import type { ReviewReplyDraft } from "@ob/db";
import { composeSystemPrompt, BASE_SAFETY, renderBusinessFacts, PROMPT_VERSIONS } from "@ob/ai";
import { renderVoiceLayer, type RenderVoiceInput } from "@ob/voice";
import { REPLY_BLOCKLIST_PATTERNS, type ReviewRating } from "./rules.js";

/**
 * Drafting a reply to one Google review, in the brand's voice.
 *
 * A reply is a public statement by the business, read by every future
 * customer who looks at the listing, so the rules lean hard towards saying
 * less: nothing the reviewer did not say, nothing that confirms they were a
 * customer or patient, no offers, no arguments. The draft is only ever a
 * draft; a person approves it before anything is posted.
 */

/** Google Business Profile's own limit on a reply. */
export const REPLY_CHAR_LIMIT = 4096;

const TOPICS: { re: RegExp; what: string }[] = [
  { re: REPLY_BLOCKLIST_PATTERNS[0]!, what: "legal action" },
  { re: REPLY_BLOCKLIST_PATTERNS[1]!, what: "an injury or safety concern" },
  { re: REPLY_BLOCKLIST_PATTERNS[2]!, what: "discrimination or harassment" },
  { re: REPLY_BLOCKLIST_PATTERNS[3]!, what: "fraud, theft or the police" },
  { re: REPLY_BLOCKLIST_PATTERNS[4]!, what: "a death" },
];

/**
 * Why a person must write this reply, or null when a draft may be generated.
 *
 * Mirrors `requiresHumanReply` and says which rule applied, because "a
 * person should reply" without a reason reads as the tool being broken.
 */
export function humanReplyReason(comment: string | null, rating: ReviewRating): string | null {
  const hit = comment ? TOPICS.find((t) => t.re.test(comment)) : undefined;
  if (hit) {
    return `This review mentions ${hit.what}. A reply is a public statement by the business, so a person should write this one, not the AI.`;
  }
  if (rating === 1 && comment?.trim()) {
    return "One-star complaints deserve a personal reply. Write it yourself; a generated apology reads as exactly the wrong thing.";
  }
  return null;
}

/** "Priya" from "Priya Raman"; nothing from "A Google user" or an unreadable handle. */
export function firstName(authorName: string): string | null {
  const first = authorName.trim().split(/\s+/)[0] ?? "";
  if (!first || /^a$/i.test(first) || /google user/i.test(authorName)) return null;
  return /^\p{L}[\p{L}'.-]{0,30}$/u.test(first) ? first : null;
}

const REPLY_RULES = `
You write the business owner's public reply to one Google review.

WHO IS SPEAKING
The business, in the first person plural ("we", "our team"). Never sign with a
person's name or title unless the brand voice says to.

LENGTH
A review with words: 25 to 90 words. A rating with no words: 10 to 35 words.
Plain text only. No emojis, hashtags, links or quotation of the review.
No dashes of any kind; use commas or full stops instead.

BY RATING
5 or 4 stars: thank them for one specific thing they mentioned, in your own
words. A light, natural invitation to return is fine. No sales pitch.
3 stars: thank them, acknowledge the specific issue plainly, say the team will
look at it, invite them to get in touch directly.
2 stars, or 1 star with no words: a sincere apology for their experience that
admits no fault or liability, no argument and no excuses, and an invitation
to contact the business directly so it can be put right.

PRIVACY, NON-NEGOTIABLE
Never confirm or imply that the reviewer is or was a customer, client or
patient beyond what they wrote themselves. Never mention appointments, visits,
treatments, conditions, medicines, prices, orders or staff names unless the
reviewer mentioned them first, and even then do not add detail.

NEVER
Invent facts, policies, offers or promises. Offer discounts, refunds or
anything in exchange for a review or for changing one. Ask them to edit or
remove the review. Copy phrases from the review back word for word.

ADDRESSING THEM
Use their first name once, at the start, when one is given. Otherwise no name.

LANGUAGE
Write in the same language as the review.
`.trim();

const REPLY_SCHEMA = {
  type: "object",
  properties: { reply: { type: "string", description: "The reply text, ready to post." } },
  required: ["reply"],
  additionalProperties: false,
} as const;

export interface ReplyInput {
  business: { name: string; industry: string | null; audience: string | null; usp: string | null };
  /** The name customers see on Google, which the reply should use. */
  listingName: string;
  facts: { key: string; value: string; sourceUrl?: string | null; confidence: number; verified: boolean }[];
  /** How to reach the business, for replies that invite contact. */
  contact: string | null;
  voice: Omit<RenderVoiceInput, "channel"> | null;
  wordsToAvoid: string[];
  review: { authorName: string; rating: ReviewRating; comment: string | null; languageCode: string | null };
}

/** Enforce what can be enforced after the model: dashes, spacing, the length Google accepts. */
export function normaliseReply(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\s*[‒-―]\s*/g, ", ")
    .replace(/[ \t]+/g, " ")
    .replace(/ ,/g, ",")
    .replace(/,\s*,/g, ",")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, REPLY_CHAR_LIMIT);
}

/**
 * A draft for one review.
 *
 * Reviews a person must answer get no generated text at all, only the
 * reason, so an empty box is never mistaken for a failed generation.
 */
export async function draftReviewReply(gateway: Gateway, ctx: TenantContext, input: ReplyInput): Promise<ReviewReplyDraft> {
  const now = new Date().toISOString();
  const withheld = humanReplyReason(input.review.comment, input.review.rating);
  if (withheld) {
    return { body: "", status: "draft", requiresHumanEdit: true, withheldReason: withheld, edited: false, createdAt: now, updatedAt: now };
  }

  const banned = [...new Set([...(input.voice?.bannedTerms ?? []), ...input.wordsToAvoid])];
  const name = firstName(input.review.authorName);
  const { system, cacheablePrefixLength } = composeSystemPrompt({
    systemRules: REPLY_RULES,
    safety: BASE_SAFETY,
    businessFacts: [
      renderBusinessFacts(input.business, input.facts),
      `Name on Google: ${input.listingName}`,
      input.contact ? `How customers reach the business: ${input.contact}` : "No contact details on file: invite them to contact the business directly, without giving details.",
    ].join("\n"),
    brandVoice: input.voice
      ? renderVoiceLayer({ ...input.voice, bannedTerms: banned, channel: "review-reply" })
      : "No approved brand voice is on file. Write warmly, plainly and briefly.",
    task: [
      "THE REVIEW",
      `  stars     ${input.review.rating} of 5`,
      `  reviewer  ${name ? `first name ${name}` : "no usable name"}`,
      input.review.languageCode ? `  language  ${input.review.languageCode}` : "",
      input.review.comment ? `  text      ${input.review.comment.slice(0, 4000)}` : "  text      (a rating with no words)",
      banned.length && !input.voice ? `\nNever use these words: ${banned.join(", ")}` : "",
    ].filter(Boolean).join("\n"),
    outputFormat: "Return only JSON conforming to the provided schema. No prose, no code fences.",
  });

  const res = await gateway.generate(ctx, {
    taskAlias: "structured_json",
    system,
    cacheableSystemPrefixLength: cacheablePrefixLength,
    messages: [{ role: "user", content: "Write the reply now." }],
    schema: REPLY_SCHEMA as unknown as Record<string, unknown>,
    promptVersion: PROMPT_VERSIONS.reviewReply,
  });

  const body = normaliseReply(String((res.parsed as { reply?: unknown } | undefined)?.reply ?? res.text ?? ""));
  return {
    body, status: "draft", requiresHumanEdit: false, withheldReason: null, edited: false,
    model: res.model, createdAt: now, updatedAt: now,
  };
}
