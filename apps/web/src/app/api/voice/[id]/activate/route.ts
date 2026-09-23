export const dynamic = "force-dynamic";

import { requireRole } from "@ob/core";
import { repo } from "@ob/db";
import { route } from "@/lib/api";
import { db } from "@/lib/services";

/**
 * POST /api/voice/:id/activate — spec §18.2 final step.
 *
 * The active voice is what every generation job retrieves. Activating is a
 * deliberate customer act: extraction never activates its own output.
 */
export const POST = route(async (ctx, req) => {
  requireRole(ctx, "admin");
  const segments = new URL(req.url).pathname.split("/");
  const id = segments[segments.indexOf("voice") + 1] ?? "";
  const database = db();

  const activated = await repo.activateVoice(database, ctx, id);

  await repo.writeAudit(database, ctx, {
    action: "voice.activated",
    entityType: "brand_voice",
    entityId: id,
    after: { version: activated.version },
  });

  return { ok: true, voiceId: activated.id, version: activated.version };
});
