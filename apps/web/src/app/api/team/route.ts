export const dynamic = "force-dynamic";

import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { AppError, forbidden, notFound, requireRole } from "@ob/core";
import { repo, workspaces, workspaceMembers, workspaceTeamMembers } from "@ob/db";
import { REVIEW_TEAMS, REVIEW_TEAM_LABELS } from "@ob/pipeline";
import { route, parseBody } from "@/lib/api";
import { db } from "@/lib/services";
import { TEAM_REVIEW_NEEDS_UPDATE, isMissingTable, loadTeamSetup } from "@/lib/team-review-server";
import { listPendingInvites } from "@/lib/invites";

export const GET = route(async (ctx) => {
  requireRole(ctx, "admin");
  const database = db();
  const setup = await loadTeamSetup(database, ctx);
  let invites: Awaited<ReturnType<typeof listPendingInvites>> = [];
  if (setup.available) {
    try { invites = await listPendingInvites(database, ctx); } catch (error) { if (!isMissingTable(error)) throw error; }
  }
  return {
    members: Object.entries(setup.people).map(([id, person]) => ({ id, name: person.name, email: person.email, role: person.role,
      teams: REVIEW_TEAMS.filter((team) => setup.roster[team].includes(id)) })),
    invites,
    reviewProcess: setup.process,
    available: setup.available,
    currentUserId: ctx.userId,
    canManageRoles: ctx.role === "owner",
    canInviteAdmins: ctx.role === "owner",
  };
});

const teamKey = z.enum(["content", "manager"]);
const schema = z.union([
  z.object({ userId: z.string().uuid(), role: z.enum(["admin", "editor", "viewer"]) }).strict(),
  z.object({ userId: z.string().uuid(), teams: z.array(teamKey).max(2) }).strict(),
  z.object({ reviewProcess: z.enum(["single", "team"]) }).strict(),
]);

export const PATCH = route(async (ctx, req) => {
  requireRole(ctx, "admin");
  const body = await parseBody(req, schema);
  const database = db();

  if ("reviewProcess" in body) {
    const setup = await loadTeamSetup(database, ctx);
    if (body.reviewProcess === "team") {
      if (!setup.available) throw new AppError("dependency_unavailable", TEAM_REVIEW_NEEDS_UPDATE);
      const empty = REVIEW_TEAMS.filter((team) => setup.roster[team].length === 0).map((team) => REVIEW_TEAM_LABELS[team]);
      if (empty.length) throw new AppError("validation_failed", `Add at least one person to every team first. Still empty: ${empty.join(", ")}.`);
    }
    await database.transaction(async (tx) => {
      const [workspace] = await tx.select({ settings: workspaces.settings }).from(workspaces).where(eq(workspaces.id, ctx.workspaceId)).for("update");
      await tx.update(workspaces).set({ settings: { ...(workspace?.settings ?? {}), reviewProcess: body.reviewProcess }, updatedAt: new Date() })
        .where(eq(workspaces.id, ctx.workspaceId));
      await repo.writeAudit(tx as unknown as ReturnType<typeof db>, ctx, { action: "workspace.review_process_changed", entityType: "workspace",
        entityId: ctx.workspaceId, before: { reviewProcess: workspace?.settings?.reviewProcess ?? "single" }, after: { reviewProcess: body.reviewProcess } });
    });
    return { ok: true, reviewProcess: body.reviewProcess };
  }

  if ("teams" in body) {
    const [member] = await database.select({ role: workspaceMembers.role }).from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, ctx.workspaceId), eq(workspaceMembers.userId, body.userId))).limit(1);
    if (!member) throw notFound("team member");
    const teams = [...new Set(body.teams)];
    if (member.role === "viewer" && teams.length) {
      throw new AppError("validation_failed", "Viewers can only read, so they can't be on a review team. Make them an Editor first.");
    }
    try {
      await database.transaction(async (tx) => {
        await tx.delete(workspaceTeamMembers).where(and(eq(workspaceTeamMembers.workspaceId, ctx.workspaceId), eq(workspaceTeamMembers.userId, body.userId)));
        if (teams.length) await tx.insert(workspaceTeamMembers).values(teams.map((team) => ({ workspaceId: ctx.workspaceId, userId: body.userId, team })));
        await repo.writeAudit(tx as unknown as ReturnType<typeof db>, ctx, { action: "team.teams_changed", entityType: "workspace_member",
          entityId: body.userId, after: { teams } });
      });
    } catch (error) {
      if (isMissingTable(error)) throw new AppError("dependency_unavailable", TEAM_REVIEW_NEEDS_UPDATE);
      throw error;
    }
    return { ok: true, teams };
  }

  // Role changes stay with the owner, as before.
  requireRole(ctx, "owner");
  await database.transaction(async (tx) => {
    const [workspace] = await tx.select({ ownerId: workspaces.ownerId }).from(workspaces)
      .where(eq(workspaces.id, ctx.workspaceId)).for("update");
    if (!workspace || workspace.ownerId !== ctx.userId) throw forbidden("Only the workspace owner can change team roles.");
    const [member] = await tx.select().from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, ctx.workspaceId), eq(workspaceMembers.userId, body.userId))).limit(1);
    if (!member) throw notFound("team member");
    if (member.role === "owner" || body.userId === workspace.ownerId) throw forbidden("The workspace owner's role cannot be changed here.");
    await tx.update(workspaceMembers).set({ role: body.role })
      .where(and(eq(workspaceMembers.workspaceId, ctx.workspaceId), eq(workspaceMembers.userId, body.userId)));
    await repo.writeAudit(tx as unknown as ReturnType<typeof db>, ctx, {
      action: "team.role_changed", entityType: "workspace_member", entityId: body.userId,
      before: { role: member.role }, after: { role: body.role },
    });
  });
  // A viewer can only read, so they leave every review team. Kept outside the role
  // change itself so a database without the team tables still changes roles.
  if (body.role === "viewer") {
    try {
      await database.delete(workspaceTeamMembers).where(and(eq(workspaceTeamMembers.workspaceId, ctx.workspaceId), eq(workspaceTeamMembers.userId, body.userId)));
    } catch (error) { if (!isMissingTable(error)) throw error; }
  }
  return { ok: true };
});
