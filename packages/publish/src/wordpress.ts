import { AppError } from "@ob/core";
import { assertPublicHost } from "@ob/seo";
import { renderMarkdown } from "./markdown.js";

/**
 * WordPress REST API connector — spec §11.
 *
 * Authenticates with an Application Password, which is what WordPress offers
 * for programmatic access without OAuth. Credentials go over HTTPS only: an
 * application password is equivalent to a login, and Basic auth over plain HTTP
 * would put it on the wire in trivially reversible base64.
 *
 * Posts are created as drafts. Publishing is the one action in this product
 * that reaches the public internet and cannot be taken back, so the default
 * puts the post where a person still has to press the button.
 */

export interface WordPressCredential {
  /** Site root, e.g. https://example.com — not the /wp-json path. */
  baseUrl: string;
  username: string;
  /** Application Password. Stored sealed; only decrypted inside the worker. */
  applicationPassword: string;
}

export interface WordPressPost {
  title: string;
  /** Markdown. Converted to HTML here. */
  bodyMarkdown: string;
  slug: string;
  excerpt?: string | null;
  status?: "draft" | "publish" | "future" | "pending";
  /** Required by WordPress when status is "future". */
  scheduledFor?: Date | null;
}

export interface PublishedPost {
  externalId: string;
  externalUrl: string;
  status: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Normalise the site URL and refuse anything that is not a public https origin.
 *
 * The base URL is customer-supplied and the worker attaches credentials to the
 * request, so this is the same hazard as the crawler's SSRF guard and gets the
 * same treatment: resolved and checked before anything is dialled.
 */
async function resolveApiRoot(baseUrl: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    throw new AppError("validation_failed", "That does not look like a website address.", {
      details: { baseUrl },
      retryable: false,
    });
  }

  if (url.protocol !== "https:") {
    throw new AppError(
      "validation_failed",
      "The WordPress address must start with https. An application password sent over plain " +
        "http can be read by anyone on the network.",
      { details: { protocol: url.protocol }, retryable: false },
    );
  }

  await assertPublicHost(url.hostname);

  // Trailing slashes and an already-included /wp-json are both common.
  const path = url.pathname.replace(/\/+$/, "").replace(/\/wp-json$/, "");
  return url.origin + path + "/wp-json/wp/v2";
}

function authHeader(cred: WordPressCredential): string {
  // WordPress displays application passwords in space-separated groups; the
  // spaces are presentational and the API rejects them.
  const password = cred.applicationPassword.replace(/\s+/g, "");
  const encoded = Buffer.from(cred.username + ":" + password).toString("base64");
  return "Basic " + encoded;
}

async function call(
  cred: WordPressCredential,
  path: string,
  init: { method: string; body?: unknown; timeoutMs?: number },
): Promise<unknown> {
  const root = await resolveApiRoot(cred.baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(root + path, {
      method: init.method,
      headers: {
        Authorization: authHeader(cred),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
      // Credentials are attached, so following a redirect could hand them to
      // another host. Handle redirects explicitly instead.
      redirect: "manual",
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    throw new AppError(
      "dependency_unavailable",
      aborted
        ? "The WordPress site did not respond in time."
        : "We could not reach the WordPress site.",
      { details: { path }, cause: err, retryable: true },
    );
  } finally {
    clearTimeout(timer);
  }

  if (res.status >= 300 && res.status < 400) {
    throw new AppError(
      "validation_failed",
      "The WordPress address redirects. Use the address the site actually serves — usually the " +
        "https, www or non-www form it settles on.",
      {
        details: { status: res.status, location: res.headers.get("location") ?? "" },
        retryable: false,
      },
    );
  }

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // A WordPress REST endpoint always returns JSON. HTML here means the
    // request hit a login wall, a security plugin or a parked domain.
    throw new AppError(
      "validation_failed",
      "That address did not return the WordPress REST API. Check the site address, and that the " +
        "REST API is not disabled by a security plugin.",
      { details: { status: res.status, snippet: text.slice(0, 200) }, retryable: false },
    );
  }

  if (res.status === 401 || res.status === 403) {
    throw new AppError(
      "forbidden",
      "WordPress rejected the credentials. Check the username, regenerate the application " +
        "password, and confirm that user is allowed to publish posts.",
      { details: { status: res.status, wp: errorCode(parsed) }, retryable: false },
    );
  }

  if (res.status >= 400) {
    const serverSide = res.status >= 500;
    throw new AppError(
      serverSide ? "dependency_unavailable" : "validation_failed",
      serverSide
        ? "The WordPress site returned an error. It may be temporarily unavailable."
        : "WordPress rejected the request: " + (errorMessage(parsed) ?? "HTTP " + res.status),
      { details: { status: res.status, wp: errorCode(parsed) }, retryable: serverSide },
    );
  }

  return parsed;
}

function errorCode(body: unknown): string {
  return typeof body === "object" && body !== null && "code" in body
    ? String((body as { code: unknown }).code)
    : "";
}

function errorMessage(body: unknown): string | null {
  return typeof body === "object" && body !== null && "message" in body
    ? String((body as { message: unknown }).message)
    : null;
}

/**
 * Confirm the credential works before anything is published with it.
 *
 * Uses users/me with context=edit, which fails for a credential that can read
 * but not write. That distinction matters: a connection that looks healthy and
 * then cannot publish is worse than one that never connected.
 */
export async function verifyConnection(
  cred: WordPressCredential,
): Promise<{ userId: number; displayName: string; canPublish: boolean }> {
  const me = await call(cred, "/users/me?context=edit", { method: "GET" });
  const record = me as { id?: number; name?: string; capabilities?: Record<string, boolean> };

  if (typeof record.id !== "number") {
    throw new AppError(
      "validation_failed",
      "WordPress did not return a user for those credentials.",
      { retryable: false },
    );
  }

  return {
    userId: record.id,
    displayName: record.name ?? "user " + record.id,
    canPublish: Boolean(record.capabilities?.["publish_posts"]),
  };
}

/** Create a post. Returns the WordPress id and where it can be seen. */
export async function createPost(
  cred: WordPressCredential,
  post: WordPressPost,
): Promise<PublishedPost> {
  const rendered = renderMarkdown(post.bodyMarkdown);
  const status = post.status ?? "draft";

  if (status === "future" && !post.scheduledFor) {
    throw new AppError("validation_failed", "A scheduled post needs a publish date.", {
      retryable: false,
    });
  }

  const body: Record<string, unknown> = {
    title: post.title,
    content: rendered.html,
    slug: post.slug,
    status,
    excerpt: post.excerpt ?? rendered.excerpt,
  };

  if (status === "future" && post.scheduledFor) {
    // date_gmt is unambiguous; `date` would be read as site-local time.
    body["date_gmt"] = post.scheduledFor.toISOString().replace(/\.\d+Z$/, "");
  }

  const created = await call(cred, "/posts", { method: "POST", body });
  const record = created as { id?: number; link?: string; status?: string };

  if (typeof record.id !== "number") {
    throw new AppError("provider_error", "WordPress accepted the post but returned no id.", {
      details: { received: JSON.stringify(created).slice(0, 200) },
      retryable: false,
    });
  }

  // A draft has no public permalink, so point at the edit screen instead —
  // that is where a person actually needs to go next.
  const editUrl =
    new URL(cred.baseUrl).origin + "/wp-admin/post.php?post=" + record.id + "&action=edit";

  return {
    externalId: String(record.id),
    externalUrl: record.link && record.link.length > 0 ? record.link : editUrl,
    status: record.status ?? status,
  };
}
