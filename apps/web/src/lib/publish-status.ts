/**
 * What the article page shows about its latest WordPress delivery.
 *
 * Publishing always creates a WordPress draft (see the worker's publish processor):
 * a person presses Publish in WordPress. So the useful link is the post's editor,
 * not the public address, which shows nothing until the draft goes live.
 */
export interface PublishStatus {
  status: "queued" | "running" | "succeeded" | "failed";
  /** Article version sent; null for older jobs that did not record it. */
  version: number | null;
  postUrl: string | null;
  editUrl: string | null;
  error: string | null;
}

export function publishStatusView(job: {
  status: string; articleVersion: number | null; externalId: string | null; externalUrl: string | null; lastError: string | null;
}): PublishStatus {
  // A cancelled job never reached the CMS, which is the same as a failed one for the reader.
  const status = (job.status === "cancelled" ? "failed" : ["queued", "running", "succeeded", "failed"].includes(job.status) ? job.status : "running") as PublishStatus["status"];
  return { status, version: job.articleVersion, postUrl: safeUrl(job.externalUrl), editUrl: wordPressEditUrl(job.externalUrl, job.externalId), error: job.lastError };
}

/** WordPress's editor for a post: <site>/wp-admin/post.php?post=<id>&action=edit. */
export function wordPressEditUrl(externalUrl: string | null, externalId: string | null): string | null {
  const url = safeUrl(externalUrl);
  if (!url || !externalId || !/^\d+$/.test(externalId)) return null;
  return `${new URL(url).origin}/wp-admin/post.php?post=${externalId}&action=edit`;
}

function safeUrl(value: string | null): string | null {
  if (!value) return null;
  try { return /^https?:$/.test(new URL(value).protocol) ? value : null; } catch { return null; }
}
