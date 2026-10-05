import { config } from "@ob/core";

/**
 * Why "Connect with Facebook" cannot finish on this server, or null when it can.
 *
 * Meta sends a person back only to an address listed in the app's App
 * Domains, and a Live app cannot list localhost. From a local dev server the
 * consent screen therefore ends on Meta's own "Can't load URL" page, with no
 * way back. Knowing that here lets the pages say so and offer the token
 * route instead of sending anyone into it.
 */
export function metaLoginBlocked(): string | null {
  let host = "";
  try {
    host = new URL(config().APP_URL).hostname;
  } catch {
    return null;
  }
  const local = host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "[::1]" || /^127\./.test(host);
  return local
    ? "Facebook sign-in cannot return to a localhost address, so it only works once the app has a public address. Connect with an access token instead."
    : null;
}
