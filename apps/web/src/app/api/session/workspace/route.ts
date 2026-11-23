export const dynamic = "force-dynamic";

import { z } from "zod";
import { route, parseBody } from "@/lib/api";
import { setActiveWorkspace } from "@/lib/auth";

/** POST /api/session/workspace — switch to another workspace you belong to. Membership is checked again here. */

const schema = z.object({ workspaceId: z.string().uuid() });

export const POST = route(async (_ctx, req) => {
  const body = await parseBody(req, schema);
  await setActiveWorkspace(body.workspaceId);
  return { ok: true };
});
