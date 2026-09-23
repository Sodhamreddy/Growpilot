/**
 * Starter writing instructions, derived from a client's own profile.
 *
 * A new client used to arrive with six empty prompt boxes. Empty boxes are not
 * neutral: generation falls back to the built-in prompts, which know nothing
 * about this business, and the first batch of topics comes out generic. The
 * person then has to work out what to type into six boxes before they have
 * seen a single piece of output — which is the hardest moment to ask, because
 * they have nothing to react to yet.
 *
 * So the profile writes the first draft. Industry, audience, services, USP and
 * call to action are already extracted by the time these run; turning them into
 * prose the model can act on is arithmetic, not judgement, and needs no model
 * call of its own.
 *
 * Three rules this file holds itself to:
 *
 *  1. Never invent a fact. Every sentence is built from a field that exists,
 *     and a missing field drops its sentence rather than being guessed at. A
 *     client with no USP gets shorter instructions, not a fabricated one.
 *
 *  2. Steer, do not constrain. These sit alongside the built-in prompts that
 *     keep output factual and grounded; they say what to lean towards, never
 *     what rule to drop.
 *
 *  3. Be worth editing. The output is a starting point a person will rewrite,
 *     so it is written the way a person would write it — concrete, specific to
 *     this business, and short enough to read in one pass.
 */

import type { BusinessPrompts } from "@ob/db";

export interface InstructionSource {
  name: string;
  industry: string | null;
  audience: string | null;
  description: string | null;
  usp: string | null;
  primaryCta: string | null;
  /** Service names, as extracted from the site. */
  services: string[];
  /** Town or city names, for the local angle. */
  locations: string[];
}

/** Trimmed, or null. Keeps "   " from becoming a sentence about nothing. */
const val = (v: string | null | undefined): string | null => {
  const t = v?.trim();
  return t ? t : null;
};

/**
 * Strip a trailing full stop so an interpolated value can take a new one.
 *
 * Extracted fields are written as the website wrote them, which is sometimes
 * a full sentence. "…Human Intelligence.. Let that show" is the giveaway that
 * a template assumed otherwise.
 */
const unpunctuated = (s: string): string => s.replace(/\s*[.。]+\s*$/, "");

/** "a, b and c", capped, because a list of twenty steers nothing. */
function list(items: string[], max = 6): string | null {
  const kept = [...new Set(items.map((s) => s.trim()).filter(Boolean))].slice(0, max);
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0]!;
  return `${kept.slice(0, -1).join(", ")} and ${kept.at(-1)}`;
}

/**
 * Drops the blanks and joins what is left into a paragraph.
 *
 * `""` is kept, as a deliberate blank line between sections. Anything falsy
 * is a sentence whose field was missing and is dropped entirely, so a thin
 * profile produces shorter instructions rather than dangling fragments.
 */
const lines = (parts: (string | null)[]): string =>
  parts.filter((p): p is string => p !== null).join("\n").replace(/\n{3,}/g, "\n\n").trim();

/**
 * Which industries want a named caution.
 *
 * Health, care and pharmacy content carries a duty the built-in rules already
 * enforce; saying it again in the client's own instructions means it survives
 * a person rewriting the box, which is where it would otherwise be lost.
 */
function careCaution(industry: string | null): string | null {
  if (!industry) return null;
  if (/home\s*(health|care|nursing)|senior|elder|nursing|caregiv|hospice/i.test(industry)) {
    return (
      "This is care content read by families under stress. Never promise a " +
      "clinical outcome, never give medical advice, and say when something " +
      "needs a doctor or nurse."
    );
  }
  if (/pharmac|chemist|drugstore/i.test(industry)) {
    return (
      "This is pharmacy content. Never give dosing advice, never name a " +
      "prescription medication as a recommendation, and point to the " +
      "pharmacist for anything specific to one person."
    );
  }
  if (/dental|dentist|orthodont|clinic|medical|health/i.test(industry)) {
    return (
      "This is health content. Describe what a treatment involves rather " +
      "than promising a result, and point to a consultation for anything " +
      "specific to one person."
    );
  }
  return null;
}

// ─── Blog ───────────────────────────────────────────────────────────────────

function blogTopics(b: InstructionSource): string {
  const services = list(b.services);
  const where = list(b.locations, 3);

  return lines([
    b.audience
      ? `Write for ${unpunctuated(b.audience)}. Every topic should answer a question they are actually asking.`
      : `Write for the people ${b.name} serves. Every topic should answer a question they are actually asking.`,
    services ? `Anchor topics in what ${b.name} actually does: ${services}.` : null,
    where ? `Favour topics with a local angle where one is honest: ${where}.` : null,
    "",
    "Lean towards:",
    "- Questions a person types into Google before they are ready to buy.",
    "- One specific problem per topic, not a survey of a whole subject.",
    "- Topics that can be answered properly in one article.",
    "",
    "Avoid:",
    "- Titles that could belong to any business in this industry.",
    "- Listicles padded to reach a number.",
    "- Topics that need statistics we cannot source.",
  ]);
}

function blogArticle(b: InstructionSource): string {
  const caution = careCaution(b.industry);

  return lines([
    b.description
      ? `${b.name}: ${b.description}`
      : `Write as ${b.name}.`,
    b.usp ? `What sets this business apart: ${unpunctuated(b.usp)}. Let that show rather than stating it.` : null,
    "",
    "How to write it:",
    "- Open with the reader's problem, not with the business.",
    "- Short paragraphs. Plain words. Say the useful thing early.",
    "- Second person. Address the reader directly.",
    "- Concrete over abstract: name the step, the cost, the timeframe.",
    b.primaryCta ? `- Close with one clear next step: ${unpunctuated(b.primaryCta)}.` : "- Close with one clear next step.",
    "",
    "Never:",
    "- Em dashes.",
    "- Invented statistics, awards, or years in business.",
    "- \"In today's fast-paced world\" and openings like it.",
    caution ? `\n${caution}` : null,
  ]);
}

// ─── Social ─────────────────────────────────────────────────────────────────

function socialTopics(b: InstructionSource): string {
  const services = list(b.services);

  return lines([
    b.audience ? `Write for ${unpunctuated(b.audience)}.` : null,
    services ? `Ground topics in what ${b.name} does: ${services}.` : null,
    "",
    "Lean towards:",
    "- One idea per post, small enough to land in a few lines.",
    "- Practical things a reader can act on this week.",
    "- A mix across the month: useful, seasonal, and human.",
    "",
    "Avoid:",
    "- Posts that are only an announcement about the business.",
    "- Awareness days with no concrete action attached.",
    "- The same idea reworded across a category.",
  ]);
}

function socialPost(b: InstructionSource): string {
  const caution = careCaution(b.industry);

  return lines([
    b.description ? `${b.name}: ${b.description}` : `Write as ${b.name}.`,
    "",
    "How to write it:",
    "- Lead with the point. No wind-up.",
    "- Short sentences. One idea.",
    "- Warm and plain, never corporate.",
    b.primaryCta ? `- Where a call to action fits: ${unpunctuated(b.primaryCta)}.` : null,
    "- A few relevant hashtags, not a wall of them.",
    "",
    "Never:",
    "- Em dashes.",
    "- Engagement bait (\"Comment below!\", \"Tag someone who...\").",
    "- Claims the website does not support.",
    caution ? `\n${caution}` : null,
  ]);
}

function socialImage(b: InstructionSource): string {
  return lines([
    `Images for ${b.name}.`,
    b.audience ? `They are seen by ${unpunctuated(b.audience)}.` : null,
    "",
    "- Real situations over stock-photo poses.",
    "- Natural light, uncluttered background, room for text.",
    "- People who look like the actual audience, in ordinary clothes.",
    "",
    "Avoid:",
    "- Staged handshakes, thumbs up, and fake laughter.",
    "- Text baked into the image.",
    "- Anything implying a person, place or result that is not real.",
  ]);
}

/**
 * Starter instructions for all six prompt boxes.
 *
 * `reference` is deliberately left empty for both pillars: it is meant to hold
 * an article or post the customer actually liked, and generating a fake one to
 * imitate would make the output worse while looking like the box was done.
 */
export function starterInstructions(input: InstructionSource): BusinessPrompts {
  /*
   * Blank-to-null once, here, rather than at every use.
   *
   * A field cleared in the UI arrives as "" or "   ", which is truthy and so
   * renders "Write for    ." into the instructions. Normalising at the call
   * sites worked until a field was added and one site was missed, so the
   * builders below can now assume anything non-null is real text.
   */
  const b: InstructionSource = {
    ...input,
    industry: val(input.industry),
    audience: val(input.audience),
    description: val(input.description),
    usp: val(input.usp),
    primaryCta: val(input.primaryCta),
    services: input.services.filter((s) => val(s)),
    locations: input.locations.filter((s) => val(s)),
  };

  return {
    blog: {
      topics: blogTopics(b),
      article: blogArticle(b),
    },
    social: {
      topics: socialTopics(b),
      post: socialPost(b),
      image: socialImage(b),
    },
  };
}

/**
 * Fill only the boxes that are still empty.
 *
 * Used after a crawl, when the profile is richer than it was at the moment the
 * client was added. Anything the customer has written is left exactly as it
 * is: regenerating over an edit would discard the one instruction in the box
 * that was actually thought about.
 */
export function fillMissingInstructions(
  existing: BusinessPrompts | null | undefined,
  b: InstructionSource,
): BusinessPrompts {
  const starter = starterInstructions(b);
  const blog = { ...(existing?.blog ?? {}) };
  const social = { ...(existing?.social ?? {}) };

  for (const key of ["topics", "article"] as const) {
    if (!val(blog[key])) blog[key] = starter.blog![key];
  }
  for (const key of ["topics", "post", "image"] as const) {
    if (!val(social[key])) social[key] = starter.social![key];
  }

  return { ...(existing ?? {}), blog, social };
}
