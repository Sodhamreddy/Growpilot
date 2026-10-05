import { describe, it, expect } from "vitest";
import {
  isMonthKey, shiftMonth, monthGrid, mergeOccasions, audienceTones,
  monthName, dragBlocker, dropBlocker, isMonthLong, offObservance,
} from "./social-calendar";

describe("moving posts", () => {
  const opts = { monthKey: "2026-10", todayIso: "2026-09-28" };

  it("lets scheduled and written posts be picked up, observance posts included", () => {
    expect(dragBlocker({ status: "scheduled" })).toBeNull();
    expect(dragBlocker({ status: "written" })).toBeNull();
  });

  it("keeps approved and published posts in place", () => {
    expect(dragBlocker({ status: "approved" })).toMatch(/Take the approval back/);
    expect(dragBlocker({ status: "published" })).toMatch(/cannot move/);
  });

  it("tells a month-long observance from a one-day one", () => {
    expect(isMonthLong("National Physical Therapy Month", "entire month of October")).toBe(true);
    expect(isMonthLong("Awareness drive", "throughout the month")).toBe(true);
    expect(isMonthLong("World Stroke Day", "always the 29th of October")).toBe(false);
    expect(isMonthLong(null, null)).toBe(false);
  });

  it("names the observance day a post has been moved off", () => {
    const occasions = { 29: ["World Stroke Day"], 1: ["National Physical Therapy Month"] };
    const stroke = { occasion: "World Stroke Day", dateRule: "always the 29th of October" };
    expect(offObservance({ ...stroke, day: 30 }, occasions)).toBe(29);
    expect(offObservance({ ...stroke, day: 29 }, occasions)).toBeNull();
    // A month-long observance is never "off" its day.
    expect(offObservance({ occasion: "National Physical Therapy Month", dateRule: "entire month of October", day: 12 }, occasions))
      .toBeNull();
  });

  it("accepts a future day in the same month", () => {
    expect(dropBlocker("2026-10-14", opts)).toBeNull();
  });

  it("refuses another month, a past day and a non-date", () => {
    expect(dropBlocker("2026-11-02", opts)).toBe("Posts move within their month.");
    expect(dropBlocker("2026-10-03", { ...opts, todayIso: "2026-10-05" })).toBe("That day has already passed.");
    expect(dropBlocker("2026-10-5", opts)).toBe("That is not a date.");
  });

  it("allows today itself", () => {
    expect(dropBlocker("2026-10-05", { ...opts, todayIso: "2026-10-05" })).toBeNull();
  });

  it("labels a month for a heading", () => {
    expect(monthName("2026-10")).toBe("October 2026");
  });
});

describe("social calendar grid", () => {
  it("starts October 2026 on a Thursday and ends on a full week", () => {
    const weeks = monthGrid("2026-10");
    expect(weeks).toHaveLength(5);
    expect(weeks[0]!.slice(0, 4)).toEqual([null, null, null, null]);
    expect(weeks[0]![4]).toEqual({ day: 1, iso: "2026-10-01", weekday: 4 });
    expect(weeks[4]![6]).toEqual({ day: 31, iso: "2026-10-31", weekday: 6 });
  });

  it("pads the last week when the month ends mid-week", () => {
    const weeks = monthGrid("2026-09");
    const last = weeks[weeks.length - 1]!;
    expect(last).toHaveLength(7);
    expect(last.filter(Boolean).at(-1)?.day).toBe(30);
    expect(last.at(-1)).toBeNull();
  });

  it("fits a February that starts on Sunday into four rows", () => {
    const weeks = monthGrid("2026-02");
    expect(weeks).toHaveLength(4);
    expect(weeks.flat().every(Boolean)).toBe(true);
  });

  it("steps across year boundaries", () => {
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-10", 0)).toBe("2026-10");
  });

  it("accepts only real month keys", () => {
    expect(isMonthKey("2026-10")).toBe(true);
    expect(isMonthKey("2026-13")).toBe(false);
    expect(isMonthKey("2026-1")).toBe(false);
    expect(isMonthKey(undefined)).toBe(false);
  });
});

describe("mergeOccasions", () => {
  it("dedupes names repeated across the month row and its topics", () => {
    expect(mergeOccasions("Dussehra · World Osteoporosis Day", "dussehra", null, "World Food Day"))
      .toEqual(["Dussehra", "World Osteoporosis Day", "World Food Day"]);
  });

  it("returns nothing for a day with no observances", () => {
    expect(mergeOccasions(undefined, "", null)).toEqual([]);
  });
});

describe("audienceTones", () => {
  it("gives General the first slot and orders the rest by name", () => {
    const tones = audienceTones(["Owner", "General", "Marketer", "Owner"]);
    expect([...tones]).toEqual([["General", 0], ["Marketer", 1], ["Owner", 2]]);
  });

  it("wraps when there are more audiences than colours", () => {
    const tones = audienceTones(["a", "b", "c"], 2);
    expect(tones.get("c")).toBe(0);
  });
});
