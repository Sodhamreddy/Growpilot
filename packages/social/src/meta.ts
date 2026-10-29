import { executionSignal } from "@ob/core";
/**
 * Facebook Page and Instagram Business insights, via the Meta Graph API.
 *
 * One app covers both networks, which is why they are built together: an
 * Instagram Business account is reached *through* the Facebook Page it is
 * linked to, using the same page access token. Treating them as two
 * integrations would mean two OAuth flows for one consent screen.
 *
 * ── What this does and does not do ──
 *
 * This module is the API shape and the normalisation: given a token it asks
 * Graph for numbers and returns rows ready for `metric_snapshots`. It holds no
 * credentials, writes no database rows and schedules nothing — the worker does
 * that, so the parts that are pure can be tested without a network or a token.
 *
 * ── Token model, which is the part that bites ──
 *
 * Three tokens exist and they are not interchangeable:
 *
 *   1. A short-lived *user* token, returned by the OAuth redirect. Valid about
 *      an hour. Useless for a background job.
 *   2. A long-lived *user* token, exchanged from (1). Valid about 60 days.
 *   3. A *page* token, read from (2) via /me/accounts. This is what insights
 *      calls need, and when derived from a long-lived user token it does not
 *      expire — which is what makes an unattended nightly sync possible.
 *
 * Skipping straight from (1) to a page token yields a page token that dies
 * with its parent, and the sync silently stops working an hour after somebody
 * connects. So `exchangeForLongLivedToken` is not optional politeness; it is
 * the step that makes this work at all.
 *
 * ── App Review ──
 *
 * `read_insights` and `instagram_manage_insights` are not granted to a new app
 * outside its own developers. Until Meta approves the app, these calls succeed
 * for accounts listed as testers and fail with an OAuthException for everyone
 * else. `describeGraphError` names that case so the UI can say "waiting on App
 * Review" rather than "something went wrong".
 */

/*
 * Pinned to the version the app is configured for.
 *
 * Meta versions the API and retires metrics between releases, so an
 * unversioned call silently follows whatever Meta defaults to — which is how
 * a working sync starts returning "metric does not exist" after a release
 * nobody here made. Matching the app's own setting (Settings → Advanced →
 * Upgrade API version) keeps the two from drifting.
 */
/*
 * The Graph API base. Overridable only so a test can point the publisher at a
 * local fake instead of real pages; nothing sets it in normal running.
 */
const GRAPH = process.env.META_GRAPH_URL?.trim() || "https://graph.facebook.com/v24.0";

export interface MetaTokens {
  accessToken: string;
  /** Seconds from now, when Meta supplies one. */
  expiresIn?: number;
}

export interface MetaPage {
  id: string;
  name: string;
  /** Page access token. Long-lived when exchanged from a long-lived user token. */
  accessToken: string;
  /** The Instagram Business account linked to this page, when there is one. */
  instagramId?: string;
}

/** One row destined for metric_snapshots. */
export interface MetricRow {
  source: "facebook" | "instagram";
  metric: string;
  date: Date;
  value: number;
  dimensions: Record<string, string>;
}

export interface GraphFailure {
  /** A message safe to render to a customer. */
  message: string;
  /** True when reconnecting would not help, e.g. the app is unreviewed. */
  permanent: boolean;
  outcomeUnknown?: boolean;
}

/**
 * Turn a Graph error into something worth showing a person.
 *
 * Graph reports permissions, expiry and rate limits through the same envelope
 * with different codes, and the raw message ("(#10) Application does not have
 * permission for this action") tells a customer nothing about what to do.
 * Distinguishing them decides whether the UI says reconnect, wait, or that the
 * app is still pending review.
 */
export function describeGraphError(body: unknown): GraphFailure {
  const error = (body as { error?: { code?: number; error_subcode?: number; message?: string } })?.error;
  const code = error?.code;
  const subcode = error?.error_subcode;
  const raw = error?.message ?? "";

  // 190 is the token family: expired, revoked, or invalidated by a password
  // change. All of them are fixed by reconnecting, and only by reconnecting.
  if (code === 190) {
    return {
      message: subcode === 460
        ? "The Facebook connection was invalidated, usually by a password change. Reconnect to continue."
        : "The Facebook connection has expired. Reconnect to continue.",
      permanent: false,
    };
  }

  // 10 and the 200-range are permission refusals. Before App Review these are
  // the normal response for anyone who is not a listed tester, so saying
  // "reconnect" would send somebody round a loop that cannot succeed.
  if (code === 10 || (typeof code === "number" && code >= 200 && code < 300)) {
    return {
      message:
        "Meta has not granted this app permission to read insights for that account. " +
        "This is expected until the app passes App Review.",
      permanent: true,
    };
  }

  // 4, 17 and 32 are rate limits; 613 is a per-endpoint throttle. All recover
  // on their own, so the connection must not be marked broken.
  if (code === 4 || code === 17 || code === 32 || code === 613) {
    return { message: "Meta is rate limiting requests. The next sync will retry.", permanent: false };
  }

  /*
   * 100 is "malformed request", which covers several unrelated causes: a
   * retired metric, a bad token, a missing permission, a wrong app id.
   *
   * The first version of this returned a fixed sentence about retired metrics
   * and threw Meta's own text away — so a token that failed to exchange
   * reported a metrics problem, on a call that requests no metrics. Meta's
   * message for this code is usually specific ("Invalid OAuth access token",
   * "The access token could not be decrypted"), and it is the only thing that
   * says which of the causes applies.
   */
  if (code === 100) {
    const detail = raw.trim();

    /*
     * "nonexisting field (accounts)" means /me/accounts was called with a
     * token that has no "me" — an App token or a Page token rather than a
     * User token. Graph API Explorer offers all three and defaults to the
     * app one, so this is the single most likely mistake when connecting by
     * hand, and Meta's own wording gives no hint of the cause.
     */
    if (/nonexisting field \(accounts\)/i.test(detail)) {
      return {
        message:
          "That is an App token or a Page token, not a User token. In Graph API Explorer set " +
          "\"User or Page\" to \"User Token\", tick the page and instagram permissions, then " +
          "generate again.",
        permanent: true,
      };
    }
    // Subcode 33 is "this object does not exist or you lack permission",
    // which for us nearly always means the page is not reachable with this
    // token rather than anything being malformed.
    if (subcode === 33) {
      return {
        message: "Meta could not find that Page with this token, or the token has no permission for it.",
        permanent: true,
      };
    }
    return {
      message: detail
        ? `Meta rejected the request: ${detail}`
        : "Meta rejected the request as malformed.",
      // Recoverable: the usual fix is a fresh token with the right scopes,
      // not an app change. Marking it permanent stopped a retry that would
      // have worked.
      permanent: false,
    };
  }

  return { message: raw || "Meta returned an error.", permanent: false };
}

/** Thrown for a Graph response that carried an error envelope. */
export class GraphError extends Error {
  readonly permanent: boolean;
  readonly outcomeUnknown: boolean;
  constructor(failure: GraphFailure) {
    super(failure.message);
    this.name = "GraphError";
    this.permanent = failure.permanent;
    this.outcomeUnknown = failure.outcomeUnknown ?? false;
  }
}

type Fetcher = typeof fetch;

async function graph<T>(path: string, params: Record<string, string>, fetcher: Fetcher): Promise<T> {
  const url = new URL(`${GRAPH}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  const res = await fetcher(url.toString(), { signal: executionSignal(AbortSignal.timeout(20_000)) });
  const body: unknown = await res.json().catch(() => ({}));

  // Graph answers 200 with an error envelope in some cases and a 4xx in
  // others, so the body is what decides rather than the status.
  if (!res.ok || (body as { error?: unknown }).error) {
    throw new GraphError(describeGraphError(body));
  }
  return body as T;
}

/**
 * Trade the redirect's short-lived token for a 60-day one.
 *
 * See the token model above: without this the page tokens derived below expire
 * within the hour and the nightly sync stops silently.
 */
export async function exchangeForLongLivedToken(
  shortLived: string,
  appId: string,
  appSecret: string,
  fetcher: Fetcher = fetch,
): Promise<MetaTokens> {
  const body = await graph<{ access_token: string; expires_in?: number }>(
    "/oauth/access_token",
    {
      grant_type: "fb_exchange_token",
      client_id: appId,
      client_secret: appSecret,
      fb_exchange_token: shortLived,
    },
    fetcher,
  );
  return {
    accessToken: body.access_token,
    ...(body.expires_in === undefined ? {} : { expiresIn: body.expires_in }),
  };
}

/**
 * The pages this user administers, with any linked Instagram account.
 *
 * A person may administer several pages and only one belongs to the client
 * being connected, so the caller picks; this does not guess.
 */
export async function listPages(userToken: string, fetcher: Fetcher = fetch): Promise<MetaPage[]> {
  const body = await graph<{
    data?: { id: string; name: string; access_token: string;
             instagram_business_account?: { id: string } }[];
  }>(
    "/me/accounts",
    { access_token: userToken, fields: "id,name,access_token,instagram_business_account{id}" },
    fetcher,
  );

  return (body.data ?? []).map((page) => ({
    id: page.id,
    name: page.name,
    accessToken: page.access_token,
    ...(page.instagram_business_account?.id
      ? { instagramId: page.instagram_business_account.id }
      : {}),
  }));
}

/*
 * Which Graph metrics map to which of ours.
 *
 * Ours are the vocabulary the dashboard already uses; Meta's are named per
 * network and change between API versions. Keeping the mapping in one table
 * means a retired metric is a one-line edit rather than a hunt through the
 * ingestion code.
 */
/*
 * Verified against the live API on v24, not taken from documentation.
 *
 * Meta retired a great deal in v24 and the docs still list some of it. Every
 * name below was requested against a real Page and a real Instagram account
 * and returned data; the ones that answered "(#100) The value must be a valid
 * insights metric" are recorded beside them so nobody re-adds them:
 *
 *   page_impressions_unique   retired  (was our reach)
 *   page_impressions          retired
 *   page_fans                 retired  (was our followers)
 *   page_fan_adds/_removes    retired
 *   ig: impressions           retired
 *   ig: accounts_engaged      retired
 *   ig: profile_views, views, total_interactions — need a different period
 *
 * Facebook has no daily page-level reach metric left at all, so "reach" for a
 * Page is genuinely unavailable and the dashboard shows what exists rather
 * than substituting a different number under the same label. Post-level reach
 * still works, which is where the post table gets its figures.
 */
const PAGE_METRICS: Record<string, string> = {
  page_post_engagements: "engagement",
  // Total page follows, i.e. audience size over time.
  page_follows: "followers",
  page_views_total: "impressions",
};

const IG_METRICS: Record<string, string> = {
  reach: "reach",
  follower_count: "followers",
};

interface GraphInsight {
  name: string;
  values?: { value?: number | Record<string, number>; end_time?: string }[];
}

/**
 * Flatten a Graph insights response into snapshot rows.
 *
 * Exported for its own sake: this is where the shapes Graph actually returns
 * get reconciled, and it is worth testing against real payloads without a
 * token. Three shapes turn up in practice — a plain number, a breakdown object
 * keyed by dimension, and an empty array for a metric with no data — and the
 * middle one is why a naive `Number(value)` yields NaN.
 */
export function rowsFromInsights(
  insights: GraphInsight[],
  source: "facebook" | "instagram",
  mapping: Record<string, string>,
  dimensions: Record<string, string>,
): MetricRow[] {
  const rows: MetricRow[] = [];

  for (const insight of insights) {
    const metric = mapping[insight.name];
    if (!metric) continue;

    for (const point of insight.values ?? []) {
      const raw = point.value;
      // A breakdown object sums to the period total, which is the number the
      // dashboard shows. Keeping the breakdown would need its own dimension
      // column and nothing renders it yet.
      const value = typeof raw === "number"
        ? raw
        : raw && typeof raw === "object"
          ? Object.values(raw).reduce((sum, n) => sum + (Number(n) || 0), 0)
          : null;

      if (value === null || !Number.isFinite(value)) continue;

      // Meta stamps a period with its *end* time. Without a date we cannot
      // place the point on a trend line, so the row is dropped rather than
      // dated to "now" — which would stack a month of history onto today.
      const date = point.end_time ? new Date(point.end_time) : null;
      if (!date || Number.isNaN(date.getTime())) continue;

      rows.push({ source, metric, date, value, dimensions });
    }
  }

  return rows;
}

/** Daily page-level insights for the last `days` days. */
export async function fetchPageInsights(
  page: MetaPage,
  days: number,
  dimensions: Record<string, string>,
  fetcher: Fetcher = fetch,
): Promise<MetricRow[]> {
  const body = await graph<{ data?: GraphInsight[] }>(
    `/${page.id}/insights`,
    {
      access_token: page.accessToken,
      metric: Object.keys(PAGE_METRICS).join(","),
      period: "day",
      since: String(Math.floor((Date.now() - days * 86_400_000) / 1000)),
      until: String(Math.floor(Date.now() / 1000)),
    },
    fetcher,
  );
  return rowsFromInsights(body.data ?? [], "facebook", PAGE_METRICS, dimensions);
}

/** Daily Instagram insights, when a business account is linked to the page. */
export async function fetchInstagramInsights(
  page: MetaPage,
  days: number,
  dimensions: Record<string, string>,
  fetcher: Fetcher = fetch,
): Promise<MetricRow[]> {
  if (!page.instagramId) return [];

  const body = await graph<{ data?: GraphInsight[] }>(
    `/${page.instagramId}/insights`,
    {
      access_token: page.accessToken,
      metric: Object.keys(IG_METRICS).join(","),
      period: "day",
      since: String(Math.floor((Date.now() - days * 86_400_000) / 1000)),
      until: String(Math.floor(Date.now() / 1000)),
    },
    fetcher,
  );
  return rowsFromInsights(body.data ?? [], "instagram", IG_METRICS, dimensions);
}

/**
 * Per-post numbers for recent posts.
 *
 * Separate from the account-level call because the dashboard's post table
 * needs a row per post, and Graph will not return both in one request. Failure
 * here is deliberately not fatal to a sync: account totals are the headline,
 * and losing the post table is better than losing everything.
 */
export async function fetchRecentPosts(
  page: MetaPage,
  limit: number,
  dimensions: Record<string, string>,
  fetcher: Fetcher = fetch,
): Promise<MetricRow[]> {
  const body = await graph<{
    data?: {
      id: string;
      message?: string;
      created_time?: string;
      full_picture?: string;
      permalink_url?: string;
      attachments?: { data?: {
        media?: { image?: { src?: string } };
        subattachments?: { data?: { media?: { image?: { src?: string } } }[] };
      }[] };
      insights?: { data?: GraphInsight[] };
      likes?: { summary?: { total_count?: number } };
      comments?: { summary?: { total_count?: number } };
      shares?: { count?: number };
    }[];
  }>(
    `/${page.id}/posts`,
    {
      access_token: page.accessToken,
      limit: String(limit),
      /*
       * No insights sub-query.
       *
       * post_impressions_unique and post_engaged_users are both retired in
       * v24, and an invalid metric fails the *whole* request — so asking for
       * them cost the likes, comments and shares that do work. Those counts
       * are the post table's real content anyway; reach per post is gone
       * along with reach per page.
       *
       * post_clicks and post_video_views survive but are not worth a request
       * per post: Graph will not batch them into this call.
       */
      fields:
        "id,message,created_time,full_picture,permalink_url,attachments{media,subattachments{media}},likes.summary(true),comments.summary(true),shares",
    },
    fetcher,
  );

  const rows: MetricRow[] = [];
  for (const post of body.data ?? []) {
    const date = post.created_time ? new Date(post.created_time) : null;
    if (!date || Number.isNaN(date.getTime())) continue;

    const attachment = post.attachments?.data?.[0];
    post.full_picture ??= attachment?.media?.image?.src
      ?? attachment?.subattachments?.data?.find((item) => item.media?.image?.src)?.media?.image?.src;

    const postDimensions = {
      ...dimensions,
      postId: post.id,
      // Trimmed: the caption is a label in a table cell, not the post body.
      title: (post.message ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
      ...(post.full_picture ? { imageUrl: post.full_picture } : {}),
      ...(post.permalink_url ? { url: post.permalink_url } : {}),
    };

    const counts: [string, number | undefined][] = [
      ["likes", post.likes?.summary?.total_count],
      ["comments", post.comments?.summary?.total_count],
      ["shares", post.shares?.count],
    ];
    for (const [metric, value] of counts) {
      if (typeof value === "number") {
        rows.push({ source: "facebook", metric, date, value, dimensions: postDimensions });
      }
    }

    /*
     * Engagement, computed rather than fetched.
     *
     * Meta no longer exposes post_engaged_users, but the three counts above
     * are exactly what it summed. Deriving it keeps the post table's
     * engagement column meaningful instead of blank, and the arithmetic is
     * stated here rather than hidden behind a metric name.
     */
    const engagement =
      (post.likes?.summary?.total_count ?? 0) +
      (post.comments?.summary?.total_count ?? 0) +
      (post.shares?.count ?? 0);
    if (engagement > 0) {
      rows.push({ source: "facebook", metric: "engagement", date, value: engagement, dimensions: postDimensions });
    }
  }
  return rows;
}

/** Recent Instagram media with the image/video thumbnail needed by the post table. */
export async function fetchRecentInstagramPosts(
  page: MetaPage,
  limit: number,
  dimensions: Record<string, string>,
  fetcher: Fetcher = fetch,
): Promise<MetricRow[]> {
  if (!page.instagramId) return [];

  const body = await graph<{
    data?: {
      id: string;
      caption?: string;
      timestamp?: string;
      media_url?: string;
      thumbnail_url?: string;
      permalink?: string;
      like_count?: number;
      comments_count?: number;
    }[];
  }>(`/${page.instagramId}/media`, {
    access_token: page.accessToken,
    limit: String(limit),
    fields: "id,caption,timestamp,media_url,thumbnail_url,permalink,like_count,comments_count",
  }, fetcher);

  const rows: MetricRow[] = [];
  for (const post of body.data ?? []) {
    const date = post.timestamp ? new Date(post.timestamp) : null;
    if (!date || Number.isNaN(date.getTime())) continue;
    const postDimensions = {
      ...dimensions,
      postId: post.id,
      title: (post.caption ?? "Instagram post").replace(/\s+/g, " ").trim().slice(0, 120),
      ...(post.thumbnail_url || post.media_url ? { imageUrl: post.thumbnail_url || post.media_url! } : {}),
      ...(post.permalink ? { url: post.permalink } : {}),
    };
    const likes = post.like_count ?? 0;
    const comments = post.comments_count ?? 0;
    rows.push(
      { source: "instagram", metric: "likes", date, value: likes, dimensions: postDimensions },
      { source: "instagram", metric: "comments", date, value: comments, dimensions: postDimensions },
      { source: "instagram", metric: "engagement", date, value: likes + comments, dimensions: postDimensions },
    );
  }
  return rows;
}

// ─── Publishing ─────────────────────────────────────────────────────────────

/**
 * The permissions each network needs to publish, on top of reading.
 *
 * Granted only to people with a role on the Meta app until App Review
 * approves them for everyone; the connection records what was actually
 * granted, so the schedule page can say which networks will work.
 */
export const PUBLISH_PERMISSIONS = {
  facebook: ["pages_manage_posts", "pages_read_engagement"],
  instagram: ["instagram_content_publish", "instagram_basic"],
} as const;

export interface PublishResult {
  /** The network's own id for the post. */
  id: string;
  /** Where the published post can be seen. */
  url: string;
}

/**
 * A publishing failure, in words about posting, and whether waiting could fix it.
 *
 * Separate from `describeGraphError`, whose wording is about reading insights.
 * The line drawn is different too: a post is retried only when Meta says the
 * problem is its own and temporary. Anything else (a refused permission, an
 * expired token, a rejected image) needs a person, and retrying it five times
 * only delays saying so.
 */
export function describePublishError(body: unknown, httpStatus = 400): GraphFailure {
  const error = (body as {
    error?: { code?: number; message?: string; error_user_msg?: string; is_transient?: boolean };
  })?.error;
  const code = error?.code;
  const detail = (error?.error_user_msg || error?.message || "").trim();

  if (code === 190) {
    return { message: "The Facebook connection has expired. Reconnect it in step 5, then try again.", permanent: true };
  }
  if (code === 10 || (typeof code === "number" && code >= 200 && code < 300)) {
    return {
      message:
        "Meta has not allowed this app to post to that account. Reconnect and allow posting. " +
        "Until the app passes App Review, only people with a role on the Meta app can post through it.",
      permanent: true,
    };
  }
  if (code === 1 || code === 2 || code === 4 || code === 17 || code === 32 || code === 613 || error?.is_transient
      || (!error && httpStatus >= 500)) {
    return { message: "Meta is busy or limiting requests. It will be tried again shortly.", permanent: false };
  }
  if (code === 368) {
    return { message: `Meta blocked this post${detail ? `: ${detail}` : "."}`, permanent: true };
  }
  return { message: detail ? `Meta refused the post: ${detail}` : "Meta refused the post.", permanent: true };
}

/**
 * POST to Graph for publishing.
 *
 * `final` marks the call that makes a post public. If that one times out or
 * the connection drops, the post may have gone out anyway, and Graph has no
 * way to make a retry safe. So it is not retried: the person is told to look
 * before trying again, because a missed post is easier to fix than a double.
 */
async function graphPost<T>(
  path: string,
  body: FormData | URLSearchParams,
  fetcher: Fetcher,
  { final = false, timeoutMs = 60_000 }: { final?: boolean; timeoutMs?: number } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetcher(`${GRAPH}${path}`, { method: "POST", body, signal: executionSignal(AbortSignal.timeout(timeoutMs)) });
  } catch (err) {
    if (!final) throw err;
    throw new GraphError({
      message: "Meta did not answer in time, so the post may or may not have gone out. Check the account before trying again.",
      permanent: true, outcomeUnknown: true,
    });
  }
  const parsed: unknown = await res.json().catch(() => null);
  if (final && (res.status >= 500 || !parsed || (res.ok && !(parsed as { id?: string }).id))) {
    throw new GraphError({ message: "Meta returned an uncertain result. Check the account before retrying.", permanent: true, outcomeUnknown: true });
  }
  if (!res.ok || (parsed as { error?: unknown }).error) throw new GraphError(describePublishError(parsed, res.status));
  return parsed as T;
}

/** What the connected person actually granted. */
export async function grantedPermissions(userToken: string, fetcher: Fetcher = fetch): Promise<string[]> {
  const body = await graph<{ data?: { permission: string; status: string }[] }>(
    "/me/permissions", { access_token: userToken }, fetcher,
  );
  return (body.data ?? []).filter((p) => p.status === "granted").map((p) => p.permission);
}

/**
 * A photo post on a Facebook Page.
 *
 * The image goes up as the file itself rather than a link, so a post can be
 * published from a machine Facebook cannot reach, local development included.
 */
export async function publishFacebookPhoto(
  page: { id: string; accessToken: string },
  post: { message: string; image: Uint8Array; mimeType: string },
  fetcher: Fetcher = fetch,
): Promise<PublishResult> {
  const form = new FormData();
  form.set("access_token", page.accessToken);
  form.set("message", post.message);
  form.set("published", "true");
  form.set("source", new Blob([post.image], { type: post.mimeType }), "post-image");
  const body = await graphPost<{ id: string; post_id?: string }>(`/${page.id}/photos`, form, fetcher, { final: true });
  const postId = body.post_id ?? body.id;
  return { id: postId, url: `https://www.facebook.com/${postId}` };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * A photo post on an Instagram professional account.
 *
 * Instagram publishes in two steps: a container that fetches the image from
 * a public JPEG address, then a publish of that container once Instagram has
 * processed it. Publishing before processing finishes fails, so the
 * container's status is polled first.
 */
export async function publishInstagramPhoto(
  account: { instagramId: string; accessToken: string },
  post: { caption: string; imageUrl: string },
  fetcher: Fetcher = fetch,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<PublishResult> {
  const token = account.accessToken;
  const container = await graphPost<{ id: string }>(
    `/${account.instagramId}/media`,
    new URLSearchParams({ image_url: post.imageUrl, caption: post.caption, access_token: token }),
    fetcher,
  );

  for (let attempt = 0; attempt < 10; attempt++) {
    const state = await graph<{ status_code?: string }>(`/${container.id}`, { fields: "status_code", access_token: token }, fetcher);
    if (!state.status_code || state.status_code === "FINISHED") break;
    if (state.status_code === "ERROR" || state.status_code === "EXPIRED") {
      throw new GraphError({ message: "Instagram could not process the image. Check it is a clear JPEG and try again.", permanent: true });
    }
    if (attempt === 9) throw new GraphError({ message: "Instagram is still processing the image. Try again shortly.", permanent: false });
    await wait(3000);
  }

  const published = await graphPost<{ id: string }>(
    `/${account.instagramId}/media_publish`,
    new URLSearchParams({ creation_id: container.id, access_token: token }),
    fetcher,
    { final: true },
  );

  // The permalink is a nicety; a post that published without one is still published.
  let url = "https://www.instagram.com/";
  try {
    const media = await graph<{ permalink?: string }>(`/${published.id}`, { fields: "permalink", access_token: token }, fetcher);
    if (media.permalink) url = media.permalink;
  } catch { /* keep the fallback */ }
  return { id: published.id, url };
}
