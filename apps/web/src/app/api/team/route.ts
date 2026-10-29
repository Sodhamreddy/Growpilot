export const dynamic = "force-dynamic";

import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { forbidden, notFound, requireRole } from "@ob/core";
import { repo, users, workspaces, workspaceMembers } from "@ob/db";
import { route, parseBody } from "@/lib/api";
import { db } from "@/lib/services";

export const GET = route(async ctx => {
  requireRole(ctx, "admin");
  const members = await db().select({ id: users.id, name: users.name, email: users.email, role: workspaceMembers.role })
    .from(workspaceMembers).innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, ctx.workspaceId)).orderBy(users.email);
  return { members, canManage: ctx.role === "owner" };
});

const schema = z.object({ userId: z.string().uuid(), role: z.enum(["admin", "editor", "viewer"]) });
export const PATCH = route(async (ctx, req) => {
  requireRole(ctx, "owner");
  const body = await parseBody(req, schema);
  const database = db();
  await database.transaction(async tx => {
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
  return { ok: true };
});
