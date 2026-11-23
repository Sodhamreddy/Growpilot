import { Logo } from "@/components/Logo";
import { IconCheck } from "@/components/Icons";
import { JoinWorkspace, type JoinView } from "@/components/JoinWorkspace";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/services";
import { accountExists, findInvite, type InviteView } from "@/lib/invites";
import { isMissingTable } from "@/lib/team-review-server";

export const dynamic = "force-dynamic";

const TEAM_DUTY: Record<string, string> = {
  content: "Content team: review drafts, approve them for a Manager, and publish approved articles",
  manager: "Manager: give the final approval or send drafts back, and publish approved articles",
};
const ROLE_LABEL: Record<string, string> = { admin: "an admin", editor: "an editor", viewer: "a viewer" };
const TEAM_NAME: Record<string, string> = { content: "the Content team", manager: "the Managers" };

/** "as an editor, on the Content team and the Managers" — shown beside the form, since phones hide the side panel. */
function joiningAs(invite: InviteView): string {
  const teams = invite.teams.map((team) => TEAM_NAME[team] ?? team);
  const list = teams.length > 1 ? `${teams.slice(0, -1).join(", ")} and ${teams.at(-1)}` : teams[0];
  return `as ${ROLE_LABEL[invite.role] ?? invite.role}${list ? `, on ${list}` : ""}`;
}

/**
 * /join/:token — where a teammate invite link lands.
 *
 * Public: the person may not have an account yet. What they see depends on the
 * invite and on who, if anyone, is signed in on this browser.
 */
export default async function JoinPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const database = db();
  let invite: InviteView | null = null;
  try { invite = await findInvite(database, token); } catch (error) { if (!isMissingTable(error)) throw error; }
  const session = await getSession();

  let view: JoinView;
  if (!invite) view = { kind: "ended", reason: "invalid" };
  else if (invite.state !== "pending") view = { kind: "ended", reason: invite.state };
  else if (session) {
    view = session.email.trim().toLowerCase() === invite.emailNormalized
      ? { kind: "accept", workspaceName: invite.workspaceName, joiningAs: joiningAs(invite) }
      : { kind: "wrong-account", signedInAs: session.email, invitedEmail: invite.email };
  } else if (await accountExists(database, invite.email)) view = { kind: "sign-in", invitedEmail: invite.email };
  else view = { kind: "create", invitedEmail: invite.email, workspaceName: invite.workspaceName, joiningAs: joiningAs(invite) };

  return (
    <div className="auth">
      <aside className="auth-brand">
        <div className="auth-mark"><Logo size={28} className="logo" /><span className="wordmark">GrowPilot <span>Studio</span></span></div>
        {invite && invite.state === "pending" ? <>
          <h1 className="auth-pitch">Join <span>{invite.workspaceName}</span></h1>
          <p className="auth-sub">{invite.invitedByName ? `${invite.invitedByName} invited you` : "You were invited"} as {ROLE_LABEL[invite.role] ?? invite.role}.</p>
          {invite.teams.length > 0 && <ul className="auth-points">{invite.teams.map((team) => <li key={team}>
            <span className="ico"><IconCheck size={16} /></span>
            <span><strong>{TEAM_DUTY[team]?.split(":")[0]}</strong><span className="desc">{TEAM_DUTY[team]?.split(": ")[1]}</span></span>
          </li>)}</ul>}
        </> : <>
          <h1 className="auth-pitch">Team <span>invites</span></h1>
          <p className="auth-sub">Invite links work once and expire after a week.</p>
        </>}
      </aside>
      <div className="auth-form-side">
        <div className="auth-form-inner">
          <div className="auth-mobile-mark"><Logo size={26} className="logo" /><span className="wordmark">GrowPilot <span>Studio</span></span></div>
          <JoinWorkspace token={token} view={view} />
        </div>
      </div>
    </div>
  );
}
