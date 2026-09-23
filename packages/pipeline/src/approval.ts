import { AppError, type TenantContext, requireRole } from "@ob/core";
import type { WorkspaceSettings } from "@ob/db";

/**
 * Article lifecycle state machine — spec §6.3 and §15.1.
 *
 * Publication is gated in one place. A transition that is not in `ALLOWED`
 * cannot happen, so "publish without approval" is not reachable by calling the
 * wrong function in the wrong order — the spec's §18 acceptance criterion
 * ("Approval: policy enforced") is a property of this table.
 */

export type ArticleStatus =
  | "draft" | "generating" | "qa" | "needs_changes" | "awaiting_approval"
  | "approved" | "scheduled" | "published" | "failed";

const ALLOWED: Record<ArticleStatus, ArticleStatus[]> = {
  draft: ["generating", "failed"],
  generating: ["qa", "failed", "draft"],
  qa: ["needs_changes", "awaiting_approval", "approved", "failed"],
  needs_changes: ["generating", "draft", "failed"],
  awaiting_approval: ["approved", "needs_changes", "failed"],
  approved: ["scheduled", "published", "needs_changes"],
  scheduled: ["published", "approved", "failed"],
  published: ["needs_changes"],
  failed: ["draft", "generating"],
};

export function canTransition(from: ArticleStatus, to: ArticleStatus): boolean {
  return ALLOWED[from].includes(to);
}

export function assertTransition(from: ArticleStatus, to: ArticleStatus): void {
  if (!canTransition(from, to)) {
    throw new AppError(
      "conflict",
      `An article cannot move from "${humanize(from)}" to "${humanize(to)}".`,
      { details: { from, to, allowed: ALLOWED[from] }, retryable: false },
    );
  }
}

/**
 * Decide where an article goes after its quality gates run.
 *
 * Any failing gate sends it back for changes. Otherwise the workspace's
 * approval policy decides between `awaiting_approval` and `approved`.
 */
export function statusAfterGates(
  gatesPassed: boolean,
  settings: WorkspaceSettings,
): ArticleStatus {
  if (!gatesPassed) return "needs_changes";
  return settings.requireApprovalBeforePublish === false ? "approved" : "awaiting_approval";
}

export interface PublishDecision {
  allowed: boolean;
  reasons: string[];
}

/**
 * Final check immediately before an external publish job is enqueued.
 *
 * Deliberately re-reads state rather than trusting the caller: the §18.1
 * critical test "business profile changed after draft" means an article that
 * passed its gates an hour ago may no longer be publishable.
 */
export function canPublish(
  article: { status: ArticleStatus; seoScore: number | null; voiceScore: number | null; approvedAt: Date | null },
  settings: WorkspaceSettings,
  gateVerdicts: { gate: string; verdict: "pass" | "warn" | "fail" }[],
): PublishDecision {
  const reasons: string[] = [];

  if (article.status !== "approved" && article.status !== "scheduled") {
    reasons.push(`Article is "${humanize(article.status)}"; only approved articles can be published.`);
  }

  if (settings.requireApprovalBeforePublish !== false && !article.approvedAt) {
    reasons.push("This workspace requires human approval, and the article has not been approved.");
  }

  const failed = gateVerdicts.filter((g) => g.verdict === "fail");
  if (failed.length > 0) {
    reasons.push(`Quality gates failing: ${failed.map((g) => g.gate).join(", ")}.`);
  }

  if (gateVerdicts.length === 0) {
    reasons.push("Quality gates have not run for this version.");
  }

  const minSeo = settings.minSeoScoreToPublish ?? 70;
  if (article.seoScore !== null && article.seoScore < minSeo) {
    reasons.push(`SEO score ${article.seoScore.toFixed(1)} is below the minimum of ${minSeo}.`);
  }

  const minVoice = settings.minVoiceScoreToPublish ?? 70;
  if (article.voiceScore !== null && article.voiceScore < minVoice) {
    reasons.push(`Brand voice score ${article.voiceScore} is below the minimum of ${minVoice}.`);
  }

  return { allowed: reasons.length === 0, reasons };
}

/** Approving another person's work requires at least the editor role. */
export function assertMayApprove(ctx: TenantContext): void {
  requireRole(ctx, "editor");
}

/** Publishing externally is an irreversible, outward-facing act. */
export function assertMayPublish(ctx: TenantContext): void {
  requireRole(ctx, "admin");
}

function humanize(status: ArticleStatus): string {
  return status.replace(/_/g, " ");
}
