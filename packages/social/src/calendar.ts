/**
 * Building a month from the topic pool.
 *
 * Dated topics anchor their own day. Everything else is drawn from the
 * evergreen pool and spread across the remaining weeks, which is what the pool
 * exists for: a month rarely has twelve observances in it, and a calendar made
 * only of dated topics would be three posts long.
 *
 * Deliberately not a model call. Which topics land where is arithmetic over
 * data a person has already approved, and asking a model to do it would spend
 * money to reintroduce the risk of an invented date.
 */

export interface CalendarCandidate {
  id: string;
  title: string;
  categoryId: string;
  categoryName: string;
  audience: string;
  format: string;
  /** "YYYY-MM-DD" when the topic is tied to a day. */
  postDate: string | null;
  occasion: string | null;
  recommended: boolean;
}

export interface CalendarSlot {
  topicId: string;
  title: string;
  /** "YYYY-MM-DD". */
  date: string;
  occasion: string | null;
  audience: string;
  format: string;
  categoryName: string;
  /** True when the date came from the topic rather than from spreading. */
  anchored: boolean;
}

export interface MonthPlan {
  monthKey: string;
  slots: CalendarSlot[];
  /** Counts a reviewer checks before committing. */
  tally: {
    total: number;
    anchored: number;
    filled: number;
    byAudience: Record<string, number>;
    byFormat: Record<string, number>;
    byCategory: Record<string, number>;
  };
  /** Anything that stopped the month being what was asked for. */
  warnings: string[];
}

export interface PlanOptions {
  /** "2026-10". */
  monthKey: string;
  /** How many posts the month should hold. */
  target?: number;
  /**
   * Days to leave clear at the start, when planning a month already running.
   * Nothing is scheduled before this day of the month.
   */
  notBefore?: number;
}

const DEFAULT_TARGET = 13;

/**
 * Which month to plan next.
 *
 * Next month once there is not enough of this one left to be worth planning.
 * The first version switched on a fixed day of the month, which on the 18th
 * offered a September with twelve days in it: technically plannable, and not
 * what anyone means by planning a month. The test is how many days remain, so
 * a 28-day February and a 31-day March behave the same way.
 *
 * `minDaysLeft` is the shortest run worth calling a month. Below it the
 * current month is a write-off and the work is next month's.
 */
export function monthToPlan(today: Date, minDaysLeft = 14): string {
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const daysLeft = lastDay - today.getUTCDate() + 1;

  const d = new Date(Date.UTC(year, month, 1));
  if (daysLeft < minDaysLeft) d.setUTCMonth(d.getUTCMonth() + 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** How many days of a month remain, today included. Zero once it has passed. */
export function daysLeftInMonth(monthKey: string, today: Date): number {
  const thisMonth = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}`;
  if (monthKey > thisMonth) return daysInMonth(monthKey);
  if (monthKey < thisMonth) return 0;
  return daysInMonth(monthKey) - today.getUTCDate() + 1;
}

/** Days in a month, from a "YYYY-MM" key. */
export function daysInMonth(monthKey: string): number {
  const [y, m] = monthKey.split("-").map(Number);
  return new Date(Date.UTC(y!, m!, 0)).getUTCDate();
}

const iso = (monthKey: string, day: number): string =>
  `${monthKey}-${String(day).padStart(2, "0")}`;

/**
 * Lay a month out from the pool.
 *
 * The order matters. Anchored topics claim their days first, because an
 * observance cannot move; the rest are spread into the gaps that remain. Doing
 * it the other way round would let a filler post take the day an anchored one
 * needs.
 */
export function planMonth(
  candidates: CalendarCandidate[],
  options: PlanOptions,
): MonthPlan {
  const { monthKey } = options;
  const target = options.target ?? DEFAULT_TARGET;
  const notBefore = options.notBefore ?? 1;
  const total = daysInMonth(monthKey);
  const warnings: string[] = [];

  const taken = new Set<number>();
  const slots: CalendarSlot[] = [];

  // ── Anchored: topics whose date falls inside this month ──
  const anchored = candidates
    .filter((c) => c.postDate?.startsWith(`${monthKey}-`))
    .sort((a, b) => a.postDate!.localeCompare(b.postDate!));

  for (const c of anchored) {
    const day = Number(c.postDate!.slice(8, 10));
    if (day < notBefore) {
      warnings.push(`${c.occasion ?? c.title} falls on the ${day}, already past.`);
      continue;
    }
    if (taken.has(day)) {
      /*
       * Two observances on one day.
       *
       * Both are kept: a day carrying two posts is a real editorial choice,
       * and silently dropping one would lose an observance the planner found.
       * Flagged so a person decides rather than discovering it on the day.
       */
      warnings.push(`Two posts land on the ${day}: ${c.occasion ?? c.title}.`);
    }
    taken.add(day);
    slots.push({
      topicId: c.id,
      title: c.title,
      date: c.postDate!,
      occasion: c.occasion,
      audience: c.audience,
      format: c.format,
      categoryName: c.categoryName,
      anchored: true,
    });
  }

  // ── Filler: evergreen topics, recommended first ──
  const need = Math.max(0, target - slots.length);
  const evergreen = candidates
    .filter((c) => !c.postDate)
    .sort((a, b) => Number(b.recommended) - Number(a.recommended));

  if (evergreen.length < need) {
    warnings.push(
      `Only ${evergreen.length} undated topics are available and ${need} are needed. ` +
        `Generate more categories, or plan a shorter month.`,
    );
  }

  /*
   * Spread the fillers evenly rather than packing them.
   *
   * An even stride across the free days is what a posting schedule looks
   * like; taking the first N free days would put the whole month in its first
   * fortnight and leave the end empty.
   */
  const free: number[] = [];
  for (let d = notBefore; d <= total; d++) if (!taken.has(d)) free.push(d);

  const fillCount = Math.min(need, evergreen.length, free.length);
  const stride = fillCount > 0 ? free.length / fillCount : 0;

  for (let i = 0; i < fillCount; i++) {
    const day = free[Math.floor(i * stride)]!;
    const c = evergreen[i]!;
    slots.push({
      topicId: c.id,
      title: c.title,
      date: iso(monthKey, day),
      occasion: null,
      audience: c.audience,
      format: c.format,
      categoryName: c.categoryName,
      anchored: false,
    });
  }

  slots.sort((a, b) => a.date.localeCompare(b.date));

  const count = <T extends string>(key: (s: CalendarSlot) => T) =>
    slots.reduce<Record<string, number>>((acc, s) => {
      const k = key(s);
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {});

  const byAudience = count((s) => s.audience);
  const byFormat = count((s) => s.format);

  /*
   * The mix rules from the planner spec, checked rather than asserted.
   *
   * A model told to vary formats mostly does; "mostly" is not something to
   * find out after publishing, and these are cheap to verify here.
   */
  for (const [aud, n] of Object.entries(byAudience)) {
    if (slots.length >= 6 && n > slots.length / 2) {
      warnings.push(`${aud} is ${n} of ${slots.length} posts, more than half the month.`);
    }
  }
  const formats = Object.keys(byFormat);
  if (slots.length >= 6 && formats.length < 3) {
    warnings.push(`Only ${formats.length} format${formats.length === 1 ? "" : "s"} across the month.`);
  }
  if (slots.length < target) {
    warnings.push(`${slots.length} posts planned, ${target} wanted.`);
  }

  return {
    monthKey,
    slots,
    tally: {
      total: slots.length,
      anchored: slots.filter((s) => s.anchored).length,
      filled: slots.filter((s) => !s.anchored).length,
      byAudience,
      byFormat,
      byCategory: count((s) => s.categoryName),
    },
    warnings,
  };
}

/** "October 2026", for a heading. */
export function monthLabel(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, 1)).toLocaleDateString("en-US", {
    month: "long", year: "numeric", timeZone: "UTC",
  });
}
