import { AppError, executionSignal } from "@ob/core";

/**
 * Client for the Crawl4AI rendering service — see services/crawler.
 *
 * Used only where the static fetcher cannot succeed: a JavaScript challenge, or
 * a page that returns markup with no meaningful text. Everything else goes
 * through `guardedFetch`, which is faster, has no external dependency, and does
 * not need a browser running.
 *
 * The service is optional by design. When it is not configured or not running,
 * `renderPage` reports that plainly and the caller falls back to the error it
 * would have produced anyway. A rendering service that is down must never turn
 * a working crawl into a broken one.
 */

export interface RenderedPage {
  url: string;
  status: number;
  html: string;
  markdown: string;
  links: string[];
  title: string | null;
}

export interface RenderOptions {
  /** Base URL of the service, e.g. http://127.0.0.1:8787 */
  serviceUrl: string;
  timeoutMs?: number;
  /** How long to let the page settle after load, for redirecting interstitials. */
  settleMs?: number;
}

/** Whether a rendering service is configured at all. */
export function renderingAvailable(serviceUrl: string | undefined): serviceUrl is string {
  return typeof serviceUrl === "string" && serviceUrl.trim().length > 0;
}

/**
 * Is the service up?
 *
 * Checked before a crawl rather than at the moment of need, so the decision to
 * attempt rendering is made once with a short timeout instead of stalling a
 * page fetch on a service that is not there.
 */
export async function renderingHealthy(serviceUrl: string, timeoutMs = 2_000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(new URL("/health", serviceUrl), { signal: executionSignal(controller.signal) });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function renderPage(url: string, opts: RenderOptions): Promise<RenderedPage> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const signal = executionSignal(AbortSignal.timeout(timeoutMs + 5_000));

  let res: Response;
  try {
    res = await fetch(new URL("/render", opts.serviceUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        timeout_ms: timeoutMs,
        settle_ms: opts.settleMs ?? 1_200,
      }),
      signal,
    });
  } catch (err) {
    throw new AppError(
      "dependency_unavailable",
      "The rendering service is not reachable.",
      { cause: err, details: { serviceUrl: opts.serviceUrl }, retryable: true },
    );
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new AppError(
      res.status === 422 ? "crawl_blocked" : "dependency_unavailable",
      body?.error ?? `The rendering service returned HTTP ${res.status}.`,
      { details: { status: res.status, url }, retryable: res.status >= 500 },
    );
  }

  const body = (await res.json()) as RenderedPage;
  return {
    url: body.url ?? url,
    status: body.status ?? 200,
    html: body.html ?? "",
    markdown: body.markdown ?? "",
    links: Array.isArray(body.links) ? body.links : [],
    title: body.title ?? null,
  };
}
