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
export async function GET(req: Request): Promise<NextResponse> {
  const checks: Record<string, "ok" | "down"> = {};

  async function check(name: string, run: () => Promise<unknown>) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.resolve().then(run), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Health check timeout")), 2500);
      })]);
      checks[name] = "ok";
    } catch { checks[name] = "down"; }
    finally { clearTimeout(timer); }
  }
  await Promise.all([
    check("database", () => db().execute(sql`select 1`)),
    check("redis", () => getRedis().ping()),
  ]);

  // Deep checks are for operational monitoring; basic readiness remains
  // independent of background services so the UI can still show recovery help.
  if (new URL(req.url).searchParams.get("deep") === "1") {
    await Promise.all([
      check("worker", async () => {
        if (!await getRedis().get("worker:heartbeat")) throw new Error("Worker unavailable");
      }),
      ...(process.env.CRAWLER_SERVICE_URL ? [check("crawler", async () => {
        const response = await fetch(`${process.env.CRAWLER_SERVICE_URL!.replace(/\/+$/, "")}/health`, {
          signal: AbortSignal.timeout(2000), cache: "no-store",
        });
        if (!response.ok) throw new Error("Crawler unavailable");
      })] : []),
    ]);
  }

  const healthy = Object.values(checks).every((v) => v === "ok");
  return NextResponse.json({ status: healthy ? "ok" : "degraded", checks }, {
    status: healthy ? 200 : 503,
  });
}
