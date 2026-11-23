import type { Role } from "@ob/core";
import type { ArticleStatus } from "./approval.js";

/**
 * The team review process: two teams, three steps.
 *
 *   1. Content review — the Content team checks the draft and approves it.
 *   2. Manager approval — a Manager gives the final approval or sends it back.
 *   3. Publish — anyone on either team sends the approved article to WordPress.
 *
 * It is the multi-level process agencies run across teams, as an alternative to
 * the default single reviewer. Nothing here talks to the database: the routes
 * load the roster and the sign-offs and ask these functions what they mean, so
 * the rules are the same on the server, on the article page and in the queue.
 */

export type ReviewTeam = "content" | "manager";
export const REVIEW_TEAMS: readonly ReviewTeam[] = ["content", "manager"];
export const REVIEW_TEAM_LABELS: Record<ReviewTeam, string> = {
  content: "Content team",
  manager: "Managers",
};

export type ReviewProcess = "single" | "team";

/** The workspace's review process. Anything but an explicit "team" is the single reviewer. */
export function reviewProcessOf(settings: { reviewProcess?: string } | null | undefined): ReviewProcess {
  return settings?.reviewProcess === "team" ? "team" : "single";
}

/** One recorded decision at one level, for one version of the article. */
export interface ReviewSignOff {
  step: ReviewTeam;
  decision: "approved" | "changes_requested";
  version: number;
  at: Date | string;
}

/**
 * Where an article stands in the team review.
 *
 * - `drafting`: not ready for review yet (being written, checked, or failed)
 * - `revision`: sent back; the Content team revises it
 * - `content`: level 1, waiting for the Content team
 * - `manager`: level 2, waiting for a Manager
 * - `publish`: approved, waiting for someone on either team to send it to WordPress
 * - `sent`: the approved version is in WordPress as a draft
 * - `live`: published
 */
export type TeamStage = "drafting" | "revision" | "content" | "manager" | "publish" | "sent" | "live";

export function teamReviewStage(
  article: { status: ArticleStatus | string; version: number },
  signOffs: ReviewSignOff[],
  options: { delivered?: boolean } = {},
): TeamStage {
  switch (article.status) {
    case "needs_changes": return "revision";
    case "awaiting_approval": return contentApproved(article.version, signOffs) ? "manager" : "content";
    case "approved":
    case "scheduled": return options.delivered ? "sent" : "publish";
    case "published": return "live";
    default: return "drafting";
  }
}

/**
 * Whether the Content team's approval stands for this version.
 *
 * Only sign-offs on this exact version count, so any edit starts the levels
 * again. A later request for changes, from anyone, cancels an earlier approval:
 * re-running checks on an article that was sent back must not skip straight to
 * the Manager.
 */
export function contentApproved(version: number, signOffs: ReviewSignOff[]): boolean {
  let approved = false;
  for (const signOff of signOffs.filter((s) => s.version === version).sort((a, b) => time(a.at) - time(b.at))) {
    if (signOff.decision === "changes_requested") approved = false;
    else if (signOff.step === "content") approved = true;
  }
  return approved;
}

/** The team whose turn it is: one team, both (publishing), or nobody. */
export function stageTeams(stage: TeamStage): ReviewTeam[] {
  if (stage === "content" || stage === "revision") return ["content"];
  if (stage === "manager") return ["manager"];
  if (stage === "publish") return ["content", "manager"];
  return [];
}

/** User ids on each team. */
export type TeamRoster = Record<ReviewTeam, string[]>;
export const emptyRoster = (): TeamRoster => ({ content: [], manager: [] });

export interface ReviewActor { userId: string; role: Role }

/**
 * Whether someone may act for a team: its members (viewers never), or — when
 * nobody is on that team — the workspace's admins, so that no level can be left
 * with nobody able to sign it off.
 */
export function mayActForTeam(team: ReviewTeam, actor: ReviewActor, roster: TeamRoster): boolean {
  if (actor.role === "viewer") return false;
  const members = roster[team] ?? [];
  if (members.length > 0) return members.includes(actor.userId);
  return actor.role === "admin" || actor.role === "owner";
}

/** Sending an approved article to WordPress: anyone on the Content team or a Manager. */
export function mayPublish(actor: ReviewActor, roster: TeamRoster): boolean {
  return mayActForTeam("content", actor, roster) || mayActForTeam("manager", actor, roster);
}

/**
 * Who may send an article back at each stage: the team whose turn it is, and
 * after approval either team (both can publish, so both can pull it back).
 */
export function mayRequestChanges(stage: TeamStage, actor: ReviewActor, roster: TeamRoster): boolean {
  switch (stage) {
    case "content": return mayActForTeam("content", actor, roster);
    case "manager": return mayActForTeam("manager", actor, roster);
    case "publish":
    case "sent": return mayPublish(actor, roster);
    case "live": return mayActForTeam("manager", actor, roster);
    default: return false;
  }
}

/** The level a request for changes is recorded against. */
export function changesRequestedAt(stage: TeamStage, actor: ReviewActor, roster: TeamRoster): ReviewTeam {
  if (stage === "content") return "content";
  if ((stage === "publish" || stage === "sent") && !mayActForTeam("manager", actor, roster)) return "content";
  return "manager";
}

/** Whether the article is waiting on this person. */
export function isWaitingOn(stage: TeamStage, actor: ReviewActor, roster: TeamRoster): boolean {
  return stageTeams(stage).some((team) => mayActForTeam(team, actor, roster));
}

function time(at: Date | string): number {
  const value = at instanceof Date ? at.getTime() : new Date(at).getTime();
  return Number.isFinite(value) ? value : 0;
}
