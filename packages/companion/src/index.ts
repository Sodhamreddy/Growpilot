/**
 * The dashboard companion.
 *
 * One entry point: somebody types what they want, and this returns either an
 * answer or a validated intent the dashboard can run. It never executes
 * anything itself, which is what keeps the safety boundary in one readable
 * place rather than spread across the app.
 */
export * from "./intents.js";
export * from "./interpret.js";
