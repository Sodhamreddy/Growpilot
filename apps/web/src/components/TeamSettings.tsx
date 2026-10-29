"use client";

import { useEffect, useState } from "react";

type Member = { id: string; name: string | null; email: string; role: "owner" | "admin" | "editor" | "viewer" };
export function TeamSettings() {
  const [members, setMembers] = useState<Member[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/team", { signal: controller.signal }).then(async res => {
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message ?? "Could not load the team.");
      setMembers(data.members); setCanManage(data.canManage); setLoading(false);
    }).catch(err => { if (!controller.signal.aborted) { setError(err.message); setLoading(false); } });
    return () => controller.abort();
  }, []);

  async function changeRole(member: Member, role: Member["role"]) {
    setBusy(member.id); setError(null); setMessage(null);
    try {
      const res = await fetch("/api/team", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: member.id, role }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message ?? "Could not change that role.");
      setMembers(rows => rows.map(row => row.id === member.id ? { ...row, role } : row));
      setMessage(`Role updated for ${member.name ?? member.email}.`);
    } catch (err) { setError(err instanceof Error ? err.message : "Could not change that role."); }
    finally { setBusy(null); }
  }

  return <div>
    <p className="small muted">Admins manage connections and approvals. Editors prepare content. Viewers can read. Only the workspace owner can change roles.</p>
    {loading ? <p>Loading team…</p> : <div className="tablewrap"><table>
      <thead><tr><th>Member</th><th>Email</th><th>Role</th></tr></thead>
      <tbody>{members.map(member => <tr key={member.id}>
        <td>{member.name ?? "—"}</td><td>{member.email}</td><td>
          {canManage && member.role !== "owner" ? <select aria-label={`Role for ${member.email}`} value={member.role} disabled={busy !== null}
            onChange={event => void changeRole(member, event.target.value as Member["role"])}>
            <option value="admin">Admin</option><option value="editor">Editor</option><option value="viewer">Viewer</option>
          </select> : member.role}
        </td>
      </tr>)}</tbody>
    </table></div>}
    {error ? <p role="alert" className="small" style={{ color: "var(--danger)" }}>{error}</p> : null}
    {message ? <p role="status" className="small">{message}</p> : null}
  </div>;
}
