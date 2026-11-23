export const dynamic = "force-dynamic";

import { z } from "zod";
import { AppError, config, requireRole } from "@ob/core";
import { route, parseBody } from "@/lib/api";
import { db } from "@/lib/services";
import { createInvite } from "@/lib/invites";
import { TEAM_REVIEW_NEEDS_UPDATE, isMissingTable } from "@/lib/team-review-server";

/**
 * POST /api/team/invites — create a teammate invite.
 *
 * Returns the link once. Only its hash is stored, so it cannot be shown again:
 * a lost link is replaced by creating a new invite, which retires the old one.
 */

const schema = z.object({
  email: z.string().trim().email("Enter a valid email address.").max(320),
  role: z.enum(["admin", "editor", "viewer"]).default("editor"),
  teams: z.array(z.enum(["content", "manager"])).max(2).default([]),
});

export const POST = route(async (ctx, req) => {
  requireRole(ctx, "admin");
  const body = await parseBody(req, schema);
  try {
    const { token, invite } = await createInvite(db(), ctx, body);
    return {
      invite: { id: invite.id, email: invite.email, role: invite.role, teams: invite.teams, expiresAt: invite.expiresAt },
      link: `${config().APP_URL.replace(/\/+$/, "")}/join/${token}`,
    };
  } catch (error) {
    if (isMissingTable(error)) throw new AppError("dependency_unavailable", TEAM_REVIEW_NEEDS_UPDATE);
    throw error;
  }
}, { rateLimit: { limit: 40, windowSeconds: 3600 } });
