import { describe, it, expect } from "vitest";
import { profileUpdates, type ExtractedFact } from "./extract.js";

/**
 * What a crawl is allowed to change on a business row.
 *
 * The bug this covers: extraction overwrote industry, audience, description,
 * usp and primaryCta unconditionally. Somebody who typed their industry when
 * adding the client, or corrected a wrong one in Settings, watched the field
 * revert the next time the site was scanned — with no error and nothing in the
 * audit log to explain it, because from the database's point of view nothing
 * had gone wrong.
 *
 * The rule: extraction seeds an empty field and never touches a filled one.
 */

const fact = (value: string, confidence = 0.9): ExtractedFact => ({
  key: "", value, sourceUrl: "https://example.com", quote: value, confidence,
});

const extracted = {
  businessName: fact("Stadium Pharmacy Inc"),
  industry: fact("Retail Pharmacy"),
  audience: fact("Local residents filling prescriptions"),
  description: fact("A neighbourhood pharmacy in Kansas City."),
  facts: [
    { ...fact("Free same-day delivery"), key: "usp" },
    { ...fact("Call to transfer a prescription"), key: "cta" },
  ],
};

describe("seeding an empty profile", () => {
  it("fills every field a blank business is missing", () => {
    const updates = profileUpdates(extracted, {});
    expect(updates.industry).toBe("Retail Pharmacy");
    expect(updates.audience).toBe("Local residents filling prescriptions");
    expect(updates.description).toBe("A neighbourhood pharmacy in Kansas City.");
    expect(updates.usp).toBe("Free same-day delivery");
    expect(updates.primaryCta).toBe("Call to transfer a prescription");
  });

  it("treats null and whitespace as empty", () => {
    // A field cleared in the UI arrives as "" or "   ", not null.
    const updates = profileUpdates(extracted, {
      industry: null, audience: "", description: "   ", usp: "\n", primaryCta: undefined,
    });
    expect(Object.keys(updates).sort()).toEqual(
      ["audience", "description", "industry", "name", "primaryCta", "usp"],
    );
  });
});

describe("what the customer already said", () => {
  it("never overwrites a field that has a value", () => {
    const updates = profileUpdates(extracted, {
      industry: "Compounding Pharmacy",
      audience: "Long-term care facilities",
      description: "We serve care homes across the metro.",
      usp: "Pharmacist-led medication reviews",
      primaryCta: "Book a medication review",
    });
    expect(updates.industry).toBeUndefined();
    expect(updates.audience).toBeUndefined();
    expect(updates.description).toBeUndefined();
    expect(updates.usp).toBeUndefined();
    expect(updates.primaryCta).toBeUndefined();
  });

  it("fills the gaps around a field that was set", () => {
    // The common case: one field typed by hand, the rest left to the crawl.
    const updates = profileUpdates(extracted, { industry: "Compounding Pharmacy" });
    expect(updates.industry).toBeUndefined();
    expect(updates.audience).toBe("Local residents filling prescriptions");
    expect(updates.description).toBe("A neighbourhood pharmacy in Kansas City.");
  });

  it("is stable across repeated crawls", () => {
    /*
     * Running extraction twice must not produce a different row the second
     * time. Applying the first result and re-running should now change
     * nothing, which is what makes a re-crawl safe to trigger.
     */
    const first = profileUpdates(extracted, {});
    const second = profileUpdates(extracted, first);
    expect(second.industry).toBeUndefined();
    expect(second.audience).toBeUndefined();
    expect(second.description).toBeUndefined();
    expect(second.usp).toBeUndefined();
    expect(second.primaryCta).toBeUndefined();
  });
});

describe("the name", () => {
  it("overwrites, because the typed one is usually a shorthand", () => {
    const updates = profileUpdates(extracted, { name: "Stadium" });
    expect(updates.name).toBe("Stadium Pharmacy Inc");
  });

  it("is left alone when the extraction is not confident", () => {
    // Renaming a client on a guess is worse than leaving a shorthand.
    const unsure = { ...extracted, businessName: fact("Pharmacy", 0.3) };
    expect(profileUpdates(unsure, { name: "Stadium" }).name).toBeUndefined();
  });

  it("respects a caller-supplied threshold", () => {
    const middling = { ...extracted, businessName: fact("Stadium Pharmacy Inc", 0.6) };
    expect(profileUpdates(middling, {}, 0.5).name).toBe("Stadium Pharmacy Inc");
    expect(profileUpdates(middling, {}, 0.8).name).toBeUndefined();
  });
});

describe("what extraction did not find", () => {
  it("returns nothing when the site said nothing", () => {
    const nothing = {
      businessName: null, industry: null, audience: null, description: null, facts: [],
    };
    expect(profileUpdates(nothing, {})).toEqual({});
  });

  it("does not blank a filled field when extraction comes back empty", () => {
    /*
     * A thin or JS-heavy site yields no industry. That must leave the typed
     * one standing rather than clearing it — the failure mode where a bad
     * crawl silently empties a good profile.
     */
    const nothing = {
      businessName: null, industry: null, audience: null, description: null, facts: [],
    };
    const updates = profileUpdates(nothing, { industry: "Compounding Pharmacy" });
    expect("industry" in updates).toBe(false);
  });
});
