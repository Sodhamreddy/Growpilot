/** Only replay read/sync jobs. Publishing requires its existing verification flow. */
export const RECOVERABLE_JOBS = new Set(["analytics.ingest", "analytics.measurement"]);
export function mayRetryJob(workspaceId: string, job: { name: string; data: { workspaceId?: unknown } }): boolean {
  return job.data.workspaceId === workspaceId && RECOVERABLE_JOBS.has(job.name);
}
