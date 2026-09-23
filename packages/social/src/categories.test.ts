import { describe, it, expect } from "vitest";
import { categoriesFor } from "./categories.js";

/**
 * Which categories a business gets.
 *
 * The bug this replaces: categories were built one per service, so a pharmacy
 * with six services got six buckets called "Home Delivery", "Pill Packs" and
 * so on. Sixteen topics about home delivery repeat themselves by the fourth.
 * A content type stays broad enough to fill while the angle changes each time.
 *
 * The industry match is a keyword test rather than an exact value, because the
 * crawler writes whatever the site says. "Home Health Care", "Senior Home
 * Care" and "In-Home Nursing" are the same business to a reader and have to be
 * the same business here.
 */

describe("matching an industry", () => {
  it("recognises home care however the site words it", () => {
    for (const industry of [
      "Home Health Care", "Senior Home Care", "In-Home Nursing",
      "Elder Care Services", "Caregiving Agency",
    ]) {
      const names = categoriesFor(industry).map((c) => c.name);
      expect(names, industry).toContain("Family Caregiver Guidance");
    }
  });

  it("recognises a pharmacy", () => {
    const names = categoriesFor("Pharmacy").map((c) => c.name);
    expect(names).toContain("Managing Your Medication");
    expect(names).toContain("Ask Your Pharmacist");
  });

  it("recognises a dental practice", () => {
    const names = categoriesFor("Dental clinic").map((c) => c.name);
    expect(names).toContain("Treatments Explained");
  });

  it("recognises an agency", () => {
    const names = categoriesFor("Digital Marketing and Software Development").map((c) => c.name);
    expect(names).toContain("Buying Decisions");
  });

  it("falls back to a generic set for an unknown industry", () => {
    // A landscaping company should still get a usable pool rather than none.
    const names = categoriesFor("Landscaping").map((c) => c.name);
    expect(names).toContain("Choosing a Provider");
    expect(names.length).toBeGreaterThan(4);
  });

  it("falls back when the industry is unknown entirely", () => {
    expect(categoriesFor(null).length).toBeGreaterThan(4);
  });
});

describe("what every business gets", () => {
  const industries = [
    "Home Health Care", "Pharmacy", "Dental clinic",
    "Digital Marketing", "Landscaping", null,
  ];

  it("always includes the calendar and seasonal categories", () => {
    for (const industry of industries) {
      const names = categoriesFor(industry).map((c) => c.name);
      expect(names, String(industry)).toContain("Holidays & Special Days");
      expect(names, String(industry)).toContain("Seasonal Safety");
    }
  });

  it("never returns a duplicate name", () => {
    // Two categories with one name collide on the unique index and the second
    // is silently dropped, leaving a pool smaller than the UI promises.
    for (const industry of industries) {
      const names = categoriesFor(industry).map((c) => c.name);
      expect(new Set(names).size, String(industry)).toBe(names.length);
    }
  });

  it("gives every category a real target and a description", () => {
    for (const industry of industries) {
      for (const c of categoriesFor(industry)) {
        expect(c.targetCount, c.name).toBeGreaterThan(0);
        expect(c.description.length, c.name).toBeGreaterThan(20);
      }
    }
  });

  it("puts the industry-specific categories first", () => {
    // They are what a person came for; the universal ones are the long tail.
    const cats = categoriesFor("Pharmacy");
    expect(cats[0]!.name).toBe("Health Awareness Observances");
    expect(cats.at(-1)!.name).toBe("Emotional & Engagement Content");
  });

  it("produces a pool worth planning a month from", () => {
    // Twelve to fourteen posts a month means a year needs well over a hundred.
    for (const industry of industries) {
      const total = categoriesFor(industry).reduce((n, c) => n + c.targetCount, 0);
      expect(total, String(industry)).toBeGreaterThan(100);
    }
  });
});

describe("what the networks add", () => {
  const ig = [{ network: "instagram", handle: "x", url: "https://instagram.com/x" }];

  it("adds nothing when no accounts are on record", () => {
    // The default for every client until the crawler finds a footer link.
    // Inventing an Instagram strategy for a business with no Instagram
    // spends a category slot on posts nobody will publish.
    expect(categoriesFor("Pharmacy", []).map((c) => c.name))
      .toEqual(categoriesFor("Pharmacy").map((c) => c.name));
  });

  it("adds visual categories for Instagram", () => {
    const names = categoriesFor("Pharmacy", ig).map((c) => c.name);
    expect(names).toContain("Behind the Scenes");
    expect(names).toContain("Faces & Stories");
  });

  it("adds a professional category for LinkedIn", () => {
    const names = categoriesFor("Digital Marketing", [{ network: "LinkedIn" }]).map((c) => c.name);
    expect(names).toContain("Point of View");
    expect(names).not.toContain("Behind the Scenes");
  });

  it("adds a local category for Facebook", () => {
    expect(categoriesFor("Home Health Care", [{ network: "facebook" }]).map((c) => c.name))
      .toContain("Community & Local");
  });

  it("matches however the handle was typed", () => {
    for (const network of ["Instagram", "instagram", "IG", "  TikTok  "]) {
      const names = categoriesFor("Pharmacy", [{ network: network.trim() }]).map((c) => c.name);
      expect(names, network).toContain("Behind the Scenes");
    }
  });

  it("combines several networks without repeating a category", () => {
    const names = categoriesFor("Dental clinic", [
      { network: "instagram" }, { network: "facebook" }, { network: "linkedin" },
    ]).map((c) => c.name);
    expect(names).toContain("Behind the Scenes");
    expect(names).toContain("Community & Local");
    expect(names).toContain("Point of View");
    expect(new Set(names).size).toBe(names.length);
  });

  it("keeps the industry categories at the top", () => {
    // They are what a person came for; the network ones are a supplement.
    const cats = categoriesFor("Pharmacy", ig);
    expect(cats[0]!.name).toBe("Health Awareness Observances");
    expect(cats.at(-1)!.name).toBe("Emotional & Engagement Content");
  });

  it("ignores a network nobody recognises", () => {
    const names = categoriesFor("Pharmacy", [{ network: "Bluesky" }]).map((c) => c.name);
    expect(names).toEqual(categoriesFor("Pharmacy").map((c) => c.name));
  });

  it("survives a malformed channel row", () => {
    // The field is hand-typed and the crawler writes into it too.
    expect(() => categoriesFor("Pharmacy", [{ network: "" }])).not.toThrow();
    expect(categoriesFor("Pharmacy", [{ network: "" }]).length).toBeGreaterThan(4);
  });
});

describe("categories are content types, not services", () => {
  it("does not name a pharmacy category after a single service", () => {
    /*
     * The specific failure: "Home Delivery" and "Pill Packs" as categories.
     * Both are services, both are too narrow to carry sixteen topics, and
     * both belong inside "Managing Your Medication" as angles.
     */
    const names = categoriesFor("Pharmacy").map((c) => c.name);
    for (const service of ["Home Delivery", "Pill Packs", "Medication Synchronization"]) {
      expect(names, service).not.toContain(service);
    }
  });

  it("does not name a home care category after a single service", () => {
    const names = categoriesFor("Home Health Care").map((c) => c.name);
    for (const service of ["24 Hour Home Care", "Companion Care", "Personal Care"]) {
      expect(names, service).not.toContain(service);
    }
  });
});
