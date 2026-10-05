import type { TenantContext } from "@ob/core";
import type { Gateway } from "@ob/ai";
import type { SocialContentPack } from "@ob/db";
import {
  composeSystemPrompt, BASE_SYSTEM_RULES, BASE_SAFETY,
  renderBusinessFacts, PROMPT_VERSIONS,
} from "@ob/ai";
import { renderVoiceLayer, type RenderVoiceInput } from "@ob/voice";
import { stripDashes } from "./topics.js";
import {
  CAPTION_WORDS, CAPTION_CHAR_LIMIT, X_LIMIT, X_MIN, fitToX, hashtagsIn, ensureParagraphs, paragraphCount,
} from "./text.js";

/**
 * Content packs: the written post, for one scheduled topic at a time.
 *
 * The rules are Prompt 2 from monthly-timeline.md, which is the planner this
 * module replaces, with two measurements changed on review: the caption is
 * shorter (its 150 to 290 words read as essays), and the X post is the
 * caption's own message condensed rather than a separate idea, hashtags
 * included in X's 280. The numbers live in ./text.ts, shared with the editor.
 * They are checked afterwards rather than trusted: a model told a range
 * mostly complies, and "mostly" is what a reviewer needs to see.
 *
 * One post per call. A month in one request would be a single long wait with
 * nothing to read until the end, and one bad post would cost all of them.
 *
 * The image fields here are a brief for whoever makes the image. Generating
 * the image itself is the next step and is not done here.
 */

export interface PackInput {
  business: {
    name: string;
    industry: string | null;
    audience: string | null;
    usp: string | null;
    description: string | null;
  };
  facts: {
    key: string;
    value: string;
    sourceUrl?: string | null;
    confidence: number;
    verified: boolean;
  }[];
  locations: string[];
  /** The active brand voice, or null when none is approved yet. */
  voice: Omit<RenderVoiceInput, "channel"> | null;
  post: {
    title: string;
    /** The topic's argument, which the caption is written from. */
    hook: string;
    audience: string;
    format: string;
    occasion: string | null;
    /** How the observance's own date is derived, e.g. "always the 29th of October". */
    dateRule?: string | null;
    /** "YYYY-MM-DD". */
    date: string;
    imageIdea: string;
    categoryName: string;
  };
  /** The customer's own steering, layered on the built-in rules. */
  prompts: { post: string; image: string; reference: string; wordsToAvoid: string[] };
  /** "#46C8F5 (primary)", for the image brief. */
  brandColors: string[];
}

export interface PackResult {
  pack: SocialContentPack;
  warnings: string[];
}

const PACK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["caption", "shortCaption", "hashtags", "imageBrief", "altText", "formatExtra"],
  properties: {
    caption: { type: "string" },
    shortCaption: { type: "string" },
    hashtags: { type: "array", items: { type: "string" } },
    imageBrief: { type: "string" },
    altText: { type: "string" },
    formatExtra: { type: "string" },
  },
} as const;

const PACK_RULES = `${BASE_SYSTEM_RULES}

You are the social media copywriter for the brand described below. Write the
full content pack for ONE post.

VOICE
Open on a real moment the audience recognises. Never a greeting, never the
observance name, never "Did you know that".
Be specific where competitors are vague. Name the room, the hour, the number,
the exact sentence to say. Specificity is the whole brand.
Give reasons, not assertions. Every claim carries the because behind it.
Respect the reader's intelligence. Never pitying, never patronising, never
frightening anyone into making contact.
Close deliberately. Never trail off, never end on a hashtag, never end on a
question you leave unanswered.

NEVER WRITE LIKE AN AI
No "In today's world", "When it comes to", "Let's dive in", "It's important to
note that", "Navigating the journey of". If a line would work unchanged for a
competitor, rewrite it.

CTA
A specific next step where one genuinely fits. Never "Learn more", "Get in
touch", "Reach out today". Not every post needs one, and a forced CTA is worse
than none. A post about a service always closes on one, written situation
first: open on the worry the reader actually has, then show what changes for
them. Never list features.

ACCURACY, NON-NEGOTIABLE
A fabricated figure is the one mistake that cannot be walked back.
Never invent a statistic, study name, price, deadline or eligibility threshold.
If a figure is not in BUSINESS FACTS or the brief, describe the pattern in words.
No over-claims and no promised outcomes. Point professional decisions back to a
qualified professional. For anything urgent, the instruction is to seek
emergency help, never to wait.

PUNCTUATION, ABSOLUTE
Never use an em dash or an en dash anywhere, in any field. Use a period, a
colon, a comma, a semicolon or parentheses. Hyphens inside compound words are
correct. (These instructions are written without dashes on purpose. A model
imitates the punctuation it is shown.)

THE FIELDS, WITH THEIR MEASUREMENTS
caption       ${CAPTION_WORDS.min} to ${CAPTION_WORDS.max} words, 4 to 7 short paragraphs separated by
              blank lines, plain text, second person. ONE caption shared by
              Instagram, Facebook and LinkedIn, so nothing in it belongs to one
              network. One sentence paragraphs are good. In the JSON string,
              put "\\n\\n" between paragraphs; a caption with no breaks is one
              wall of text on a phone. No bullet characters, no markdown, no
              hashtags in the body.
shortCaption  The X post. The SAME message as the caption, condensed: the same
              point and the same next step, so someone who sees both recognises
              one post. ONE line of complete sentences that ends cleanly; never
              a thought cut off. End it with one or two hashtags from the list.
              The whole post, hashtags and spaces included, is ${X_MIN} to ${X_LIMIT}
              characters, because X stops at ${X_LIMIT}. Count before you answer.
hashtags      Exactly 8, each starting with #. The first is specific to this
              topic. The last is always the brand tag given below. The middle
              six mix category, audience and place.
imageBrief    380 to 620 characters of sentence fragments separated by periods,
              in three parts: the photographic scene, real and unposed; the
              layout and brand treatment, using the brand colours as hex values;
              and the overlay copy, written as
              Cover headline "..." with subline "...".
              For a Video this is the COVER FRAME, the still the feed shows
              before the video plays, and the headline is the video's title.
              For a Podcast it is the episode's cover art. For a Carousel it
              is the cover slide, matching Slide 1. Never describe a separate
              post image for these formats.
altText       76 to 123 characters, ONE sentence. A literal description of the
              photograph only. No brand language, no overlay text.
formatExtra   Depends on the format:
                Static Image, Quote, GIF: an empty string.
                Carousel: exactly 4 lines, one per slide, no blank lines:
                  Slide 1 (cover): ...
                  Slide 2: ...
                  Slide 3: ...
                  Slide 4: ...
                Video or Podcast: a header "REEL SCRIPT (30 to 40 seconds,
                  vertical)", then blocks of Shot N, On-screen and Voiceover
                  lines, closing with an End card line.
                Q and A or Poll/Quiz: Q: and A: pairs separated by blank lines.

THE CAPTION DOES NOT REPEAT THE IMAGE
The overlay copy is the hook. Someone who reads the image and then the caption
must learn something new from the caption. Never restate the overlay line.`;

/** "#NorthsideDental" from "Northside Dental". */
export function brandTag(name: string): string {
  const words = name.normalize("NFKD").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  return `#${words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join("") || "Brand"}`;
}

/** Formats whose formatExtra is empty by rule. */
const NO_EXTRA = new Set(["Static Image", "Quote", "GIF"]);

export async function writeContentPack(
  gateway: Gateway,
  ctx: TenantContext,
  input: PackInput,
): Promise<PackResult> {
  const businessFacts = [
    renderBusinessFacts(input.business, input.facts),
    "",
    input.locations.length > 0
      ? `Places they operate: ${input.locations.join("; ")}`
      : "No specific locations recorded.",
  ].join("\n");

  const { post, prompts } = input;
  const banned = [...new Set([...(input.voice?.bannedTerms ?? []), ...prompts.wordsToAvoid])];
  const date = new Date(`${post.date}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC",
  });

  const { system, cacheablePrefixLength } = composeSystemPrompt({
    systemRules: PACK_RULES,
    safety: BASE_SAFETY,
    businessFacts,
    brandVoice: input.voice
      ? renderVoiceLayer({ ...input.voice, bannedTerms: banned, channel: "instagram" })
      : "No approved brand voice is on file. Write in a clear, warm, plain register.",
    task: [
      `BRAND TAG: ${brandTag(input.business.name)}`,
      input.brandColors.length ? `BRAND COLOURS: ${input.brandColors.join(", ")}` : "BRAND COLOURS: none recorded.",
      "",
      "THE POST",
      `  title      ${post.title}`,
      `  runs on    ${date}${post.occasion ? `, for ${post.occasion}` : ""}`,
      /*
       * A post can be moved off its observance's day on the calendar. Without
       * the observance's own date the model writes "today is World Stroke
       * Day" on the 30th.
       */
      post.occasion && post.dateRule
        ? `  observance ${post.occasion} falls on: ${post.dateRule}. If that is not the day this post runs, ` +
          "write about it without saying the run day is the observance."
        : "",
      `  category   ${post.categoryName}`,
      `  audience   ${post.audience}`,
      `  format     ${post.format}`,
      `  image idea ${post.imageIdea || "none given"}`,
      "",
      "WHAT IT ARGUES, which the caption is written from:",
      post.hook,
      prompts.post.trim() ? `\nHOW THIS CUSTOMER WANTS POSTS WRITTEN:\n${prompts.post.trim()}` : "",
      prompts.image.trim() ? `\nHOW THIS CUSTOMER WANTS IMAGES BRIEFED:\n${prompts.image.trim()}` : "",
      prompts.reference.trim()
        ? `\nA POST THIS CUSTOMER IS HAPPY WITH. Match its rhythm and register, never its content:\n${prompts.reference.trim().slice(0, 4000)}`
        : "",
      banned.length && !input.voice ? `\nNever use these words: ${banned.join(", ")}` : "",
    ].filter(Boolean).join("\n"),
    outputFormat: "Return only JSON conforming to the provided schema. No prose, no code fences.",
  });

  const res = await gateway.generate(ctx, {
    taskAlias: "structured_json",
    system,
    cacheableSystemPrefixLength: cacheablePrefixLength,
    messages: [{ role: "user", content: "Write the content pack now." }],
    schema: PACK_SCHEMA as unknown as Record<string, unknown>,
    promptVersion: PROMPT_VERSIONS.socialPack,
  });

  const pack = normalisePack(res.parsed, { format: post.format, brandName: input.business.name });
  return { pack, warnings: packWarnings(pack, { format: post.format, bannedTerms: banned }) };
}

/**
 * Enforce what can be enforced without a second model call.
 *
 * Dashes are stripped, hashtags made well-formed and the brand tag put last,
 * because those are mechanical. Length and banned words are not fixed here:
 * cutting a caption to fit would break its sentences, so those become
 * warnings for a person instead.
 */
export function normalisePack(
  parsed: unknown,
  opts: { format: string; brandName: string },
): SocialContentPack {
  const raw = (parsed ?? {}) as Record<string, unknown>;
  /*
   * Line by line, because stripDashes also collapses runs of whitespace.
   * Applied to the whole caption it would turn its blank-line paragraphs into
   * one block, and the paragraph count is half of what the caption rule asks.
   */
  const text = (key: string) =>
    String(raw[key] ?? "").replace(/\r\n/g, "\n").split("\n").map((l) => stripDashes(l).trim()).join("\n").trim();

  const caption = ensureParagraphs(text("caption").replace(/\n{3,}/g, "\n\n"));
  // X stops at 280. Over it, whole sentences and spare hashtags go, never half a sentence.
  const shortCaption = fitToX(text("shortCaption"));

  const brand = brandTag(opts.brandName);
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const t of Array.isArray(raw["hashtags"]) ? raw["hashtags"] : []) {
    const tag = `#${String(t).replace(/^#+/, "").replace(/[^\p{L}\p{N}_]/gu, "")}`;
    const key = tag.toLowerCase();
    if (tag === "#" || seen.has(key) || key === brand.toLowerCase()) continue;
    seen.add(key);
    tags.push(tag);
  }
  const hashtags = [...tags.slice(0, 7), brand];

  let formatExtra = text("formatExtra");
  if (NO_EXTRA.has(opts.format)) formatExtra = "";
  if (opts.format === "Carousel") {
    // A fifth slide is dropped by the layout, so it is dropped here first.
    formatExtra = formatExtra.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 4).join("\n");
  }

  const imageBrief = text("imageBrief");
  return {
    caption,
    shortCaption,
    hashtags,
    imageBrief,
    // The prompt for an image model belongs to the image step, not this one.
    aiPrompt: "",
    altText: text("altText").replace(/\s*\n+\s*/g, " "),
    formatExtra,
    imageText: overlayText(imageBrief),
  };
}

/**
 * The overlay copy out of an image brief, as "headline\n\nsubline".
 *
 * The brief carries it as `Cover headline "..." with subline "..."`, which is
 * the planner's format and the one the prompt asks for. Pulled out so the
 * words on the image can be read and edited on their own, without hunting
 * through a paragraph of layout direction.
 */
export function overlayText(imageBrief: string): string {
  const quoted = (label: string) =>
    new RegExp(`${label}\\s*:?\\s*["“]([^"”]+)["”]`, "i").exec(imageBrief)?.[1]?.trim() ?? "";
  return [quoted("headline"), quoted("subline")].filter(Boolean).join("\n\n");
}

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

/**
 * Where a pack misses the planner's measurements.
 *
 * Read by a reviewer before approving, and recomputed whenever the page loads
 * so an edit that fixes one clears it.
 */
export function packWarnings(
  pack: SocialContentPack,
  opts: { format: string; bannedTerms: string[] },
): string[] {
  const out: string[] = [];
  const captionWords = words(pack.caption);
  if (captionWords < CAPTION_WORDS.min || captionWords > CAPTION_WORDS.max) {
    out.push(`Caption is ${captionWords} words; aim for ${CAPTION_WORDS.min} to ${CAPTION_WORDS.max}.`);
  }
  if (pack.caption.trim() && paragraphCount(pack.caption) < 3) {
    out.push("Caption is one block of text; break it into 4 to 7 short paragraphs.");
  }
  const withTags = pack.caption.length + 2 + pack.hashtags.join(" ").length;
  if (withTags > CAPTION_CHAR_LIMIT) {
    out.push(`Caption and hashtags are ${withTags} characters; Instagram allows ${CAPTION_CHAR_LIMIT}.`);
  }
  const xLen = pack.shortCaption.length;
  if (xLen > X_LIMIT) {
    out.push(`X post is ${xLen} characters with its hashtags; X allows ${X_LIMIT}.`);
  } else if (xLen < X_MIN) {
    out.push(`X post is ${xLen} characters; aim for ${X_MIN} to ${X_LIMIT}.`);
  }
  if (pack.shortCaption && hashtagsIn(pack.shortCaption).length === 0) {
    out.push("The X post has no hashtag. End it with one or two.");
  }
  if (pack.hashtags.length !== 8) {
    out.push(`${pack.hashtags.length} hashtags; the target is exactly 8.`);
  }
  if (/(^|\s)#\w/.test(pack.caption)) {
    out.push("The caption body contains a hashtag. They belong in the hashtag list.");
  }
  const briefLen = pack.imageBrief.length;
  if (briefLen < 380 || briefLen > 620) {
    out.push(`Image brief is ${briefLen} characters; the target is 380 to 620.`);
  }
  const altLen = pack.altText.length;
  if (altLen < 76 || altLen > 123) {
    out.push(`Alt text is ${altLen} characters; the target is 76 to 123.`);
  }
  if (opts.format === "Carousel" && pack.formatExtra.split("\n").filter(Boolean).length !== 4) {
    out.push("A carousel needs exactly 4 slides.");
  }

  /*
   * Whole words only.
   *
   * A plain substring test flagged the banned "#1" inside the brand colour
   * "#1f6fe8", and would flag "cure" inside "secure". A term matches when
   * nothing word-like touches either end of it.
   */
  const body = `${pack.caption}\n${pack.shortCaption}\n${pack.imageBrief}\n${pack.imageText ?? ""}`;
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const used = opts.bannedTerms.filter((t) =>
    t.trim() && new RegExp(`(?<![\\p{L}\\p{N}_])${escape(t.trim())}(?![\\p{L}\\p{N}_])`, "iu").test(body));
  if (used.length) {
    out.push(`Uses words the brand avoids: ${used.map((t) => `"${t}"`).join(", ")}.`);
  }
  return out;
}
