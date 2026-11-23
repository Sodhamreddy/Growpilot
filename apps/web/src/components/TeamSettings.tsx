"use client";

import { useCallback, useEffect, useState } from "react";
import styles from "./TeamSettings.module.css";

type Team = "content" | "manager";
type Role = "owner" | "admin" | "editor" | "viewer";
type Member = { id: string; name: string; email: string; role: Role; teams: Team[] };
type Invite = { id: string; email: string; role: Role; teams: Team[]; expiresAt: string };
type TeamData = {
  members: Member[]; invites: Invite[]; reviewProcess: "single" | "team"; available: boolean;
  currentUserId: string; canManageRoles: boolean; canInviteAdmins: boolean;
};

const TEAMS: { key: Team; label: string; short: string; help: string }[] = [
  { key: "content", label: "Content team", short: "Content", help: "Review each draft and approve it for a Manager. Can publish approved articles." },
  { key: "manager", label: "Managers", short: "Manager", help: "Give the final approval, or send the draft back for changes. Can publish approved articles." },
];
const STEPS = ["Content review", "Manager approval", "Publish (Content or Manager)"];
const ROLE_LABEL: Record<Role, string> = { owner: "Owner", admin: "Admin", editor: "Editor", viewer: "Viewer" };
const teamLabel = (key: Team) => TEAMS.find((team) => team.key === key)!.short;
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

async function send(url: string, method: string, body?: unknown) {
  const res = await fetch(url, { method, ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const fields = data.error?.details?.fields as Record<string, string> | undefined;
    throw new Error((fields && Object.values(fields)[0]) || data.error?.message || "That did not work. Please try again.");
  }
  return data;
}

/**
 * Settings → Team: who is in the workspace, which review team each person is on,
 * how articles are approved, and invites for new teammates.
 */
export function TeamSettings() {
  const [data, setData] = useState<TeamData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [process, setProcess] = useState<"single" | "team">("single");
  const [invite, setInvite] = useState<{ email: string; role: "admin" | "editor" | "viewer"; teams: Team[] }>({ email: "", role: "editor", teams: [] });
  const [created, setCreated] = useState<{ link: string; email: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    const res = await fetch("/api/team", { signal, cache: "no-store" });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error?.message ?? "Could not load the team.");
    setData(body); setProcess(body.reviewProcess);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).catch((err) => { if (!controller.signal.aborted) setLoadError(err instanceof Error ? err.message : "Could not load the team."); });
    return () => controller.abort();
  }, [load]);

  async function act(key: string, work: () => Promise<string | void>) {
    setBusy(key); setError(null); setMessage(null);
    try { const done = await work(); await load(); if (done) setMessage(done); }
    catch (err) { setError(err instanceof Error ? err.message : "That did not work. Please try again."); }
    finally { setBusy(null); }
  }

  if (loadError) return <p role="alert" className={styles.error}>{loadError}</p>;
  if (!data) return <p className={styles.muted}>Loading team…</p>;

  const emptyTeams = TEAMS.filter((team) => !data.members.some((member) => member.teams.includes(team.key)));
  const toggleTeam = (member: Member, key: Team, on: boolean) => act(`teams:${member.id}`, async () => {
    const teams = on ? [...member.teams, key] : member.teams.filter((team) => team !== key);
    await send("/api/team", "PATCH", { userId: member.id, teams });
    return `${member.name} ${on ? "joined" : "left"} ${TEAMS.find((team) => team.key === key)!.label}.`;
  });
  const changeRole = (member: Member, role: Role) => act(`role:${member.id}`, async () => {
    await send("/api/team", "PATCH", { userId: member.id, role });
    return `${member.name} is now ${ROLE_LABEL[role].toLowerCase() === "admin" ? "an admin" : `a ${ROLE_LABEL[role].toLowerCase()}`}.`;
  });

  return <div className={styles.team}>
    <section className={styles.block} aria-labelledby="review-process-title">
      <h3 id="review-process-title">How articles are approved</h3>
      <fieldset className={styles.choices} disabled={busy !== null}>
        <legend className={styles.srOnly}>Review process</legend>
        <label className={styles.choice} data-selected={process === "single"}>
          <input type="radio" name="review-process" value="single" checked={process === "single"} onChange={() => setProcess("single")} />
          <span><strong>One reviewer</strong><small>Any editor or admin approves an article. An admin sends it to WordPress.</small></span>
        </label>
        <label className={styles.choice} data-selected={process === "team"}>
          <input type="radio" name="review-process" value="team" checked={process === "team"} disabled={!data.available} onChange={() => setProcess("team")} />
          <span><strong>Team review</strong><small>The Content team approves the draft, a Manager gives the final approval, then anyone on either team sends it to WordPress:</small>
            <ol className={styles.flow}>{STEPS.map((step, index) => <li key={step}><b>{index + 1}</b>{step}</li>)}</ol>
          </span>
        </label>
      </fieldset>
      {!data.available && <p className={styles.notice}>Team review needs a one-time database update before it can be switched on. Ask your developer to apply migration post_0016_team_review.</p>}
      {process === "team" && emptyTeams.length > 0 && data.available &&
        <p className={styles.warning}>Add at least one person to {emptyTeams.map((team) => team.label).join(", ")} below before switching team review on.</p>}
      {process !== data.reviewProcess && <div className={styles.row}>
        <button type="button" className="btn primary" disabled={busy !== null || (process === "team" && emptyTeams.length > 0)}
          onClick={() => void act("process", async () => {
            await send("/api/team", "PATCH", { reviewProcess: process });
            return process === "team" ? "Team review is on. New approvals go through the three levels." : "One reviewer is back on.";
          })}>{busy === "process" ? "Saving…" : process === "team" ? "Switch to team review" : "Switch to one reviewer"}</button>
        <button type="button" className="btn" disabled={busy !== null} onClick={() => setProcess(data.reviewProcess)}>Cancel</button>
      </div>}
    </section>

    <section className={styles.block} aria-labelledby="members-title">
      <h3 id="members-title">Members and review teams</h3>
      <p className={styles.muted}>Only people on a team can sign off its level. If a team has nobody, workspace admins can. Viewers can only read. Editors on a team see only Blog Automation.</p>
      <div className={styles.tableWrap}><table className={styles.table}>
        <thead><tr><th scope="col">Member</th><th scope="col">Role</th>{TEAMS.map((team) => <th key={team.key} scope="col" title={team.help}>{team.short}</th>)}</tr></thead>
        <tbody>{data.members.map((member) => <tr key={member.id}>
          <td><strong>{member.name}{member.id === data.currentUserId ? " (you)" : ""}</strong><small>{member.email}</small></td>
          <td>{data.canManageRoles && member.role !== "owner"
            ? <select aria-label={`Role for ${member.email}`} value={member.role} disabled={busy !== null} onChange={(event) => void changeRole(member, event.target.value as Role)}>
              <option value="admin">Admin</option><option value="editor">Editor</option><option value="viewer">Viewer</option>
            </select>
            : ROLE_LABEL[member.role]}</td>
          {TEAMS.map((team) => <td key={team.key} className={styles.check}>
            <input type="checkbox" aria-label={`${member.name} on ${team.label}`} checked={member.teams.includes(team.key)}
              disabled={busy !== null || !data.available || member.role === "viewer"}
              title={member.role === "viewer" ? "Viewers can only read. Make them an Editor first." : team.help}
              onChange={(event) => void toggleTeam(member, team.key, event.target.checked)} />
          </td>)}
        </tr>)}</tbody>
      </table></div>
    </section>

    <section className={styles.block} aria-labelledby="invite-title">
      <h3 id="invite-title">Invite a teammate</h3>
      <form className={styles.inviteForm} onSubmit={(event) => {
        event.preventDefault();
        void act("invite", async () => {
          const result = await send("/api/team/invites", "POST", { email: invite.email, role: invite.role, teams: invite.role === "viewer" ? [] : invite.teams });
          setCreated({ link: result.link, email: result.invite.email, expiresAt: result.invite.expiresAt }); setCopied(false);
          setInvite({ email: "", role: "editor", teams: [] });
        });
      }}>
        <label className={styles.field}><span>Email</span>
          <input type="email" required value={invite.email} placeholder="teammate@youragency.com" disabled={!data.available}
            onChange={(event) => setInvite({ ...invite, email: event.target.value })} /></label>
        <label className={styles.field}><span>Role</span>
          <select value={invite.role} disabled={!data.available} onChange={(event) => setInvite({ ...invite, role: event.target.value as typeof invite.role })}>
            <option value="editor">Editor</option>{data.canInviteAdmins && <option value="admin">Admin</option>}<option value="viewer">Viewer</option>
          </select></label>
        <fieldset className={styles.teamPicks} disabled={!data.available || invite.role === "viewer"}>
          <legend>Review teams</legend>
          {TEAMS.map((team) => <label key={team.key}><input type="checkbox" checked={invite.role !== "viewer" && invite.teams.includes(team.key)}
            onChange={(event) => setInvite({ ...invite, teams: event.target.checked ? [...invite.teams, team.key] : invite.teams.filter((key) => key !== team.key) })} />{team.short}</label>)}
        </fieldset>
        <button type="submit" className="btn primary" disabled={busy !== null || !data.available}>{busy === "invite" ? "Creating…" : "Create invite link"}</button>
      </form>
      {created && <div className={styles.created} role="status">
        <strong>Invite link for {created.email}</strong>
        <div className={styles.linkRow}>
          <input readOnly value={created.link} aria-label="Invite link" onFocus={(event) => event.currentTarget.select()} />
          <button type="button" className="btn" onClick={() => void navigator.clipboard.writeText(created.link).then(() => setCopied(true), () => setCopied(false))}>{copied ? "Copied" : "Copy link"}</button>
        </div>
        <small>Send it to them yourself, for example in Teams or email. It works once and expires on {day(created.expiresAt)}. It isn&apos;t shown again: if it&apos;s lost, create a new invite.</small>
      </div>}
      {data.invites.length > 0 && <div className={styles.pending}>
        <h4>Waiting to join</h4>
        <ul>{data.invites.map((item) => <li key={item.id}>
          <span><strong>{item.email}</strong><small>{ROLE_LABEL[item.role]}{item.teams.length ? ` · ${item.teams.map(teamLabel).join(", ")}` : ""} · link expires {day(item.expiresAt)}</small></span>
          <button type="button" className="btn" disabled={busy !== null} onClick={() => void act(`revoke:${item.id}`, async () => {
            await send(`/api/team/invites/${item.id}`, "DELETE");
            return `The invite for ${item.email} was cancelled. Its link no longer works.`;
          })}>Cancel invite</button>
        </li>)}</ul>
      </div>}
    </section>

    {error && <p role="alert" className={styles.error}>{error}</p>}
    {message && <p role="status" className={styles.message}>{message}</p>}
  </div>;
}
