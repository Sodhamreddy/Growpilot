/**
 * The month grid behind the social calendar view.
 *
 * Everything here works on "YYYY-MM" keys and UTC dates, the same as the
 * planner in @ob/social. A post's date is a calendar day the planner chose,
 * not an instant, so reading it in the server's local zone would move posts
 * onto the wrong square for anyone west of UTC.
 */

export interface GridDay {
  /** Day of the month, 1-31. */
  day: number;
  /** "YYYY-MM-DD". */
  iso: string;
  /** 0 is Sunday, matching the grid's first column. */
  weekday: number;
}

/** A "YYYY-MM" key with a real month in it. */
export function isMonthKey(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

/**
 * "October 2026".
 *
 * Kept here as well as in @ob/social because this file is safe to import from
 * the browser, and @ob/social is not: its index pulls in the AI gateway.
 */
export function monthName(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, 1)).toLocaleDateString("en-US", {
    month: "long", year: "numeric", timeZone: "UTC",
  });
}

/**
 * Why a post cannot be picked up and moved, or null when it can.
 *
 * Shared by the calendar (to decide what is draggable) and the API (which
 * enforces it), so the two cannot disagree about which posts move.
 */
export function dragBlocker(post: { status: string }): string | null {
  if (post.status === "published") return "Published posts cannot move.";
  if (post.status === "approved") return "Approved posts keep their date. Take the approval back to move it.";
  /*
   * Observance posts move too, when a person decides to.
   *
   * Pinning them was the first version, and a month made mostly of
   * observances could not be rearranged at all. Moving one off its day is a
   * real editorial choice (the day before World Stroke Day is a fine day to
   * post about it), so it is allowed and named rather than refused: see
   * `offObservance`.
   */
  return null;
}

/**
 * Whether an observance runs all month rather than on one day.
 *
 * "National Physical Therapy Month" can sit on any day of October; "World
 * Stroke Day" cannot. The planner's date rule says which, in words, and the
 * name usually does too.
 */
export function isMonthLong(occasion: string | null, dateRule: string | null): boolean {
  if (!occasion) return false;
  return /\bmonth\b/i.test(occasion) || /\b(entire|whole|all|throughout the)\s+month\b/i.test(dateRule ?? "");
}

/**
 * The day a one-day observance falls on, when a post has been moved off it.
 *
 * Read from the calendar's own observance labels, which stay on the
 * observance's day while the post moves. Null when the post is not tied to a
 * one-day observance, or is still on its day.
 */
export function offObservance(
  post: { day: number; occasion: string | null; dateRule: string | null },
  occasions: Record<number, string[]>,
): number | null {
  if (!post.occasion || isMonthLong(post.occasion, post.dateRule)) return null;
  const key = post.occasion.toLowerCase();
  const entry = Object.entries(occasions).find(([, names]) => names.some((n) => n.toLowerCase() === key));
  const day = entry ? Number(entry[0]) : null;
  return day !== null && day !== post.day ? day : null;
}

/** Why a post cannot land on `toIso`, or null when it can. */
export function dropBlocker(toIso: string, opts: { monthKey: string; todayIso: string }): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(toIso) || Number.isNaN(Date.parse(toIso))) return "That is not a date.";
  if (!toIso.startsWith(`${opts.monthKey}-`)) return "Posts move within their month.";
  if (toIso < opts.todayIso) return "That day has already passed.";
  return null;
}

/** The month `delta` months from `monthKey`, as a key. */
export function shiftMonth(monthKey: string, delta: number): string {
  const [y, m] = monthKey.split("-").map(Number);
  const d = new Date(Date.UTC(y!, m! - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * The month as Sunday-first weeks.
 *
 * Days outside the month are null rather than borrowed from the neighbours.
 * A square showing September 30 inside October's grid invites someone to look
 * for September's posts there, and they are not loaded.
 */
export function monthGrid(monthKey: string): (GridDay | null)[][] {
  const [y, m] = monthKey.split("-").map(Number);
  const first = new Date(Date.UTC(y!, m! - 1, 1)).getUTCDay();
  const total = new Date(Date.UTC(y!, m!, 0)).getUTCDate();

  const cells: (GridDay | null)[] = Array.from({ length: first }, () => null);
  for (let day = 1; day <= total; day++) {
    cells.push({
      day,
      iso: `${monthKey}-${String(day).padStart(2, "0")}`,
      weekday: (first + day - 1) % 7,
    });
  }
  while (cells.length % 7) cells.push(null);

  const weeks: (GridDay | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/**
 * One list of observance names for a day, from several sources.
 *
 * The month row stores its events already joined with " · ", and the topics
 * scheduled that day carry the same names again, so the same observance
 * arrives two or three times. Deduplicated ignoring case, first spelling wins.
 */
export function mergeOccasions(...sources: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const source of sources) {
    for (const raw of (source ?? "").split(" · ")) {
      const name = raw.trim();
      const key = name.toLowerCase();
      if (!name || seen.has(key)) continue;
      seen.add(key);
      out.push(name);
    }
  }
  return out;
}

/**
 * A colour slot per audience, stable across months.
 *
 * Assigned from the business's whole pool rather than from whichever posts
 * this month happens to hold. Otherwise an audience that sits out one month
 * shifts everyone else's colour, and the legend a person learned last month
 * stops being true. "General" always takes the first slot.
 */
export function audienceTones(audiences: string[], slots = 6): Map<string, number> {
  const ordered = [...new Set(audiences.filter(Boolean))].sort((a, b) =>
    a === "General" ? -1 : b === "General" ? 1 : a.localeCompare(b));
  return new Map(ordered.map((a, i) => [a, i % slots]));
}
