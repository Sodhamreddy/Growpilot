import { getClient } from "@/lib/tenant";
import { requireTenant } from "@/lib/auth";
import { db } from "@/lib/services";
import { repo } from "@ob/db";
import { ResearchButton } from "@/components/ResearchButton";
import { IconKeywords, IconAlert } from "@/components/Icons";
import { TopBar } from "@/components/TopBar";
import { getSession } from "@/lib/auth";

/**
 * Keywords — spec §6.1.
 *
 * Seeds, intent classification, clustering and relevance ranking are real.
 * Volume and difficulty need a third-party provider that is not configured, so
 * those columns say "no data" rather than showing an invented number — a fake
 * volume would flow into the opportunity score and into a content plan.
 */

export const dynamic = "force-dynamic";

const INTENT_TONE: Record<string, string> = {
  transactional: "ok", commercial: "ok", local: "warn",
  informational: "neutral", navigational: "neutral",
};

export default async function KeywordsPage() {
  const ctx = await requireTenant();
  const initials = await avatarInitials();
  const database = db();
  const business = await getClient();

  if (!business) {
    return (
      <>
        <div className="pagehead"><h1>Keywords</h1></div>
        <div className="empty">
          <span className="empty-ico"><IconKeywords size={22} /></span>
          <strong>No business yet</strong>
          <span>Keywords are generated from a business&rsquo;s verified services. Add one first.</span>
        </div>
      </>
    );
  }

  const keywords = await repo.listKeywords(database, ctx, business.id);
  const noProviderData = keywords.length > 0 && keywords.every((k) => k.volume === null);
  const byIntent = keywords.reduce<Record<string, number>>((acc, k) => {
    const key = k.intent ?? "unclassified";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <>
      <TopBar section="Create" page="Keywords" initials={initials} />
      <div className="content">
      <div className="pagehead">
        <div className="titlerow">
          <h1>Keywords</h1>
          <span className="actions"><ResearchButton businessId={business.id} /></span>
        </div>
        <p>Search opportunities derived from {business.name}&rsquo;s verified services.</p>
      </div>

      {!business.confirmedAt ? (
        <div className="finding warn" style={{ marginBottom: 18 }}>
          <div>The business profile is not confirmed yet.</div>
          <div className="suggestion">→ Confirm it in Business Intelligence for better seed quality.</div>
        </div>
      ) : null}

      {keywords.length > 0 ? (
        <div className="specs" style={{ marginBottom: 20 }}>
          <div className="spec"><span className="k">Total terms</span><span className="v">{keywords.length}</span></div>
          {Object.entries(byIntent).slice(0, 3).map(([intent, n]) => (
            <div className="spec" key={intent}>
              <span className="k">{intent}</span><span className="v">{n}</span>
            </div>
          ))}
        </div>
      ) : null}

      {noProviderData ? (
        <div className="card" style={{ marginBottom: 18, borderColor: "var(--warn)" }}>
          <div className="row" style={{ alignItems: "flex-start" }}>
            <span className="tile-ico warn"><IconAlert /></span>
            <div>
              <strong style={{ fontSize: 13.5 }}>No search-volume provider connected</strong>
              <p className="muted small" style={{ margin: "3px 0 0", maxWidth: "62ch" }}>
                Terms, intent and clustering below are real. Volume, difficulty and opportunity score
                need a keyword data provider (SE Ranking, DataForSEO, Ahrefs). Until one is
                configured these show no data rather than an estimate.
              </p>
            </div>
          </div>
        </div>
      ) : null}

      <div className="card">
        {keywords.length === 0 ? (
          <div className="empty">
            <span className="empty-ico"><IconKeywords size={22} /></span>
            <strong>No keywords yet</strong>
            <span>Run research to generate them from the confirmed business profile.</span>
          </div>
        ) : (
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Term</th>
                  <th style={{ width: 130 }}>Intent</th>
                  <th style={{ width: 100 }} className="num">Volume</th>
                  <th style={{ width: 100 }} className="num">Difficulty</th>
                  <th style={{ width: 110 }} className="num">Opportunity</th>
                </tr>
              </thead>
              <tbody>
                {keywords.map((k) => (
                  <tr key={k.id}>
                    <td><strong>{k.term}</strong></td>
                    <td>
                      <span className={`badge ${INTENT_TONE[k.intent ?? ""] ?? "neutral"}`}>
                        {k.intent ?? "—"}
                      </span>
                    </td>
                    <td className="num">
                      {k.volume === null ? <span className="muted small">no data</span> : k.volume.toLocaleString()}
                    </td>
                    <td className="num">
                      {k.difficulty === null ? <span className="muted small">no data</span> : k.difficulty.toFixed(0)}
                    </td>
                    <td className="num">
                      {k.opportunityScore === null
                        ? <span className="muted small">no data</span>
                        : <strong>{k.opportunityScore.toFixed(1)}</strong>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      </div>
    </>
  );
}

/** Initials for the top-bar avatar. */
async function avatarInitials(): Promise<string> {
  const session = await getSession();
  return (
    (session?.name ?? session?.email ?? "?")
      .split(/[\s@.]+/).filter(Boolean).slice(0, 2)
      .map((p) => p[0]!.toUpperCase()).join("") || "?"
  );
}
