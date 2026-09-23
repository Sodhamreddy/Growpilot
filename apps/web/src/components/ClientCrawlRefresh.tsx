"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";

/** Keep the selected client's sidebar status current while its website is read. */
export function ClientCrawlRefresh({
  businessId,
  status,
}: {
  businessId: string | null;
  status: string | null;
}) {
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (!businessId || !["pending", "running"].includes(status ?? "")) return;
    // Business Info already shows richer live progress and owns its polling.
    if (pathname === "/settings/business") return;

    let alive = true;
    let timer = 0;
    const check = async () => {
      try {
        const res = await fetch(`/api/clients/crawl?businessId=${encodeURIComponent(businessId)}`, {
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok || !alive) return;
        const body = (await res.json()) as { source: { status: string } | null };
        if (body.source && body.source.status !== status) {
          /*
           * Stop before refreshing.
           *
           * router.refresh() re-renders the whole shell, and every client
           * component in it keeps its own state across that render. One
           * refresh is what this is for; a repeating one turns any piece of
           * in-flight interaction into a race it can lose. The effect
           * re-subscribes with the new status anyway, so the interval is
           * rebuilt if the crawl is still going.
           */
          alive = false;
          window.clearInterval(timer);
          router.refresh();
        }
      } catch {
        // Transient; the next check retries.
      }
    };

    void check();
    timer = window.setInterval(() => void check(), 8000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [businessId, pathname, router, status]);

  return null;
}
