import { describe, it, expect } from "vitest";
import {
  planMonth, monthToPlan, daysInMonth, daysLeftInMonth, monthLabel,
  type CalendarCandidate,
} from "./calendar.js";

/**
 * Laying a month out from the pool.
 *
 * The arithmetic here decides what publishes on which day, and every failure
 * mode is silent: a post on the 31st of a 30-day month, two posts on one day,
 * a whole month packed into its first fortnight. None of them throws, and all
 * of them are only visible once the month is live.
 */

const topic = (over: Partial<CalendarCandidate> = {}): CalendarCandidate => ({
  id: over.id ?? Math.random().toString(36).slice(2),
  title: "A topic",
  categoryId: "c1",
  categoryName: "Recipes",
  audience: "General",
  format: "Static Image",
  postDate: null,
  occasion: null,
  recommended: false,
  ...over,
});

const evergreen = (n: number, over: Partial<CalendarCandidate> = {}) =>
  Array.from({ length: n }, (_, i) => topic({ id: `e${i}`, title: `Evergreen ${i}`, ...over }));

describe("which month to plan", () => {
  it("looks ahead once too little of this month is left", () => {
    /*
     * Measured in days remaining, not a day of the month. The first version
     * switched on the 24th, which on the 18th of a 30-day September offered a
     * month with twelve days in it: plannable in principle, and not what
     * anyone means by planning a month.
     */
    expect(monthToPlan(new Date("2026-09-18T00:00:00Z"))).toBe("2026-10"); // 13 left
    expect(monthToPlan(new Date("2026-09-24T00:00:00Z"))).toBe("2026-10");
    expect(monthToPlan(new Date("2026-09-30T00:00:00Z"))).toBe("2026-10");
  });

  it("stays on this month while there is still a month of it", () => {
    expect(monthToPlan(new Date("2026-09-01T00:00:00Z"))).toBe("2026-09");
    expect(monthToPlan(new Date("2026-09-17T00:00:00Z"))).toBe("2026-09"); // 14 left
  });

  it("uses days left, not a fixed date, so month length does not matter", () => {
    // The 16th of a 30-day month leaves 15 days; the 16th of a 31-day month
    // leaves 16. Both are still worth planning.
    expect(monthToPlan(new Date("2026-09-16T00:00:00Z"))).toBe("2026-09");
    expect(monthToPlan(new Date("2026-10-16T00:00:00Z"))).toBe("2026-10");
    // February is short, so it tips over earlier in the number line.
    expect(monthToPlan(new Date("2026-02-15T00:00:00Z"))).toBe("2026-02"); // 14 left
    expect(monthToPlan(new Date("2026-02-16T00:00:00Z"))).toBe("2026-03"); // 13 left
  });

  it("rolls the year over in December", () => {
    expect(monthToPlan(new Date("2026-12-28T00:00:00Z"))).toBe("2027-01");
  });
});

describe("days left in a month", () => {
  it("counts today as still available", () => {
    expect(daysLeftInMonth("2026-09", new Date("2026-09-30T00:00:00Z"))).toBe(1);
    expect(daysLeftInMonth("2026-09", new Date("2026-09-18T00:00:00Z"))).toBe(13);
  });

  it("returns the whole month for a future one", () => {
    expect(daysLeftInMonth("2026-10", new Date("2026-09-18T00:00:00Z"))).toBe(31);
  });

  it("returns zero for a month that has passed", () => {
    expect(daysLeftInMonth("2026-08", new Date("2026-09-18T00:00:00Z"))).toBe(0);
  });
});

describe("days in a month", () => {
  it("knows the short months", () => {
    expect(daysInMonth("2026-09")).toBe(30);
    expect(daysInMonth("2026-11")).toBe(30);
  });

  it("knows the long ones", () => {
    expect(daysInMonth("2026-10")).toBe(31);
    expect(daysInMonth("2026-12")).toBe(31);
  });

  it("handles February in a leap year and out of one", () => {
    expect(daysInMonth("2026-02")).toBe(28);
    expect(daysInMonth("2028-02")).toBe(29);
  });
});

describe("anchored topics keep their day", () => {
  it("places an observance on its own date", () => {
    const plan = planMonth(
      [topic({ id: "t1", postDate: "2026-10-29", occasion: "World Stroke Day" })],
      { monthKey: "2026-10", target: 1 },
    );
    expect(plan.slots[0]!.date).toBe("2026-10-29");
    expect(plan.slots[0]!.anchored).toBe(true);
  });

  it("ignores a topic dated in another month", () => {
    const plan = planMonth(
      [topic({ postDate: "2026-11-26" }), ...evergreen(2)],
      { monthKey: "2026-10", target: 2 },
    );
    expect(plan.slots.every((s) => s.date.startsWith("2026-10"))).toBe(true);
    expect(plan.tally.anchored).toBe(0);
  });

  it("drops an anchored day that has already passed", () => {
    // Planning a month mid-flight: nothing can be scheduled into the past.
    const plan = planMonth(
      [topic({ postDate: "2026-10-03", occasion: "Early Day" })],
      { monthKey: "2026-10", target: 1, notBefore: 18 },
    );
    expect(plan.slots).toHaveLength(0);
    expect(plan.warnings.join(" ")).toContain("already past");
  });

  it("keeps both when two observances share a day, and says so", () => {
    const plan = planMonth(
      [
        topic({ id: "a", postDate: "2026-10-10", occasion: "One" }),
        topic({ id: "b", postDate: "2026-10-10", occasion: "Two" }),
      ],
      { monthKey: "2026-10", target: 2 },
    );
    expect(plan.slots).toHaveLength(2);
    expect(plan.warnings.join(" ")).toContain("Two posts land on the 10");
  });
});

describe("evergreen topics fill the gaps", () => {
  it("brings a thin month up to target", () => {
    const plan = planMonth(
      [topic({ postDate: "2026-10-29" }), ...evergreen(20)],
      { monthKey: "2026-10", target: 13 },
    );
    expect(plan.tally.total).toBe(13);
    expect(plan.tally.anchored).toBe(1);
    expect(plan.tally.filled).toBe(12);
  });

  it("never schedules past the end of the month", () => {
    // The failure this catches: a 31st in a 30-day month, which reads as a
    // valid date everywhere until it is published.
    const plan = planMonth(evergreen(30), { monthKey: "2026-09", target: 25 });
    for (const s of plan.slots) {
      expect(Number(s.date.slice(8, 10)), s.date).toBeLessThanOrEqual(30);
    }
  });

  it("never reuses an anchored day", () => {
    const plan = planMonth(
      [topic({ postDate: "2026-10-15", occasion: "Fixed" }), ...evergreen(20)],
      { monthKey: "2026-10", target: 14 },
    );
    const fifteenth = plan.slots.filter((s) => s.date === "2026-10-15");
    expect(fifteenth).toHaveLength(1);
    expect(fifteenth[0]!.anchored).toBe(true);
  });

  it("spreads across the month rather than packing the start", () => {
    const plan = planMonth(evergreen(20), { monthKey: "2026-10", target: 10 });
    const days = plan.slots.map((s) => Number(s.date.slice(8, 10)));
    // A packed month would end around the 10th; a spread one reaches the end.
    expect(Math.max(...days)).toBeGreaterThan(20);
    expect(Math.min(...days)).toBeLessThan(6);
  });

  it("puts recommended topics in first", () => {
    const plan = planMonth(
      [
        ...evergreen(3, { recommended: false }),
        topic({ id: "star", title: "Recommended one", recommended: true }),
      ],
      { monthKey: "2026-10", target: 1 },
    );
    expect(plan.slots[0]!.topicId).toBe("star");
  });

  it("respects notBefore when filling", () => {
    const plan = planMonth(evergreen(10), { monthKey: "2026-10", target: 5, notBefore: 20 });
    for (const s of plan.slots) {
      expect(Number(s.date.slice(8, 10))).toBeGreaterThanOrEqual(20);
    }
  });

  it("warns when the pool cannot fill the month", () => {
    const plan = planMonth(evergreen(4), { monthKey: "2026-10", target: 13 });
    expect(plan.tally.total).toBe(4);
    expect(plan.warnings.join(" ")).toContain("Generate more categories");
  });

  it("copes with an empty pool rather than throwing", () => {
    const plan = planMonth([], { monthKey: "2026-10", target: 13 });
    expect(plan.slots).toEqual([]);
    expect(plan.warnings.length).toBeGreaterThan(0);
  });
});

describe("the tally a reviewer checks", () => {
  it("counts by audience, format and category", () => {
    const plan = planMonth(
      [
        topic({ id: "1", audience: "Senior specific", format: "Carousel", categoryName: "Recipes" }),
        topic({ id: "2", audience: "General", format: "Video", categoryName: "Seasonal Safety" }),
      ],
      { monthKey: "2026-10", target: 2 },
    );
    expect(plan.tally.byAudience).toEqual({ "Senior specific": 1, General: 1 });
    expect(plan.tally.byFormat).toEqual({ Carousel: 1, Video: 1 });
    expect(plan.tally.byCategory).toEqual({ Recipes: 1, "Seasonal Safety": 1 });
  });

  it("flags one audience taking over the month", () => {
    const plan = planMonth(
      evergreen(10, { audience: "Senior specific" }),
      { monthKey: "2026-10", target: 10 },
    );
    expect(plan.warnings.join(" ")).toContain("more than half the month");
  });

  it("flags a month of one or two formats", () => {
    const plan = planMonth(
      evergreen(10, { format: "Carousel" }),
      { monthKey: "2026-10", target: 10 },
    );
    expect(plan.warnings.join(" ")).toContain("format");
  });

  it("does not flag the mix on a very short month", () => {
    // Three posts of one format is not a pattern worth warning about.
    const plan = planMonth(evergreen(3, { format: "Quote" }), { monthKey: "2026-10", target: 3 });
    expect(plan.warnings.join(" ")).not.toContain("format");
  });

  it("returns slots in date order", () => {
    const plan = planMonth(
      [
        topic({ id: "late", postDate: "2026-10-29" }),
        topic({ id: "early", postDate: "2026-10-02" }),
        ...evergreen(5),
      ],
      { monthKey: "2026-10", target: 7 },
    );
    const dates = plan.slots.map((s) => s.date);
    expect([...dates].sort()).toEqual(dates);
  });
});

describe("replanning around posts that stay", () => {
  it("counts occupied days towards the target and never fills them again", () => {
    const plan = planMonth(evergreen(20), { monthKey: "2026-10", target: 10, occupied: [5, 12, 19] });
    expect(plan.slots).toHaveLength(7);
    const days = plan.slots.map((s) => Number(s.date.slice(8)));
    expect(days).not.toEqual(expect.arrayContaining([5]));
    expect(days.some((d) => [5, 12, 19].includes(d))).toBe(false);
    expect(plan.warnings.join(" ")).not.toContain("wanted");
  });

  it("warns when an observance lands on a day that already has a post", () => {
    const plan = planMonth([topic({ postDate: "2026-10-12", occasion: "Some Day" })], {
      monthKey: "2026-10", target: 2, occupied: [12],
    });
    expect(plan.warnings).toContain("Two posts land on the 12: Some Day.");
  });
});

describe("month label", () => {
  it("reads as a heading", () => {
    expect(monthLabel("2026-10")).toBe("October 2026");
    expect(monthLabel("2027-01")).toBe("January 2027");
  });
});
