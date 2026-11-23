import { and, asc, eq, inArray } from "drizzle-orm";
import type { Role, TenantContext } from "@ob/core";
import { articleReviews, users, workspaceMembers, workspaceTeamMembers, workspaces } from "@ob/db";
import {
  REVIEW_TEAMS, contentApproved, emptyRoster, isWaitingOn, mayActForTeam, mayPublish, mayRequestChanges, reviewProcessOf, teamReviewStage,
  type ReviewActor, type ReviewProcess, type ReviewSignOff, type ReviewTeam, type TeamRoster,
} from "@ob/pipeline";
import type { TeamReviewView, TeamSignOffView } from "./team-review-view";
import type { db } from "./services";

type Database = ReturnType<typeof db>;

/**
 * A query against a table this database does not have yet.
 *
 * The team review tables arrive in a migration (post_0016). Until it is
 * applied, everything that only the team review uses must degrade to "not
 * available" instead of breaking pages every workspace uses.
 */
export function isMissingTable(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 4; current = (current as { cause?: unknown }).cause, depth++) {
    if ((current as { code?: unknown }).code === "42P01") return true;
  }
  return false;
}

/** Shown wherever the team review is asked for before its database update has been applied. */
export const TEAM_REVIEW_NEEDS_UPDATE = "Team review needs a one-time database update before it can be used. Ask your developer to apply migration post_0016_team_review.";

export interface TeamPerson { name: string; email: string; role: Role }

export interface TeamSetup {
  process: ReviewProcess;
  roster: TeamRoster;
  people: Record<string, TeamPerson>;
  /** False until the team review tables exist in this database. */
  available: boolean;
}

/** The workspace's review process, read from its settings. */
export async function reviewProcessFor(database: Database, ctx: TenantContext): Promise<ReviewProcess> {
  const [workspace] = await database.select({ settings: workspaces.settings }).from(workspaces)
    .where(eq(workspaces.id, ctx.workspaceId)).limit(1);
  return reviewProcessOf(workspace?.settings);
}

/**
 * Members, their review teams and the review process, in one call.
 *
 * Viewers are left off every team even if a row says otherwise: they can only
 * read, and a level must never wait on someone who cannot act.
 */
export async function loadTeamSetup(database: Database, ctx: TenantContext): Promise<TeamSetup> {
  const [[workspace], members] = await Promise.all([
    database.select({ settings: workspaces.settings }).from(workspaces).where(eq(workspaces.id, ctx.workspaceId)).limit(1),
    database.select({ id: users.id, name: users.name, email: users.email, role: workspaceMembers.role })
      .from(workspaceMembers).innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(eq(workspaceMembers.workspaceId, ctx.workspaceId)).orderBy(asc(users.email)),
  ]);
  const people: Record<string, TeamPerson> = Object.fromEntries(members.map((member) => [member.id,
    { name: member.name?.trim() || member.email.split("@")[0]!, email: member.email, role: member.role }]));
  const roster = emptyRoster();
  let available = true;
  try {
    const rows = await database.select({ userId: workspaceTeamMembers.userId, team: workspaceTeamMembers.team })
      .from(workspaceTeamMembers).where(eq(workspaceTeamMembers.workspaceId, ctx.workspaceId));
    for (const row of rows) {
      const person = people[row.userId];
      if (person && person.role !== "viewer" && REVIEW_TEAMS.includes(row.team)) roster[row.team].push(row.userId);
    }
  } catch (error) {
    if (!isMissingTable(error)) throw error;
    available = false;
  }
  return { process: available ? reviewProcessOf(workspace?.settings) : "single", roster, people, available };
}

export interface RecordedSignOff extends ReviewSignOff {
  articleId: string;
  userId: string | null;
  note: string | null;
}

/** Every recorded sign-off for these articles, oldest first. */
export async function loadSignOffs(database: Database, ctx: TenantContext, articleIds: string[]): Promise<RecordedSignOff[]> {
  if (articleIds.length === 0) return [];
  const rows = await database.select({ articleId: articleReviews.articleId, version: articleReviews.articleVersion, step: articleReviews.step,
    decision: articleReviews.decision, userId: articleReviews.userId, note: articleReviews.note, at: articleReviews.createdAt })
    .from(articleReviews)
    .where(and(eq(articleReviews.workspaceId, ctx.workspaceId), inArray(articleReviews.articleId, articleIds)))
    .orderBy(asc(articleReviews.createdAt));
  return rows.map((row) => ({ ...row, step: row.step as ReviewTeam }));
}

/** Names of a team's members, for "waiting for …" lines. */
export function teamNames(setup: TeamSetup, team: ReviewTeam): string[] {
  return setup.roster[team].map((id) => setup.people[id]?.name).filter((name): name is string => Boolean(name));
}

/** What the article page shows about the team review, from the same rules the routes enforce. */
export function teamReviewView(input: {
  article: { status: string; version: number };
  setup: TeamSetup;
  signOffs: RecordedSignOff[];
  delivered: boolean;
  actor: ReviewActor;
}): TeamReviewView {
  const { article, setup, signOffs, actor } = input;
  const stage = teamReviewStage(article, signOffs, { delivered: input.delivered });
  const current = signOffs.filter((signOff) => signOff.version === article.version);
  const person = (signOff: RecordedSignOff | undefined): TeamSignOffView | null => signOff
    ? { name: (signOff.userId && setup.people[signOff.userId]?.name) || "A former teammate", at: new Date(signOff.at).toISOString() }
    : null;
  const latest = (list: RecordedSignOff[], match: (signOff: RecordedSignOff) => boolean) => [...list].reverse().find(match);
  const changes = stage === "revision" ? latest(signOffs, (signOff) => signOff.decision === "changes_requested") : undefined;
  return {
    stage,
    contentBy: contentApproved(article.version, current) ? person(latest(current, (s) => s.step === "content" && s.decision === "approved")) : null,
    managerBy: ["publish", "sent", "live"].includes(stage) ? person(latest(current, (s) => s.step === "manager" && s.decision === "approved")) : null,
    changes: changes ? { ...person(changes)!, note: changes.note, level: changes.step } : null,
    teams: { content: teamNames(setup, "content"), manager: teamNames(setup, "manager") },
    can: {
      content: mayActForTeam("content", actor, setup.roster),
      manager: mayActForTeam("manager", actor, setup.roster),
      publish: mayPublish(actor, setup.roster),
      requestChanges: mayRequestChanges(stage, actor, setup.roster),
    },
    waitingOnYou: isWaitingOn(stage, actor, setup.roster),
  };
}
