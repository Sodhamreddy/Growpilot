"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Which Facebook Page this client's insights come from.
 *
 * A Meta login administers pages for every business it touches — fifteen, for
 * the account this was built against. Left unmapped, every page's numbers land
 * against whichever client was selected at connection time, and nothing
 * downstream can tell: the figures are real, they simply belong to somebody
 * else.
 *
 * So the choice is per client, made here, and the dashboard shows nothing for
 * a client with no page rather than guessing.
 */

interface PageRow {
  id: string;
  name: string;
  instagram: boolean;
  /** Another client already syncing this page, if any. */
  takenBy: string | null;
}

export function MetaPagePicker({ businessName }: { businessName: string | null }) {
  const router = useRouter();
  const [pages, setPages] = useState<PageRow[] | null>(null);
  const [selected, setSelected] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/integrations/meta/page");
        if (!res.ok || !alive) return;
        const body = (await res.json()) as { pages: PageRow[]; selectedPageId: string | null };
        setPages(body.pages);
        setSelected(body.selectedPageId ?? "");
      } catch {
        // The picker simply does not render; the page above already reports
        // whether the connection itself is healthy.
      }
    })();
    return () => { alive = false; };
  }, []);

  async function choose(pageId: string) {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const res = await fetch("/api/integrations/meta/page", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pageId: pageId || null }),
      });
      const body: unknown = await res.json();
      if (!res.ok) {
        setError((body as { error?: { message?: string } }).error?.message ?? "Could not save that.");
        return;
      }
      const result = body as { pageName: string | null; syncing?: boolean };
      setSelected(pageId);
      setSaved(result.pageName
        ? `${result.pageName} selected.${result.syncing ? " Pulling the last 30 days…" : ""}`
        : "Cleared. This client will not sync.");
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  if (!pages || pages.length === 0) return null;

  return (
    <div className="pagepicker">
      <label>
        <span>
          Facebook Page for {businessName ?? "this client"}
        </span>
        <select
          value={selected}
          disabled={busy}
          onChange={(e) => void choose(e.target.value)}
        >
          <option value="">Not selected — nothing syncs</option>
          {pages.map((page) => (
            <option key={page.id} value={page.id}>
              {page.name}
              {page.instagram ? " + Instagram" : ""}
              {/*
                * Naming the other client rather than disabling the option.
                * One page genuinely can serve two records, and a disabled
                * row with no explanation is the kind of dead end that sends
                * somebody hunting through settings.
                */}
              {page.takenBy ? ` — already used by ${page.takenBy}` : ""}
            </option>
          ))}
        </select>
      </label>

      {saved ? <p className="pagepicker-ok">{saved}</p> : null}
      {error ? <p className="error small" style={{ margin: "6px 0 0" }}>{error}</p> : null}
    </div>
  );
}
