/**
 * Blog-only access for review team members.
 *
 * Someone added to the Content team or as a Manager is there to write, review
 * and publish blog articles. Unless they are also an owner or admin, they only
 * see Blog Automation: the other sections (social, reviews, business facts,
 * settings) are not their job, and a sidebar full of them only gets in the way.
 *
 * Kept free of server imports so the rule can be unit tested and shared.
 */
export type BlogTeam = "content" | "manager";

/** Where a blog-only member lands, and the only section they can open. */
export const BLOG_HOME = "/articles";

/** True when this person should only see Blog Automation. Owners and admins always keep everything. */
export function isBlogOnly(role: string, teams: readonly BlogTeam[]): boolean {
  return role === "editor" && teams.length > 0;
}

/** "Content team", "Manager" or "Content team · Manager"; null when on no team. */
export function teamRoleLabel(teams: readonly BlogTeam[]): string | null {
  const labels = [teams.includes("content") ? "Content team" : null, teams.includes("manager") ? "Manager" : null].filter(Boolean);
  return labels.length ? labels.join(" · ") : null;
}

/** One sentence on what this person does in the blog review. */
export function teamRoleDuty(teams: readonly BlogTeam[]): string | null {
  const content = teams.includes("content"), manager = teams.includes("manager");
  if (content && manager) return "You review drafts, give the final approval and send approved articles to WordPress.";
  if (content) return "You review drafts first, then send articles to WordPress once a Manager approves them.";
  if (manager) return "You give the final approval after the Content team, and can send approved articles to WordPress.";
  return null;
}
