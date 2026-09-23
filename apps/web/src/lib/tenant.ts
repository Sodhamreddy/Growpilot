import { cache } from "react";
import { repo } from "@ob/db";
import { db } from "./services";
import { requireTenant } from "./auth";

/**
 * Per-request reads that every page needs.
 *
 * A dashboard navigation renders the layout and the page, and both ask the
 * same two questions: who is this, and which client are they looking at. The
 * layout resolves the client to draw the switcher; the page resolves it again
 * to scope its queries. Nine pages did this independently, so every navigation
 * paid for the same lookup at least twice.
 *
 * That lookup is not cheap here. `getPrimaryBusiness` is two sequential
 * queries — read the workspace's selected id, then read that business — and
 * this deployment's database is in Tokyo, roughly 117ms away. Two round trips
 * duplicated across layout and page is about half a second of a page load
 * spent asking a question already answered.
 *
 * React's `cache` deduplicates within a single request: the first caller pays,
 * every later caller in the same render gets the resolved value. It is not a
 * cross-request cache, so switching client still takes effect immediately —
 * the next request resolves it afresh. That property is why this is safe to
 * apply to the very thing the client switcher changes.
 *
 * `getSession` in ./auth is wrapped the same way, for the same reason.
 */

/** The current client, resolved once per request. */
export const getClient = cache(async function getClient() {
  const ctx = await requireTenant();
  return repo.getPrimaryBusiness(db(), ctx);
});

/**
 * Tenant context and current client together.
 *
 * Almost every page opens by asking for both, and awaiting them in sequence
 * costs a round trip that running them together does not. Both are cached, so
 * calling this more than once in a render is free.
 */
export const getTenantAndClient = cache(async function getTenantAndClient() {
  const [ctx, business] = await Promise.all([requireTenant(), getClient()]);
  return { ctx, business };
});
