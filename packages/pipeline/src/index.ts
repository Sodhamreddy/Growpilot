/**
 * Shared content foundations.
 *
 * What every module needs and none of them owns: extracting the business
 * profile, learning the brand voice, the approval state machine, the quality
 * gates, and the completeness check.
 *
 * The three product modules — @ob/blog, @ob/social, @ob/gmb — each depend on
 * this and never on each other. That direction is the whole point: a blog
 * article, a social post and a review reply all need approval and all need to
 * sound like the same business, and duplicating that per module is how three
 * subtly different definitions of "approved" end up in one product.
 *
 * Anything specific to one surface belongs in that module, not here.
 */
export * from "./extract.js";
export * from "./instructions.js";
export * from "./voice-extract.js";
export * from "./gates.js";
export * from "./approval.js";
export * from "./completeness.js";
