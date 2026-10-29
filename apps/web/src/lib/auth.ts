import { createHash } from "node:crypto";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { and, eq, gt, isNull } from "drizzle-orm";
import {
  config, newToken, newCorrelationId, unauthorized, forbidden,
  hashPassword, hashPasswordAsync, verifyPasswordAsync, slugify,
  type TenantContext, type Role,
} from "@ob/core";
import {
  getDb, users, workspaces, workspaceMembers, sessions, passwordResets,
} from "@ob/db";

/**
 * Session authentication — spec §2.1 and §15.
 *
 * Sessions are opaque server-side records. The cookie holds a random token;
 * only its SHA-256 is stored, so a database leak does not yield usable
 * sessions. `requireTenant` is the single entry point every API route uses to
 * obtain a `TenantContext`, which is in turn the only way to reach data.
 */

const COOKIE_NAME = "ob_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const hashToken = (token: string): string =>
  createHash("sha256").update(token).digest("base64url");

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

function db() {
  return getDb(config().DATABASE_URL);
}

// ─── Sign-up and sign-in ────────────────────────────────────────────────────

export interface AuthResult {
  userId: string;
  workspaceId: string;
}

/** Spec §2.1: create identity and workspace together — the tenant boundary. */
export async function signUpWithEmail(input: {
  email: string;
  password: string;
  name?: string;
  workspaceName?: string;
}): Promise<AuthResult> {
  const emailNormalized = normalizeEmail(input.email);
  const database = db();

  const passwordHashPromise = hashPasswordAsync(input.password);

  const [existing] = await database
    .select({ id: users.id })
    .from(users)
    .where(eq(users.emailNormalized, emailNormalized))
    .limit(1);

  if (existing) {
    // Do not reveal whether an address is registered.
    throw unauthorized("That email address cannot be used to sign up.");
  }

  const passwordHash = await passwordHashPromise;
  return database.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        email: input.email.trim(),
        emailNormalized,
        name: input.name?.trim() ?? null,
        authProvider: "email",
        passwordHash,
        status: "active",
      })
      .returning();

    const baseName = input.workspaceName?.trim() || `${input.name?.trim() ?? "My"} workspace`;
    const [workspace] = await tx
      .insert(workspaces)
      .values({
        ownerId: user!.id,
        name: baseName,
        slug: `${slugify(baseName) || "workspace"}-${newToken(4)}`,
        settings: {
          requireApprovalBeforePublish: true,
          requireHumanReviewForSensitive: true,
          minSeoScoreToPublish: 70,
          minVoiceScoreToPublish: 70,
        },
      })
      .returning();

    await tx.insert(workspaceMembers).values({
      workspaceId: workspace!.id,
      userId: user!.id,
      role: "owner",
    });

    return { userId: user!.id, workspaceId: workspace!.id };
  });
}

export async function signInWithEmail(input: {
  email: string;
  password: string;
}): Promise<AuthResult> {
  const database = db();
  const [account] = await database
    .select({ user: users, workspaceId: workspaceMembers.workspaceId })
    .from(users)
    .leftJoin(workspaceMembers, eq(workspaceMembers.userId, users.id))
    .where(eq(users.emailNormalized, normalizeEmail(input.email)))
    .limit(1);

  const user = account?.user;

  // Always run a hash comparison so a missing account and a wrong password
  // take the same time — otherwise the endpoint enumerates users.
  const stored = user?.passwordHash ?? DUMMY_HASH;
  const valid = await verifyPasswordAsync(input.password, stored);

  if (!user || !valid || user.status !== "active") {
    throw unauthorized("That email or password is not correct.");
  }

  if (!account.workspaceId) throw forbidden("This account is not a member of any workspace.");

  void database
    .update(users)
    .set({ lastSeenAt: new Date() })
    .where(eq(users.id, user.id))
    .catch(() => undefined);
  return { userId: user.id, workspaceId: account.workspaceId };
}

/** Pre-computed so the timing-equalising comparison costs the same as a real one. */
const DUMMY_HASH = hashPassword("dummy-password-for-timing-equalisation");

// ─── Google sign-in ─────────────────────────────────────────────────────────

/**
 * Sign in, or create an account, from a verified Google identity.
 *
 * The caller must have already verified the ID token — this function trusts
 * `email` completely, so handing it an unverified value would let anyone claim
 * any address.
 *
 * An email signup does not prove ownership of the address. Never silently link
 * it to Google: the original password and sessions could belong to someone
 * who pre-registered another person's address.
 */
export async function signInWithGoogle(input: {
  email: string;
  emailVerified: boolean;
  name?: string | null;
}): Promise<AuthResult & { created: boolean }> {
  if (!input.emailVerified) {
    // An unverified Google address proves nothing about who is signing in.
    throw unauthorized("That Google account has no verified email address.");
  }

  const emailNormalized = normalizeEmail(input.email);
  const database = db();

  const [existing] = await database
    .select({ id: users.id, status: users.status, authProvider: users.authProvider })
    .from(users)
    .where(eq(users.emailNormalized, emailNormalized))
    .limit(1);

  if (existing) {
    if (existing.status !== "active") throw forbidden("That account is not active.");
    if (existing.authProvider !== "google") throw new GoogleAccountLinkRequired();

    const [membership] = await database
      .select({ workspaceId: workspaceMembers.workspaceId })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, existing.id))
      .limit(1);

    if (!membership) throw forbidden("This account is not a member of any workspace.");

    await database
      .update(users)
      .set({ lastSeenAt: new Date() })
      .where(eq(users.id, existing.id));

    return { userId: existing.id, workspaceId: membership.workspaceId, created: false };
  }

  // New account. Mirrors signUpWithEmail, except there is no password to store:
  // `passwordHash` stays null, and sign-in for this account goes through Google
  // until someone sets a password via the reset flow.
  const created = await database.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        email: input.email.trim(),
        emailNormalized,
        name: input.name?.trim() ?? null,
        authProvider: "google",
        passwordHash: null,
        status: "active",
      })
      .returning();

    const baseName = `${input.name?.trim() ?? "My"} workspace`;
    const [workspace] = await tx
      .insert(workspaces)
      .values({
        ownerId: user!.id,
        name: baseName,
        slug: `${slugify(baseName) || "workspace"}-${newToken(4)}`,
        settings: {
          requireApprovalBeforePublish: true,
          requireHumanReviewForSensitive: true,
          minSeoScoreToPublish: 70,
          minVoiceScoreToPublish: 70,
        },
      })
      .returning();

    await tx.insert(workspaceMembers).values({
      workspaceId: workspace!.id,
      userId: user!.id,
      role: "owner",
    });

    return { userId: user!.id, workspaceId: workspace!.id };
  });

  return { ...created, created: true };
}

export class GoogleAccountLinkRequired extends Error {
  constructor() {
    super("Use email sign-in for this account. Google accounts are not automatically linked to email accounts.");
    this.name = "GoogleAccountLinkRequired";
  }
}

// ─── Password reset ─────────────────────────────────────────────────────────

/** How long a reset link stays valid. Short, because email is not a secure channel. */
const RESET_TTL_MS = 60 * 60 * 1000;

/**
 * Begin a reset. Returns the raw token, or null when there is no such account.
 *
 * The caller must NOT tell the browser which of those happened. Whether an
 * email address has an account here is not public information, and a form that
 * answers that question is a user-enumeration endpoint whatever else it does.
 * The route therefore returns the same response either way and only the email
 * differs — which is exactly the point: the person who owns the inbox finds out,
 * and nobody else does.
 */
export async function beginPasswordReset(email: string): Promise<{
  token: string;
  userId: string;
  name: string | null;
} | null> {
  const database = db();
  const [user] = await database
    .select({ id: users.id, name: users.name, status: users.status })
    .from(users)
    .where(eq(users.emailNormalized, normalizeEmail(email)))
    .limit(1);

  if (!user || user.status !== "active") return null;

  /*
   * Invalidate any outstanding link for this account.
   *
   * Requesting a new reset should retire the old one: otherwise every request
   * leaves another working key in another inbox, and a link forwarded or leaked
   * weeks ago still opens the account.
   */
  await database
    .update(passwordResets)
    .set({ usedAt: new Date() })
    .where(and(eq(passwordResets.userId, user.id), isNull(passwordResets.usedAt)));

  const token = newToken(32);
  const hdrs = await headers();

  await database.insert(passwordResets).values({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + RESET_TTL_MS),
    requestedIp: hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
  });

  return { token, userId: user.id, name: user.name };
}

/**
 * Complete a reset.
 *
 * Every existing session is destroyed on success. A password reset is the
 * action someone takes when they think their account is compromised, and
 * leaving the attacker's session alive would make it useless.
 */
export async function completePasswordReset(
  token: string,
  newPassword: string,
): Promise<{ userId: string }> {
  const database = db();

  const passwordHash = await hashPasswordAsync(newPassword);
  return database.transaction(async (tx) => {
    const [claimed] = await tx.update(passwordResets).set({ usedAt: new Date() })
      .where(and(eq(passwordResets.tokenHash, hashToken(token)), isNull(passwordResets.usedAt), gt(passwordResets.expiresAt, new Date())))
      .returning({ userId: passwordResets.userId });
    if (!claimed) throw unauthorized("That reset link is expired or already used. Request a new one.");
    await tx.update(users).set({ passwordHash, updatedAt: new Date() }).where(eq(users.id, claimed.userId));
    await tx.delete(sessions).where(eq(sessions.userId, claimed.userId));
    return { userId: claimed.userId };
  });
}

/** Whether a reset token is currently usable — for rendering the form or an error. */
export async function checkResetToken(token: string): Promise<boolean> {
  const [row] = await db()
    .select({ usedAt: passwordResets.usedAt, expiresAt: passwordResets.expiresAt })
    .from(passwordResets)
    .where(eq(passwordResets.tokenHash, hashToken(token)))
    .limit(1);

  return Boolean(row && !row.usedAt && row.expiresAt > new Date());
}

// ─── Session lifecycle ──────────────────────────────────────────────────────

export async function createSession(auth: AuthResult): Promise<void> {
  const token = newToken(32);
  const cfg = config();
  const hdrs = await headers();

  await db().insert(sessions).values({
    userId: auth.userId,
    tokenHash: hashToken(token),
    activeWorkspaceId: auth.workspaceId,
    userAgent: hdrs.get("user-agent")?.slice(0, 500) ?? null,
    ip: clientIp(hdrs),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });

  const store = await cookies();
  store.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: cfg.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  store.delete(COOKIE_NAME);
  if (token) {
    await Promise.race([
      db().delete(sessions).where(eq(sessions.tokenHash, hashToken(token))),
      new Promise<void>((resolve) => setTimeout(resolve, 1_500)),
    ]);
  }
}

// ─── Tenant resolution ──────────────────────────────────────────────────────

export interface Session {
  userId: string;
  workspaceId: string;
  role: Role;
  email: string;
  name: string | null;
}

/**
 * The current session, resolved once per request.
 *
 * Wrapped in React's `cache` because a single page render asks for it three
 * times over — the dashboard layout needs the name for the avatar, the page
 * calls `requireTenant`, and the page body asks again for the top bar. Those
 * are three separate call sites that cannot see each other, and each one was
 * its own round trip to a database in another region: ~350ms of the same query
 * before any page-specific work began.
 *
 * `cache` dedupes within one render pass and holds nothing between requests,
 * so a signed-out or role-changed session is still picked up on the next
 * navigation. This is request-scoped memoisation, not a session cache — the
 * security properties are unchanged.
 */
export const getSession = cache(async function getSession(): Promise<Session | null> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  if (!token) return null;

  /*
   * One round trip, not two.
   *
   * Every authenticated request runs this, and a polling screen runs it every
   * few seconds. Resolving the session and then the membership separately cost
   * two sequential trips to the database — trivial when it was a local process,
   * ~120ms each once it lives in another region.
   *
   * The membership join is an inner join, which also keeps the security
   * property intact: a session whose user is no longer a member of the active
   * workspace yields no row, exactly as the two-step version returned null.
   * The role still comes from the membership table and never from the cookie.
   */
  const [row] = await db()
    .select({
      userId: sessions.userId,
      workspaceId: sessions.activeWorkspaceId,
      email: users.email,
      name: users.name,
      status: users.status,
      role: workspaceMembers.role,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.userId, sessions.userId),
        eq(workspaceMembers.workspaceId, sessions.activeWorkspaceId),
      ),
    )
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);

  if (!row?.workspaceId || row.status !== "active") return null;

  return {
    userId: row.userId,
    workspaceId: row.workspaceId,
    role: row.role,
    email: row.email,
    name: row.name,
  };
});

/**
 * The single gate every API route passes through.
 *
 * Returns a `TenantContext`, which is the only accepted argument shape for the
 * repository layer — so an unauthenticated request cannot reach data even by
 * mistake.
 */
export async function requireTenant(): Promise<TenantContext> {
  const session = await getSession();
  if (!session) throw unauthorized();

  const hdrs = await headers();
  return {
    userId: session.userId,
    workspaceId: session.workspaceId,
    role: session.role,
    // Reuse an inbound correlation ID when a caller supplies one, so a request
    // can be traced across the dashboard, the queue and the AI gateway.
    correlationId: hdrs.get("x-correlation-id") ?? newCorrelationId(),
  };
}

function clientIp(hdrs: Headers): string | null {
  const forwarded = hdrs.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim().slice(0, 45);
  return hdrs.get("x-real-ip")?.slice(0, 45) ?? null;
}

/** Remove expired sessions. Called from the maintenance queue. */
export async function pruneExpiredSessions(): Promise<void> {
  const { lt } = await import("drizzle-orm");
  await db().delete(sessions).where(lt(sessions.expiresAt, new Date()));
}
