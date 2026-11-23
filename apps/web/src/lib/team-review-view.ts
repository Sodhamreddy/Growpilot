/**
 * The team review as the article page and the blog queue show it.
 *
 * Built on the server (lib/team-review-server) from the same rules the approve
 * and publish routes enforce, so a button is only offered to someone the
 * server will accept it from.
 */
export type TeamStageName = "drafting" | "revision" | "content" | "manager" | "publish" | "sent" | "live";
export type TeamKey = "content" | "manager";

export interface TeamSignOffView { name: string; at: string }

export interface TeamReviewView {
  stage: TeamStageName;
  /** The Content team's approval of the current version, when it stands. */
  contentBy: TeamSignOffView | null;
  /** The Manager's final approval of the current version. */
  managerBy: TeamSignOffView | null;
  /** The most recent time the article was sent back, while it is being revised. */
  changes: (TeamSignOffView & { note: string | null; level: TeamKey }) | null;
  /** Names on each team, for "waiting for …". Empty means admins act for that team. */
  teams: Record<TeamKey, string[]>;
  /** What the person viewing may do. */
  /** `publish`: send the approved article to WordPress — anyone on either team. */
  can: { content: boolean; manager: boolean; publish: boolean; requestChanges: boolean };
  waitingOnYou: boolean;
}

export const TEAM_LABEL: Record<TeamKey, string> = { content: "Content team", manager: "Managers" };

/** Labels for the blog queue's status column in team review. */
export const STAGE_LABEL: Record<TeamStageName, string> = {
  drafting: "In progress", revision: "Back for changes", content: "Content review", manager: "Manager approval",
  publish: "Ready to publish", sent: "Draft in WordPress", live: "Published",
};

/** "Writer, Rahul", or who acts when a team has nobody on it. */
export function waitingFor(view: TeamReviewView, team: TeamKey): string {
  const names = view.teams[team];
  return names.length ? names.join(", ") : "a workspace admin";
}

/** Who can publish: everyone on either team, each name once. */
export function publishers(view: TeamReviewView): string {
  const names = [...new Set([...view.teams.content, ...view.teams.manager])];
  return names.length ? names.join(", ") : "a workspace admin";
}

/** A short, fixed-format date, identical on server and browser. */
export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
