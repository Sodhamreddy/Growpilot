/**
 * Social Media Timeline.
 *
 * The loop this module will own:
 *   local events and holidays → a calendar → captions and hashtags per network
 *   → images → approval → publish
 *
 * It depends on @ob/pipeline for the brand voice, the quality gates and the
 * approval state machine, and on nothing in @ob/blog or @ob/gmb. A social post
 * and a blog article are different shapes with different constraints — a
 * caption has a character ceiling and a network-specific hashtag convention,
 * an article has an SEO score — and the moment one module reaches into the
 * other, those constraints start leaking across.
 *
 * Topic pool generation is implemented in ./topics.ts. Networks, scheduling and
 * publishing are not: no network OAuth is connected, and the types below stay
 * as the contract the rest of the module will be built against.
 */
export * from "./topics.js";
export * from "./calendar.js";
export * from "./pack.js";
export * from "./text.js";
export * from "./image.js";
export * from "./store.js";
export * from "./publish.js";
export * from "./categories.js";

export type SocialNetwork =
  | "linkedin" | "facebook" | "instagram" | "x" | "youtube" | "tiktok" | "pinterest";

/**
 * Something worth posting about on a given date.
 *
 * Sourced from holidays, local events and industry moments near a business
 * location. No events provider is connected, so nothing produces these yet —
 * and an invented "local event" is worse than an empty calendar, because a
 * business could post about something that is not happening.
 */
export interface TimelineEvent {
  /** Stable identifier from whichever provider supplied it. */
  externalId: string;
  title: string;
  /** The day it lands on, in the workspace timezone. */
  date: Date;
  kind: "holiday" | "observance" | "local_event" | "industry" | "seasonal";
  /** Where it applies. Empty means it is not tied to a place. */
  location: string;
  /** Why this business in particular might care. */
  relevance: string;
  /** Who said this is happening. Never empty — an event with no source is a guess. */
  source: string;
  sourceUrl: string | null;
}

/** A planned post, before any copy exists. */
export interface CalendarSlot {
  id: string;
  /** The event this hangs off, when it hangs off one. */
  eventId: string | null;
  scheduledFor: Date;
  networks: SocialNetwork[];
  /** Working description of the post's angle. */
  angle: string;
  status: "planned" | "drafting" | "awaiting_approval" | "approved" | "published" | "failed";
}

/**
 * Generated copy for one network.
 *
 * Per network rather than one caption reused everywhere: the limits differ, the
 * conventions differ, and the same words that work on LinkedIn read as
 * corporate filler on Instagram.
 */
export interface SocialPost {
  slotId: string;
  network: SocialNetwork;
  body: string;
  hashtags: string[];
  /** Prompt used to generate the image, kept so a regeneration is reproducible. */
  imagePrompt: string | null;
  imageUrl: string | null;
  /** The network's own ceiling, recorded so a later edit can be checked against it. */
  characterLimit: number;
}

/** Per-network limits, so copy is written to the constraint rather than trimmed after. */
export const NETWORK_LIMITS: Record<SocialNetwork, { body: number; hashtags: number }> = {
  linkedin: { body: 3000, hashtags: 5 },
  facebook: { body: 63206, hashtags: 5 },
  instagram: { body: 2200, hashtags: 30 },
  x: { body: 280, hashtags: 3 },
  youtube: { body: 5000, hashtags: 15 },
  tiktok: { body: 2200, hashtags: 10 },
  pinterest: { body: 500, hashtags: 20 },
};
export * from "./meta.js";
