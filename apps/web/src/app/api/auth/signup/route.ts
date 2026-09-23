export const dynamic = "force-dynamic";

import { z } from "zod";
import { publicRoute, parseBody } from "@/lib/api";
import { signUpWithEmail, createSession } from "@/lib/auth";

/** POST /api/auth/signup — spec §14. */

const schema = z.object({
  email: z.string().email("Enter a valid email address."),
  password: z.string()
    .min(8, "Use at least 8 characters.")
    .max(200)
    .regex(/[A-Z]/, "Add one uppercase letter.")
    .regex(/[a-z]/, "Add one lowercase letter.")
    .regex(/[0-9]/, "Add one number.")
    .regex(/[^A-Za-z0-9]/, "Add one special character."),
  name: z.string().min(1).max(120).optional(),
  workspaceName: z.string().min(1).max(120).optional(),
});

export const POST = publicRoute(
  async (req) => {
    const body = await parseBody(req, schema);
    const auth = await signUpWithEmail(body);
    await createSession(auth);
    return { ok: true, workspaceId: auth.workspaceId, nextStep: "goals" };
  },
  // Sign-up is expensive (scrypt + two inserts) and a spam target, but the
  // limit is per-IP: too low locks out everyone behind one office NAT.
  { rateLimit: { limit: 20, windowSeconds: 3600 } },
);
