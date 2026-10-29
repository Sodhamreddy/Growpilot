import { publicFetch } from "./public-fetch.js";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { AppError } from "@ob/core";

/**
 * Guarded fetch for user-supplied URLs.
 *
 * The crawler follows a URL the customer typed, which makes it a
 * server-side request forgery vector: without this guard, "crawl my website"
 * with `http://169.254.169.254/` turns our worker into a proxy for cloud
 * instance metadata. The spec does not call this out, but no crawler that
 * accepts arbitrary input is production-ready without it.
 *
 * Guards applied:
 *  - http/https only (no file:, gopher:, ftp:)
 *  - DNS resolved up front and every resolved address checked against
 *    private, loopback, link-local and reserved ranges
 *  - redirects followed manually so each hop is re-validated (a public URL
 *    can 302 to 127.0.0.1)
 *  - response size capped so a huge body cannot exhaust worker memory
 */

const MAX_REDIRECTS = 5;
const MAX_BYTES = 5 * 1024 * 1024;

export interface FetchResult {
  url: string;
  status: number;
  contentType: string | null;
  body: string;
  redirectChain: string[];
}

export function isBlockedIp(ip: string): boolean {
  const v = isIP(ip);

  if (v === 4) {
    const parts = ip.split(".").map(Number);
    const [a = 0, b = 0] = parts;
    if (a === 0) return true;                        // 0.0.0.0/8
    if (a === 10) return true;                       // private
    if (a === 127) return true;                      // loopback
    if (a === 169 && b === 254) return true;         // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true;         // private
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 192 && b === 0) return true;           // IETF protocol assignments
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a >= 224) return true;                       // multicast + reserved
    return false;
  }

  if (v === 6) {
    const lower = new URL(`http://[${ip}]/`).hostname.slice(1, -1).toLowerCase();
    const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
    if (hexMapped) {
      const hi = parseInt(hexMapped[1]!, 16), lo = parseInt(hexMapped[2]!, 16);
      return isBlockedIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    if (/^fe[89ab]/.test(lower) || lower.startsWith("ff")) return true;
    if (lower === "::" || lower === "::1") return true;
    if (lower.startsWith("fe80")) return true;       // link-local
    if (/^f[cd]/.test(lower)) return true;           // unique local
    // IPv4-mapped (::ffff:127.0.0.1) must be checked as IPv4.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped?.[1]) return isBlockedIp(mapped[1]);
    // Refuse transition, discard and reserved ranges; ordinary global unicast is 2000::/3.
    if (!/^[23]/.test(lower) || lower.startsWith("2001:db8:") || lower.startsWith("2002:")) return true;
    return false;
  }

  return true; // not a valid IP — refuse
}

/**
 * Refuse a host that resolves anywhere non-public.
 *
 * Exported because publishing needs exactly the same guard as crawling: a CMS
 * base URL is customer-supplied, and without this a workspace could point one
 * at 169.254.169.254 or an internal host and have the worker fetch it with
 * credentials attached. Resolution happens up front so the check applies to the
 * address actually dialled, not just the name.
 */
export async function assertPublicHost(hostname: string): Promise<void> {
  if (isIP(hostname)) {
    if (isBlockedIp(hostname)) {
      throw new AppError("crawl_blocked", "That address is not publicly reachable.", {
        details: { hostname },
        retryable: false,
      });
    }
    return;
  }

  let addresses: { address: string }[];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw new AppError("crawl_blocked", "That domain could not be resolved.", {
      details: { hostname },
      retryable: false,
    });
  }

  if (addresses.length === 0 || addresses.some((a) => isBlockedIp(a.address))) {
    throw new AppError("crawl_blocked", "That domain resolves to a non-public address.", {
      details: { hostname },
      retryable: false,
    });
  }
}

export async function guardedFetch(
  rawUrl: string,
  opts: { userAgent: string; timeoutMs: number; accept?: string },
): Promise<FetchResult> {
  const redirectChain: string[] = [];
  let current = rawUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const url = new URL(current);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new AppError("crawl_blocked", "Only http and https URLs can be crawled.", {
        details: { protocol: url.protocol },
        retryable: false,
      });
    }
    await assertPublicHost(url.hostname);

    const signal = AbortSignal.timeout(opts.timeoutMs);
    let res: Response;
    try {
      res = await publicFetch(url, {
        redirect: "manual", // re-validate every hop ourselves
        signal,
        headers: {
          "User-Agent": opts.userAgent,
          Accept: opts.accept ?? "text/html,application/xhtml+xml",
          "Accept-Language": "en",
        },
      });
    } catch (err) {
      throw new AppError("crawl_blocked", "Could not reach that URL.", {
        cause: err,
        details: { url: current },
        retryable: true,
      });
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      await res.body?.cancel();
      if (!location) {
        return { url: current, status: res.status, contentType: null, body: "", redirectChain };
      }
      redirectChain.push(current);
      current = new URL(location, url).toString();
      continue;
    }

    const contentType = res.headers.get("content-type");
    const body = await readCapped(res, MAX_BYTES);
    return { url: current, status: res.status, contentType, body, redirectChain };
  }

  throw new AppError("crawl_blocked", "That URL redirects too many times.", {
    details: { redirectChain },
    retryable: false,
  });
}

/** Read a response body, aborting once the cap is exceeded. */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        break;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return new TextDecoder("utf-8", { fatal: false }).decode(concat(chunks, total));
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(Math.min(total, chunks.reduce((n, c) => n + c.byteLength, 0)));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** Normalise a URL for deduplication and storage (spec §3.1 "Canonicalize"). */
export function canonicalizeUrl(input: string): string {
  const url = new URL(input.trim());
  url.hash = "";
  url.hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
    url.port = "";
  }
  // Drop tracking parameters that create duplicate entries for one page.
  const strip = [/^utm_/i, /^gclid$/i, /^fbclid$/i, /^msclkid$/i, /^mc_[ce]id$/i, /^_hs/i];
  for (const key of [...url.searchParams.keys()]) {
    if (strip.some((re) => re.test(key))) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }
  return url.toString();
}
