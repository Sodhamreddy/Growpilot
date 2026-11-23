export const dynamic = "force-dynamic";

import { z } from "zod";
import { hashPasswordAsync } from "@ob/core";
import { publicRoute, parseBody } from "@/lib/api";
import { db } from "@/lib/services";
import { createSession } from "@/lib/auth";
import { acceptInviteAsNewUser } from "@/lib/invites";
import { newPasswordSchema } from "@/lib/password-rules";

/**
 * POST /api/auth/join — create an account from an invite link.
 *
 * Unlike sign-up, no workspace of their own is created: the person joins the
 * workspace that invited them, with the role and teams on the invite. The
 * email address comes from the invite, never from the request.
 */

const schema = z.object({
  token: z.string().min(20).max(100),
  name: z.string().trim().min(1, "Enter your name.").max(120),
  password: newPasswordSchema,
});

export const POST = publicRoute(async (req) => {
  const body = await parseBody(req, schema);
  const passwordHash = await hashPasswordAsync(body.password);
  const auth = await acceptInviteAsNewUser(db(), { token: body.token, name: body.name, passwordHash });
  await createSession(auth);
  return { ok: true, workspaceId: auth.workspaceId };
}, { rateLimit: { limit: 20, windowSeconds: 3600 } });
