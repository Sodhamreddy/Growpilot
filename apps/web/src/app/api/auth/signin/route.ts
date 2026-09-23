export const dynamic = "force-dynamic";

import { z } from "zod";
import { publicRoute, parseBody } from "@/lib/api";
import { signInWithEmail, createSession } from "@/lib/auth";

/** POST /api/auth/signin */

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const POST = publicRoute(
  async (req) => {
    const body = await parseBody(req, schema);
    const auth = await signInWithEmail(body);
    await createSession(auth);
    return { ok: true, workspaceId: auth.workspaceId };
  },
  // Tight limit: this is the credential-stuffing surface.
  { rateLimit: { limit: 10, windowSeconds: 900 } },
);
