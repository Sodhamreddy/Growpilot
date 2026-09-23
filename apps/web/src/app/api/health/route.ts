export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/services";
import { getRedis } from "@/lib/redis";

/**
 * GET /api/health — liveness and dependency readiness.
 *
 * Returns 503 when a dependency is down so a load balancer stops routing here.
 * Deliberately unauthenticated, and deliberately leaks no version or config.
 */
export async function GET(): Promise<NextResponse> {
  const checks: Record<string, "ok" | "down"> = {};

  try {
    await db().execute(sql`select 1`);
    checks["database"] = "ok";
  } catch {
    checks["database"] = "down";
  }

  try {
    await getRedis().ping();
    checks["redis"] = "ok";
  } catch {
    checks["redis"] = "down";
  }

  const healthy = Object.values(checks).every((v) => v === "ok");
  return NextResponse.json({ status: healthy ? "ok" : "degraded", checks }, {
    status: healthy ? 200 : 503,
  });
}
