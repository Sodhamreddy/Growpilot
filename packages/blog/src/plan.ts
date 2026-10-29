import type { SearchIntent } from "./keywords.js";

/**
 * Content plan construction — spec §6.2.
 *
 * Turns clustered keywords into a publishable schedule. The decisions here are
 * the ones an SEO strategist makes by hand:
 *
 *  - One pillar per cluster, targeting the head term, plus supporting spokes.
 *    A cluster with no depth is not a cluster; it becomes a single article.
 *  - Commercial and transactional intent is scheduled first. Informational
 *    content compounds, but it does not pay for itself in month one.
 *  - Publishing is spread rather than dumped: a burst of posts on day one then
 *    silence reads as abandoned, both to readers and to crawlers.
 *  - Nothing is scheduled for a term with no opportunity score, because there
 *    is no evidence it is worth writing.
 */

export interface ClusterInput {
  id: string;
  label: string;
  intent: SearchIntent | null;
  terms: {
    id: string;
    term: string;
    opportunityScore: number | null;
    /** Bounded adjustment from this client's observed search performance. */
    performanceBoost?: number;
    volume: number | null;
    /** Business fit, 0–1. The ranking basis when there is no market data. */
    relevance?: number | null;
  }[];
}

export interface PlannedTopic {
  title: string;
  primaryKeywordId: string;
  secondaryTerms: string[];
  intent: SearchIntent;
  /** Higher runs sooner. */
  priority: number;
  publishDate: Date;
  role: "pillar" | "spoke";
  clusterId: string;
}

export interface PlanOptions {
  /** Keywords already covered by a topic; removed before ranking and limits. */
  excludedKeywordIds?: ReadonlySet<string>;
  /** How many topics to schedule. */
  limit?: number;
  /** Articles published per week. */
  cadencePerWeek?: number;
  /** First publish date; defaults to three days out. */
  startAt?: Date;
}

/** Intent ordering — what earns its keep soonest. */
const INTENT_WEIGHT: Record<SearchIntent, number> = {
  transactional: 1.0,
  commercial: 0.92,
  local: 0.85,
  informational: 0.62,
  navigational: 0.25,
};

export function buildContentPlan(clusters: ClusterInput[], opts: PlanOptions = {}): PlannedTopic[] {
  const limit = opts.limit ?? 12;
  const cadence = Math.max(1, opts.cadencePerWeek ?? 2);
  const start = opts.startAt ?? new Date(Date.now() + 3 * 24 * 3600 * 1000);

  const candidates: Omit<PlannedTopic, "publishDate">[] = [];

  for (const cluster of clusters) {
    const intent = cluster.intent ?? "informational";

    // Best term leads: opportunity where we have market data, then relevance,
    // then volume, then the longest phrase — longer terms are usually more
    // specific and easier to rank for.
    const ranked = cluster.terms.filter((term) => !opts.excludedKeywordIds?.has(term.id)).sort((a, b) => {
      const byScore = ((b.opportunityScore ?? (b.relevance ?? 0.5) * 100) + (b.performanceBoost ?? 0)) - ((a.opportunityScore ?? (a.relevance ?? 0.5) * 100) + (a.performanceBoost ?? 0));
      if (byScore !== 0) return byScore;
      const byRelevance = (b.relevance ?? -1) - (a.relevance ?? -1);
      if (byRelevance !== 0) return byRelevance;
      const byVolume = (b.volume ?? -1) - (a.volume ?? -1);
      if (byVolume !== 0) return byVolume;
      return b.term.length - a.term.length;
    });

    const head = ranked[0];
    if (!head) continue;

    /*
     * What to rank on when there is no keyword provider.
     *
     * `opportunityScore` is null for every term until a provider supplies
     * volume and difficulty. Substituting one constant for all of them made
     * every cluster score identical, so the intent weight below became the only
     * thing deciding what gets written — and a stray transactional long-tail
     * ("printer driver update") outranked the business's core commercial terms
     * purely because of its label.
     *
     * Relevance is judged from the business's own pages and is always present,
     * so it carries the ranking instead. Scaled to the same 0–100 range the
     * opportunity score uses, and centred at 50 when even that is missing so a
     * term with no signal at all sits mid-pack rather than winning.
     */
    const clusterScore = (head.opportunityScore ?? (head.relevance != null ? head.relevance * 100 : 50)) + (head.performanceBoost ?? 0);

    candidates.push({
      title: pillarTitle(head.term, intent),
      primaryKeywordId: head.id,
      secondaryTerms: ranked.slice(1, 6).map((t) => t.term),
      intent,
      priority: clusterScore * INTENT_WEIGHT[intent] + 10, // pillars lead
      role: "pillar",
      clusterId: cluster.id,
    });

    // Spokes only where the cluster has genuine depth. Two terms is a pair,
    // not a topic cluster.
    if (ranked.length >= 3) {
      for (const term of ranked.slice(1, 4)) {
        candidates.push({
          title: spokeTitle(term.term, intent),
          primaryKeywordId: term.id,
          secondaryTerms: [],
          intent,
          priority:
            ((term.opportunityScore ?? (term.relevance != null ? term.relevance * 90 : 40)) + (term.performanceBoost ?? 0)) *
            INTENT_WEIGHT[intent],
          role: "spoke",
          clusterId: cluster.id,
        });
      }
    }
  }

  const selected = candidates.sort((a, b) => b.priority - a.priority).slice(0, limit);

  // Spread across the calendar at the requested cadence.
  const msPerSlot = (7 / cadence) * 24 * 3600 * 1000;
  return selected.map((topic, i) => ({
    ...topic,
    publishDate: new Date(start.getTime() + i * msPerSlot),
  }));
}

/**
 * Titles are working headlines for the brief, not final copy — the article
 * generator rewrites them in the brand voice. They exist so the plan is
 * readable before anything is written.
 *
 * Two things make the difference between a plan that reads as considered and
 * one that reads as generated: the phrasing varies, and acronyms are spelled
 * the way the industry spells them. A calendar where eight of twelve rows end
 * in "a complete buyer's guide", captioned "Seo optimization" and "Voip
 * management", tells the customer no one is home.
 */

/**
 * Terms whose casing is not a capitalisation rule but a convention. Left to a
 * generic title-caser these come out as "Seo", "Voip", "Ios" — which is the
 * fastest way to look unserious to anyone in the industry.
 */
const ACRONYMS = new Map<string, string>([
  ["seo", "SEO"], ["sem", "SEM"], ["smo", "SMO"], ["smm", "SMM"], ["ppc", "PPC"],
  ["aeo", "AEO"], ["geo", "GEO"], ["cro", "CRO"], ["roi", "ROI"], ["kpi", "KPI"],
  ["it", "IT"], ["voip", "VoIP"], ["saas", "SaaS"], ["crm", "CRM"], ["erp", "ERP"],
  ["api", "API"], ["ui", "UI"], ["ux", "UX"], ["ai", "AI"], ["ml", "ML"],
  ["b2b", "B2B"], ["b2c", "B2C"], ["ios", "iOS"], ["seo/aeo", "SEO/AEO"],
  ["cms", "CMS"], ["sla", "SLA"], ["msp", "MSP"], ["vpn", "VPN"], ["dns", "DNS"],
  ["gmb", "GMB"], ["gbp", "GBP"], ["ga4", "GA4"], ["gsc", "GSC"],
  // Product and platform names. Same problem, same fix: keyword terms are
  // lower-cased when they are seeded, so nothing downstream can tell that
  // "microsoft 365" was ever a proper noun.
  ["microsoft", "Microsoft"], ["google", "Google"], ["azure", "Azure"],
  ["aws", "AWS"], ["wordpress", "WordPress"], ["shopify", "Shopify"],
  ["linkedin", "LinkedIn"], ["facebook", "Facebook"], ["instagram", "Instagram"],
  ["youtube", "YouTube"], ["android", "Android"], ["windows", "Windows"],
  ["salesforce", "Salesforce"], ["hubspot", "HubSpot"], ["magento", "Magento"],
  ["woocommerce", "WooCommerce"], ["webflow", "Webflow"],
]);

/** Sentence case, with industry acronyms preserved. */
function titleCase(s: string): string {
  const words = s.split(/\s+/).filter(Boolean).map((w) => {
    const bare = w.toLowerCase();
    const acronym = ACRONYMS.get(bare);
    if (acronym) return acronym;
    // "microsoft 365" and friends keep their digits attached.
    return w.charAt(0).toUpperCase() + w.slice(1);
  });

  const first = words[0];
  if (first === undefined) return s;

  // Sentence case: only the first word is capitalised, acronyms excepted.
  return [
    first,
    ...words.slice(1).map((w) => (ACRONYMS.has(w.toLowerCase()) ? w : w.toLowerCase())),
  ].join(" ");
}

/**
 * Pick a phrasing deterministically from the term itself.
 *
 * Deterministic so the same keyword always yields the same headline — a plan
 * that reshuffles its own titles on every rebuild is impossible to review — but
 * spread across the set so a twelve-row calendar does not repeat one formula.
 */
function variantFor(term: string, count: number): number {
  let hash = 0;
  for (let i = 0; i < term.length; i++) hash = (hash * 31 + term.charCodeAt(i)) >>> 0;
  return hash % count;
}

const PILLAR_PATTERNS: Record<SearchIntent, ((t: string) => string)[]> = {
  transactional: [
    (t) => `${t}: what it costs and how to choose`,
    (t) => `Choosing ${lower(t)}: a practical comparison`,
    (t) => `${t} — pricing, options and trade-offs`,
  ],
  commercial: [
    (t) => `${t}: a complete buyer's guide`,
    (t) => `How to evaluate ${lower(t)}`,
    (t) => `${t}: what to look for before you commit`,
    (t) => `The honest guide to ${lower(t)}`,
  ],
  local: [
    (t) => `${t}: what to expect locally`,
    (t) => `Finding ${lower(t)} near you`,
  ],
  informational: [
    (t) => `${t}: the complete guide`,
    (t) => `${t}, explained`,
    (t) => `Everything worth knowing about ${lower(t)}`,
  ],
  navigational: [(t) => t],
};

const SPOKE_PATTERNS: Record<SearchIntent, ((t: string, raw: string) => string)[]> = {
  transactional: [
    (_t, raw) => `How much does ${lower(raw)} cost?`,
    (t) => `${t}: is it worth the spend?`,
  ],
  commercial: [
    (_t, raw) => `Is ${lower(raw)} right for you?`,
    (t) => `${t}: the questions to ask first`,
  ],
  local: [(t) => `${t} near you: what to know`],
  informational: [
    (_t, raw) => `What you should know about ${lower(raw)}`,
    (t) => `${t}: a short primer`,
  ],
  navigational: [(t) => t],
};

function pillarTitle(term: string, intent: SearchIntent): string {
  const t = titleCase(term);
  const patterns = PILLAR_PATTERNS[intent];
  return patterns[variantFor(term, patterns.length)]!(t);
}

function spokeTitle(term: string, intent: SearchIntent): string {
  const t = titleCase(term);
  // A term that is already a question is already a headline.
  if (/^(how|what|why|when|where|can|do|does|is|are)\b/i.test(term)) {
    return /\?$/.test(t) ? t : `${t}?`;
  }
  const patterns = SPOKE_PATTERNS[intent];
  return patterns[variantFor(term, patterns.length)]!(t, term);
}

/** Lowercase a title-cased phrase for mid-sentence use, keeping acronyms. */
function lower(s: string): string {
  return s
    .split(/\s+/)
    .map((w) => (ACRONYMS.has(w.toLowerCase()) ? ACRONYMS.get(w.toLowerCase())! : w.toLowerCase()))
    .join(" ");
}

/** A modest priority boost for observed demand with room to earn more clicks. No signal means no change. */
export function searchPerformanceBoost(impressions: number, clicks: number): number {
  if (!Number.isFinite(impressions) || !Number.isFinite(clicks) || impressions < 100 || clicks < 0) return 0;
  const ctr = Math.min(1, clicks / impressions);
  return Math.min(10, Math.log10(impressions) * 2) * (1 - ctr);
}
