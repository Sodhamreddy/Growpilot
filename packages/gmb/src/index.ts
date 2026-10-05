/**
 * GMB Reviews Automation.
 *
 * The loop this module owns:
 *   read reviews → draft a reply in the brand voice → a person approves → post
 *
 * Reading comes from Google Business Profile once Google approves API access
 * for the Cloud project, and from the Places API (latest five, read-only)
 * until then. Posting a reply needs Business Profile; before that, replies
 * are copied and pasted on Google by hand.
 */
export * from "./rules.js";
export * from "./scrape.js";
export * from "./google.js";
export * from "./reply.js";
export * from "./sync.js";
