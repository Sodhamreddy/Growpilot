export const dynamic = "force-dynamic";

import { z } from "zod";
import { unauthorized } from "@ob/core";
import { publicRoute, parseBody } from "@/lib/api";
import { db } from "@/lib/services";
import { getSession, setActiveWorkspace } from "@/lib/auth";
import { acceptInviteAsMember } from "@/lib/invites";

/**
 * POST /api/invites/accept — join a workspace with the account you are signed in as.
 *
 * Not a tenant route: the person is signed in to their own workspace and is
 * joining a different one. The session is then moved to the workspace joined.
 */

const schema = z.object({ token: z.string().min(20).max(100) });

export const POST = publicRoute(async (req) => {
  const session = await getSession();
  if (!session) throw unauthorized("Sign in first, then open the invite link again.");
  const body = await parseBody(req, schema);
  const { workspaceId } = await acceptInviteAsMember(db(), { token: body.token, userId: session.userId, email: session.email });
  await setActiveWorkspace(workspaceId);
  return { ok: true, workspaceId };
}, { rateLimit: { limit: 20, windowSeconds: 900 } });
