export const dynamic = "force-dynamic";

import { z } from "zod";
import { requireRole } from "@ob/core";
import { repo } from "@ob/db";
import { JOBS, payloadFrom } from "@ob/jobs";
import { route, parseBody } from "@/lib/api";
import { db, getQueues } from "@/lib/services";

/** POST /api/keywords/research · GET /api/keywords/research */

const schema = z.object({
  businessId: z.string().uuid(),
  location: z.string().max(120).optional(),
});

export const POST = route(
  async (ctx, req) => {
    requireRole(ctx, "editor");
    const body = await parseBody(req, schema);
    await repo.getBusiness(db(), ctx, body.businessId);

    const jobId = await getQueues().enqueue(
      "research",
      JOBS.researchKeywords,
      payloadFrom(ctx, { businessId: body.businessId, location: body.location }),
      /*
       * Keyed to this request, not to the calendar day.
       *
       * A day-stamped key made "Start research" a once-per-day button: the
       * second press that day matched an existing job id, BullMQ returned it
       * without queueing anything, and the UI reported success for work that
       * never ran. Idempotency belongs to a single request's retries, which is
       * what the correlation id identifies.
       */
      { idempotencyKey: `research:${body.businessId}:${body.location ?? "global"}:${ctx.correlationId}` },
    );

    return { ok: true, jobId };
  },
  { rateLimit: { limit: 30, windowSeconds: 3600 } },
);

export const GET = route(async (ctx, req) => {
  const businessId = new URL(req.url).searchParams.get("businessId");
  if (!businessId) return { keywords: [] };

  const rows = await repo.listKeywords(db(), ctx, businessId);
  return {
    keywords: rows.map((k) => ({
      id: k.id,
      term: k.term,
      intent: k.intent,
      // Null means "no provider data", not "zero searches" — the UI must
      // render these differently.
      volume: k.volume,
      difficulty: k.difficulty,
      opportunityScore: k.opportunityScore,
      clusterId: k.clusterId,
      provider: k.provider,
    })),
  };
});
