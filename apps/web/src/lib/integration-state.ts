import { newToken, type TenantContext } from "@ob/core";

/** Bind consent to its initiating user, workspace and client, not the current selection. */
export function integrationState(ctx: TenantContext, businessId: string | null): string {
  return [newToken(24), ctx.workspaceId, ctx.userId, businessId ?? "none"].join(".");
}

export function readIntegrationState(expected: string | undefined, received: string | null, ctx: TenantContext): { businessId: string | null } | null {
  if (!expected || !received || expected !== received) return null;
  const parts = expected.split(".");
  if (parts.length !== 4 || parts[1] !== ctx.workspaceId || parts[2] !== ctx.userId) return null;
  const businessId = parts[3]!;
  if (businessId !== "none" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(businessId)) return null;
  return { businessId: businessId === "none" ? null : businessId };
}
