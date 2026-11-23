import { createHash } from "node:crypto";
import { and, asc, eq, gt, isNull } from "drizzle-orm";
import { AppError, forbidden, newCorrelationId, newToken, notFound, type TenantContext } from "@ob/core";
import { auditLogs, repo, users, workspaceInvites, workspaceMembers, workspaceTeamMembers, workspaces, type ReviewTeamKey } from "@ob/db";
import { REVIEW_TEAMS } from "@ob/pipeline";
import type { db } from "./services";

type Database = ReturnType<typeof db>;
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Teammate invites.
 *
 * An admin creates an invite for one email address and gets a link to send on
 * themselves (no email provider is assumed). The link carries a random token;
 * only its SHA-256 is stored, it works once, and it expires after a week.
 * Opening it either creates the person's account inside the workspace, or adds
 * an existing account once they are signed in as that address.
 */

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export type InviteRole = "admin" | "editor" | "viewer";
export type InviteState = "pending" | "expired" | "revoked" | "accepted";

export const hashInviteToken = (token: string): string => createHash("sha256").update(token).digest("base64url");
const normalizeEmail = (email: string): string => email.trim().toLowerCase();
const onlyTeams = (teams: readonly string[]): ReviewTeamKey[] => [...new Set(teams)].filter((team): team is ReviewTeamKey => REVIEW_TEAMS.includes(team as ReviewTeamKey));
const expiredMessage = "This invite link has expired, was replaced by a newer one, or was already used. Ask your workspace admin for a new link.";

export interface InviteView {
  id: string;
  workspaceId: string;
  workspaceName: string;
  email: string;
  emailNormalized: string;
  role: InviteRole;
  teams: ReviewTeamKey[];
  invitedByName: string | null;
  expiresAt: Date;
  state: InviteState;
}

/** Create an invite and return its one-time token. Replaces any earlier live invite for the same address. */
export async function createInvite(database: Database, ctx: TenantContext, input: { email: string; role: InviteRole; teams: readonly string[] }) {
  const emailNormalized = normalizeEmail(input.email);
  const teams = onlyTeams(input.teams);
  if (input.role === "admin" && ctx.role !== "owner") throw forbidden("Only the workspace owner can invite another admin.");
  if (input.role === "viewer" && teams.length > 0) {
    throw new AppError("validation_failed", "Viewers can only read, so they can't be on a review team. Invite them as an Editor instead.");
  }
  const [member] = await database.select({ id: users.id }).from(workspaceMembers).innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(and(eq(workspaceMembers.workspaceId, ctx.workspaceId), eq(users.emailNormalized, emailNormalized))).limit(1);
  if (member) throw new AppError("conflict", "That person is already in this workspace. Change their role or teams in the member list.");

  const token = newToken(32);
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  const invite = await database.transaction(async (tx) => {
    // One live link per address: a new invite retires the old one, so a forwarded or lost link stops working.
    await tx.update(workspaceInvites).set({ revokedAt: new Date() }).where(and(eq(workspaceInvites.workspaceId, ctx.workspaceId),
      eq(workspaceInvites.emailNormalized, emailNormalized), isNull(workspaceInvites.acceptedAt), isNull(workspaceInvites.revokedAt)));
    const [row] = await tx.insert(workspaceInvites).values({ workspaceId: ctx.workspaceId, email: input.email.trim(), emailNormalized,
      role: input.role, teams, tokenHash: hashInviteToken(token), invitedBy: ctx.userId, expiresAt }).returning();
    await repo.writeAudit(tx as unknown as Database, ctx, { action: "team.invite_created", entityType: "workspace_invite", entityId: row!.id,
      after: { email: row!.email, role: row!.role, teams, expiresAt: expiresAt.toISOString() } });
    return row!;
  });
  return { token, invite };
}

/** Invites still waiting to be used, newest first. */
export async function listPendingInvites(database: Database, ctx: TenantContext) {
  const rows = await database.select({ id: workspaceInvites.id, email: workspaceInvites.email, role: workspaceInvites.role, teams: workspaceInvites.teams,
    expiresAt: workspaceInvites.expiresAt, createdAt: workspaceInvites.createdAt })
    .from(workspaceInvites)
    .where(and(eq(workspaceInvites.workspaceId, ctx.workspaceId), isNull(workspaceInvites.acceptedAt), isNull(workspaceInvites.revokedAt),
      gt(workspaceInvites.expiresAt, new Date())))
    .orderBy(asc(workspaceInvites.createdAt));
  return rows.reverse();
}

export async function revokeInvite(database: Database, ctx: TenantContext, inviteId: string): Promise<void> {
  const [row] = await database.update(workspaceInvites).set({ revokedAt: new Date() })
    .where(and(eq(workspaceInvites.id, inviteId), eq(workspaceInvites.workspaceId, ctx.workspaceId), isNull(workspaceInvites.acceptedAt), isNull(workspaceInvites.revokedAt)))
    .returning({ id: workspaceInvites.id, email: workspaceInvites.email });
  if (!row) throw notFound("pending invite");
  await repo.writeAudit(database, ctx, { action: "team.invite_revoked", entityType: "workspace_invite", entityId: row.id, after: { email: row.email } });
}

/** What an invite link points at, or null when the token matches nothing. */
export async function findInvite(database: Database, token: string): Promise<InviteView | null> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const [row] = await database.select({ invite: workspaceInvites, workspaceName: workspaces.name, inviterName: users.name, inviterEmail: users.email })
    .from(workspaceInvites)
    .innerJoin(workspaces, eq(workspaces.id, workspaceInvites.workspaceId))
    .leftJoin(users, eq(users.id, workspaceInvites.invitedBy))
    .where(eq(workspaceInvites.tokenHash, hashInviteToken(token))).limit(1);
  if (!row) return null;
  const { invite } = row;
  const state: InviteState = invite.acceptedAt ? "accepted" : invite.revokedAt ? "revoked" : invite.expiresAt <= new Date() ? "expired" : "pending";
  return {
    id: invite.id, workspaceId: invite.workspaceId, workspaceName: row.workspaceName, email: invite.email, emailNormalized: invite.emailNormalized,
    role: invite.role as InviteRole, teams: onlyTeams(invite.teams ?? []), expiresAt: invite.expiresAt, state,
    invitedByName: row.inviterName?.trim() || row.inviterEmail?.split("@")[0] || null,
  };
}

/** Whether an account already exists for this address (the join page then asks the person to sign in). */
export async function accountExists(database: Database, email: string): Promise<boolean> {
  const [row] = await database.select({ id: users.id }).from(users).where(eq(users.emailNormalized, normalizeEmail(email))).limit(1);
  return Boolean(row);
}

/** Mark the invite used, atomically, so a link can never be used twice. */
async function claim(tx: Tx, token: string, userId: string) {
  const [invite] = await tx.update(workspaceInvites).set({ acceptedAt: new Date(), acceptedBy: userId })
    .where(and(eq(workspaceInvites.tokenHash, hashInviteToken(token)), isNull(workspaceInvites.acceptedAt), isNull(workspaceInvites.revokedAt),
      gt(workspaceInvites.expiresAt, new Date())))
    .returning();
  if (!invite) throw new AppError("conflict", expiredMessage);
  return invite;
}

/** Add the person to the workspace and to the invite's teams. An existing membership keeps its role. */
async function join(tx: Tx, invite: Awaited<ReturnType<typeof claim>>, userId: string, email: string): Promise<void> {
  await tx.insert(workspaceMembers).values({ workspaceId: invite.workspaceId, userId, role: invite.role }).onConflictDoNothing();
  const teams = invite.role === "viewer" ? [] : onlyTeams(invite.teams ?? []);
  if (teams.length) {
    await tx.insert(workspaceTeamMembers).values(teams.map((team) => ({ workspaceId: invite.workspaceId, userId, team }))).onConflictDoNothing();
  }
  await tx.insert(auditLogs).values({ workspaceId: invite.workspaceId, actorId: userId, actorType: "user", action: "team.member_joined",
    entityType: "workspace_member", entityId: userId, after: { email, role: invite.role, teams, inviteId: invite.id }, correlationId: newCorrelationId() });
}

/** Open an invite as a new person: create their account inside the inviting workspace. */
export async function acceptInviteAsNewUser(database: Database, input: { token: string; name: string; passwordHash: string }) {
  const invite = await findInvite(database, input.token);
  if (!invite || invite.state !== "pending") throw new AppError("conflict", expiredMessage);
  if (await accountExists(database, invite.email)) {
    throw new AppError("conflict", "This email already has a GrowPilot account. Sign in with it, then open the invite link again to join.",
      { details: { reason: "account_exists" } });
  }
  return database.transaction(async (tx) => {
    const [user] = await tx.insert(users).values({ email: invite.email, emailNormalized: invite.emailNormalized, name: input.name.trim(),
      authProvider: "email", passwordHash: input.passwordHash, status: "active" }).returning({ id: users.id });
    const claimed = await claim(tx, input.token, user!.id);
    await join(tx, claimed, user!.id, invite.email);
    return { userId: user!.id, workspaceId: claimed.workspaceId };
  });
}

/** Open an invite while signed in: the account must be the invited address. */
export async function acceptInviteAsMember(database: Database, input: { token: string; userId: string; email: string }) {
  const invite = await findInvite(database, input.token);
  if (!invite || invite.state !== "pending") throw new AppError("conflict", expiredMessage);
  if (normalizeEmail(input.email) !== invite.emailNormalized) {
    throw forbidden(`This invite is for ${invite.email}. Sign out, then open the link again and sign in with that address.`);
  }
  return database.transaction(async (tx) => {
    const claimed = await claim(tx, input.token, input.userId);
    await join(tx, claimed, input.userId, invite.email);
    return { workspaceId: claimed.workspaceId };
  });
}
