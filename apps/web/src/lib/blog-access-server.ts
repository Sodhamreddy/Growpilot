import { cache } from "react";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { workspaceTeamMembers } from "@ob/db";
import { getSession } from "./auth";
import { db } from "./services";
import { isMissingTable } from "./team-review-server";
import { BLOG_HOME, isBlogOnly, teamRoleDuty, teamRoleLabel, type BlogTeam } from "./blog-access";

export interface BlogAccess {
  /** Only Blog Automation is open to this person. */
  blogOnly: boolean;
  teams: BlogTeam[];
  /** "Content team", "Manager"…; null when on no review team. */
  teamLabel: string | null;
  teamDuty: string | null;
}

const NONE: BlogAccess = { blogOnly: false, teams: [], teamLabel: null, teamDuty: null };

/**
 * The signed-in person's review teams in the active workspace, read once per request.
 *
 * Before the team review migration exists there are no teams, so everyone keeps full access.
 */
export const currentBlogAccess = cache(async function currentBlogAccess(): Promise<BlogAccess> {
  const session = await getSession();
  if (!session) return NONE;
  let teams: BlogTeam[] = [];
  try {
    const rows = await db().select({ team: workspaceTeamMembers.team }).from(workspaceTeamMembers)
      .where(and(eq(workspaceTeamMembers.workspaceId, session.workspaceId), eq(workspaceTeamMembers.userId, session.userId)));
    teams = (["content", "manager"] as const).filter((team) => rows.some((row) => row.team === team));
  } catch (error) {
    if (!isMissingTable(error)) throw error;
  }
  return { blogOnly: isBlogOnly(session.role, teams), teams, teamLabel: teamRoleLabel(teams), teamDuty: teamRoleDuty(teams) };
});

/**
 * Guards every section other than Blog Automation: a blog-only member is sent to the blog.
 *
 * Called from each section's layout, so it also runs when someone follows an
 * old link or types the address, not just when the sidebar hides the entry.
 */
export async function requireFullAccess(): Promise<void> {
  if ((await currentBlogAccess()).blogOnly) redirect(BLOG_HOME);
}
