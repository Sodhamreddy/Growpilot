import { forbidden } from "./errors.js";

/**
 * Tenant isolation (spec §15: "Tenant isolation on every query").
 *
 * Every data-access call takes a `TenantContext` as its first argument rather
 * than reading an ambient session. The repository layer derives its WHERE
 * clause from this object, so a query cannot be written that forgets the
 * workspace filter — the filter is the parameter.
 */

export type Role = "owner" | "admin" | "editor" | "viewer";

export interface TenantContext {
  readonly userId: string;
  readonly workspaceId: string;
  readonly role: Role;
  readonly correlationId: string;
}

const RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

export function hasRole(ctx: TenantContext, minimum: Role): boolean {
  return RANK[ctx.role] >= RANK[minimum];
}

export function requireRole(ctx: TenantContext, minimum: Role): void {
  if (!hasRole(ctx, minimum)) {
    throw forbidden(`This action requires the ${minimum} role or higher.`);
  }
}

/**
 * Assert a loaded row belongs to the caller's workspace.
 *
 * Defence in depth: repositories already scope by workspace, but anything
 * fetched by primary key (a job payload referencing an article ID, say) passes
 * through here before use.
 */
export function assertSameWorkspace(
  ctx: TenantContext,
  row: { workspaceId: string } | null | undefined,
  what = "resource",
): asserts row is { workspaceId: string } {
  if (!row || row.workspaceId !== ctx.workspaceId) {
    // Deliberately indistinguishable from "not found" — do not leak existence
    // of another tenant's rows.
    throw forbidden(`That ${what} could not be found in this workspace.`);
  }
}

/** Context for background jobs, which act on a workspace without a user session. */
export function systemContext(workspaceId: string, correlationId: string): TenantContext {
  return { userId: "system", workspaceId, role: "admin", correlationId };
}
