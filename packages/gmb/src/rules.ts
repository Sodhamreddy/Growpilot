/**
 * What a review is, and which ones must never get a generated reply.
 */

export type ReviewRating = 1 | 2 | 3 | 4 | 5;

/** One review, as it comes back from Google. */
export interface Review {
  /** Google's own review name/id. The idempotency key for a reply. */
  externalId: string;
  locationId: string;
  rating: ReviewRating;
  /** Reviewers can leave a star rating and no words. */
  comment: string | null;
  authorDisplayName: string;
  createdAt: Date;
  updatedAt: Date;
  /** Present when someone has already replied, ours or otherwise. */
  existingReply: { comment: string; updatedAt: Date } | null;
}

/**
 * A drafted reply, awaiting a person.
 *
 * `requiresHumanEdit` is separate from the approval gate on purpose. Some
 * reviews must not be answered by a generated reply at all — an allegation of
 * harm, a legal threat, a safety complaint — and those need a person to write
 * the words, not merely to approve ours.
 */
export interface ReviewReply {
  reviewId: string;
  body: string;
  /** Which facts the reply leaned on, so a reviewer can check it. */
  groundedIn: string[];
  requiresHumanEdit: boolean;
  /** Set when the reply was withheld, with the reason stated plainly. */
  withheldReason: string | null;
}

/**
 * Reviews that must never receive an automated reply.
 *
 * Deliberately broad. The cost of a person handling a review that did not need
 * it is a few minutes; the cost of a generated reply to an allegation of injury
 * or discrimination is a public statement the business did not make and cannot
 * unsay.
 */
export const REPLY_BLOCKLIST_PATTERNS: RegExp[] = [
  /\b(lawsuit|sue|suing|attorney|lawyer|legal action|court)\b/i,
  /\b(injur\w+|hospital|ambulance|unsafe|hazard|poison\w*)\b/i,
  /\b(discriminat\w+|racist|racism|sexist|harass\w+|assault)\b/i,
  /\b(fraud|scam|stolen|theft|police|illegal)\b/i,
  /\b(died|death|fatal)\b/i,
];

/** Whether a review needs a person to write the reply rather than approve one. */
export function requiresHumanReply(comment: string | null, rating: ReviewRating): boolean {
  if (comment && REPLY_BLOCKLIST_PATTERNS.some((re) => re.test(comment))) return true;
  // A one-star review with an explanation is a complaint worth answering
  // personally; a generated apology is exactly the wrong register.
  if (rating === 1 && comment !== null && comment.trim().length > 0) return true;
  return false;
}
