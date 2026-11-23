export const dynamic = "force-dynamic";

import { notFound, requireRole } from "@ob/core";
import { route } from "@/lib/api";
import { db } from "@/lib/services";
import { revokeInvite } from "@/lib/invites";

/** DELETE /api/team/invites/:inviteId — cancel an invite so its link stops working. */
export const DELETE = route(async (ctx, req) => {
  requireRole(ctx, "admin");
  const segments = new URL(req.url).pathname.split("/");
  const inviteId = segments[segments.indexOf("invites") + 1] ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(inviteId)) throw notFound("pending invite");
  await revokeInvite(db(), ctx, inviteId);
  return { ok: true };
});
