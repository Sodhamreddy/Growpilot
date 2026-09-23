/**
 * Every onboarding transition waits for a bounded, successful server response.
 *
 * The timeout is generous because the first request to any route pays costs the
 * later ones do not: the route compiles on demand in development, the database
 * may be a region away, and the manual-profile path runs eight statements in
 * one transaction — each a round trip. Measured cold against a Tokyo database
 * that adds up to several seconds, and a tight limit turned an ordinary slow
 * first save into "the server took too long" on a request that was still
 * working.
 *
 * A retry is safe: every onboarding write is idempotent by workspace, so a
 * request that did land before the client gave up is reused rather than
 * duplicated.
 */
const TIMEOUT_MS = 45_000;

export async function onboardingRequest<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    // Distinguish "we gave up waiting" from "the network is not there" — they
    // need different things from the person reading the message.
    const timedOut = err instanceof DOMException && err.name === "TimeoutError";
    throw new Error(
      timedOut
        ? "The server is taking longer than expected. Your saved progress is safe — try again."
        : "Could not reach the server. Check your connection and try again.",
    );
  }

  const body = await response.json().catch(() => null);

  if (!response.ok) {
    const fields = body?.error?.details?.fields;
    const detail = fields ? Object.values(fields).flat().join(" ") : "";
    throw new Error(
      detail || body?.error?.message || "Could not save your changes. Please try again.",
    );
  }

  return body as T;
}
