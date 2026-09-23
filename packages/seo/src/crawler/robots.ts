/**
 * robots.txt parsing and enforcement — spec §3.1 "Respect robots.txt, crawl
 * limits and public-page boundaries."
 *
 * Implements the subset of the REP that matters for a first-party site crawl:
 * user-agent group selection with longest-match specificity, Allow/Disallow
 * with longest-match-wins precedence, `*` and `$` wildcards, Crawl-delay, and
 * Sitemap discovery.
 */

export interface RobotsRule {
  type: "allow" | "disallow";
  pattern: string;
}

export interface RobotsGroup {
  userAgents: string[];
  rules: RobotsRule[];
  crawlDelaySeconds?: number;
}

export interface Robots {
  groups: RobotsGroup[];
  sitemaps: string[];
}

export function parseRobots(text: string): Robots {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | undefined;
  // Consecutive User-agent lines share one rule block.
  let lastLineWasUserAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;

    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    switch (field) {
      case "user-agent": {
        if (!current || !lastLineWasUserAgent) {
          current = { userAgents: [], rules: [] };
          groups.push(current);
        }
        current.userAgents.push(value.toLowerCase());
        lastLineWasUserAgent = true;
        continue;
      }
      case "allow":
      case "disallow": {
        if (!current) {
          current = { userAgents: ["*"], rules: [] };
          groups.push(current);
        }
        // An empty Disallow means "allow everything" — skip it rather than
        // recording a zero-length pattern that would match every path.
        if (value !== "") current.rules.push({ type: field, pattern: value });
        break;
      }
      case "crawl-delay": {
        if (current) {
          const n = Number(value);
          if (Number.isFinite(n) && n >= 0) current.crawlDelaySeconds = n;
        }
        break;
      }
      case "sitemap": {
        sitemaps.push(value);
        break;
      }
      default:
        break;
    }
    lastLineWasUserAgent = false;
  }

  return { groups, sitemaps };
}

/** Select the group for a user agent: most specific match, else `*`. */
export function groupFor(robots: Robots, userAgent: string): RobotsGroup | undefined {
  const ua = userAgent.toLowerCase();
  let best: { group: RobotsGroup; length: number } | undefined;

  for (const group of robots.groups) {
    for (const candidate of group.userAgents) {
      if (candidate === "*") {
        best ??= { group, length: 0 };
        continue;
      }
      if (ua.includes(candidate) && (!best || candidate.length > best.length)) {
        best = { group, length: candidate.length };
      }
    }
  }
  return best?.group;
}

/** Translate a robots pattern (`*`, `$`) into an anchored RegExp. */
function patternToRegExp(pattern: string): RegExp {
  let src = "";
  for (const ch of pattern) {
    if (ch === "*") src += ".*";
    else if (ch === "$") src += "$";
    else src += ch.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + src);
}

/**
 * REP precedence: the longest matching pattern wins; Allow beats Disallow on
 * an exact-length tie.
 */
export function isAllowed(robots: Robots, userAgent: string, path: string): boolean {
  const group = groupFor(robots, userAgent);
  if (!group || group.rules.length === 0) return true;

  let winner: { rule: RobotsRule; length: number } | undefined;
  for (const rule of group.rules) {
    if (!patternToRegExp(rule.pattern).test(path)) continue;
    const length = rule.pattern.replace(/\$$/, "").length;
    if (
      !winner ||
      length > winner.length ||
      (length === winner.length && rule.type === "allow")
    ) {
      winner = { rule, length };
    }
  }
  return winner ? winner.rule.type === "allow" : true;
}

export function crawlDelayFor(robots: Robots, userAgent: string): number {
  return groupFor(robots, userAgent)?.crawlDelaySeconds ?? 0;
}
