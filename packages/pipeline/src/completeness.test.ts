import { describe, it, expect } from "vitest";
import { assessCompleteness, type CompletenessInput } from "./completeness.js";

const fullBusiness = {
  name: "Kleza",
  industry: "Digital Marketing",
  audience: "Growing businesses",
  description: "We build things.",
  usp: "Senior engineers only",
  websiteUrl: "https://kleza.io",
  logoUrl: "https://kleza.io/logo.png",
  gmbName: "Kleza Solutions Pvt Ltd",
  socialProfiles: [{ network: "linkedin", handle: "kleza", url: "https://linkedin.com/company/kleza" }],
  confirmedAt: new Date(),
};

const completeLocation = {
  streetAddress: "7300 W 110th St",
  locality: "Overland Park",
  postalCode: "66210",
  phone: "+1 913 555 0134",
};

const base: CompletenessInput = {
  business: fullBusiness,
  serviceCount: 5,
  locations: [completeLocation],
  connectedProviders: ["wordpress", "google_business_profile", "linkedin"],
  goals: ["articles", "local", "social"],
};

const find = (input: CompletenessInput, id: string) =>
  assessCompleteness(input).items.find((i) => i.id === id)!;

describe("assessCompleteness — blocking items", () => {
  it("reports nothing outstanding for a fully filled profile", () => {
    const report = assessCompleteness(base);
    expect(report.blocking).toHaveLength(0);
    expect(report.recommended).toHaveLength(0);
    expect(report.readyToGenerate).toBe(true);
  });

  it("blocks when there is no business at all", () => {
    const report = assessCompleteness({ ...base, business: null });
    expect(report.readyToGenerate).toBe(false);
    expect(report.blocking.map((b) => b.id)).toContain("business");
  });

  it("blocks on an unconfirmed profile", () => {
    const report = assessCompleteness({
      ...base,
      business: { ...fullBusiness, confirmedAt: null },
    });
    expect(report.blocking.map((b) => b.id)).toContain("confirmed");
  });

  it("blocks when no services are listed, because research has nothing to use", () => {
    const report = assessCompleteness({ ...base, serviceCount: 0 });
    expect(report.blocking.map((b) => b.id)).toContain("services");
    expect(report.readyToGenerate).toBe(false);
  });
});

describe("assessCompleteness — severity depends on stated goals", () => {
  it("blocks on a missing address when local SEO was a goal", () => {
    const report = assessCompleteness({ ...base, locations: [], goals: ["articles", "local"] });
    expect(report.blocking.map((b) => b.id)).toContain("locations");
  });

  it("only recommends an address when local SEO was not a goal", () => {
    const report = assessCompleteness({ ...base, locations: [], goals: ["articles"] });
    expect(report.blocking.map((b) => b.id)).not.toContain("locations");
    expect(report.recommended.map((r) => r.id)).toContain("locations");
  });

  it("demotes social items to optional when social was not a goal", () => {
    const input = { ...base, business: { ...fullBusiness, socialProfiles: [] }, goals: ["articles"] };
    expect(find(input, "social_profiles").severity).toBe("optional");
  });

  it("raises social items to recommended when social was a goal", () => {
    const input = {
      ...base,
      business: { ...fullBusiness, socialProfiles: [] },
      goals: ["articles", "social"],
    };
    expect(find(input, "social_profiles").severity).toBe("recommended");
  });
});

describe("assessCompleteness — address quality", () => {
  it("flags an incomplete address even when a location exists", () => {
    const report = assessCompleteness({
      ...base,
      locations: [{ ...completeLocation, phone: null, postalCode: null }],
    });
    expect(report.blocking.map((b) => b.id)).toContain("nap");
  });

  it("passes when every location is complete", () => {
    const report = assessCompleteness({
      ...base,
      locations: [completeLocation, { ...completeLocation, locality: "Hyderabad" }],
    });
    expect(report.items.find((i) => i.id === "nap")!.done).toBe(true);
  });

  it("does not report a complete address when there are no locations at all", () => {
    expect(find({ ...base, locations: [] }, "nap").done).toBe(false);
  });
});

describe("assessCompleteness — connections", () => {
  it("notes when there is nowhere to publish", () => {
    const report = assessCompleteness({ ...base, connectedProviders: [] });
    expect(report.recommended.map((r) => r.id)).toContain("cms");
  });

  it("accepts any CMS, not only WordPress", () => {
    expect(find({ ...base, connectedProviders: ["ghost"] }, "cms").done).toBe(true);
  });

  it("accepts any social network as a connected channel", () => {
    expect(find({ ...base, connectedProviders: ["facebook"] }, "social_connected").done).toBe(true);
  });

  it("reports GMB as unconnected when only a CMS is connected", () => {
    expect(find({ ...base, connectedProviders: ["wordpress"] }, "gmb_connected").done).toBe(false);
  });
});

describe("assessCompleteness — reporting", () => {
  it("gives every item a consequence and an action, not just a name", () => {
    for (const item of assessCompleteness({ ...base, business: null }).items) {
      expect(item.consequence.length).toBeGreaterThan(10);
      expect(item.action.length).toBeGreaterThan(5);
    }
  });

  it("counts blocking and recommended together, excluding optional", () => {
    const report = assessCompleteness({
      ...base,
      serviceCount: 0,
      business: { ...fullBusiness, logoUrl: null },
      goals: ["articles"],
    });
    // Missing services blocks; the logo is optional and must not be counted.
    expect(report.outstanding).toBe(report.blocking.length + report.recommended.length);
    expect(report.optional.map((o) => o.id)).toContain("logo");
  });

  it("separates the GMB listing name from the business name", () => {
    // They differ in practice, so an empty gmbName is reported even when the
    // business is otherwise complete.
    const report = assessCompleteness({
      ...base,
      business: { ...fullBusiness, gmbName: null },
      goals: ["articles", "local"],
    });
    expect(report.recommended.map((r) => r.id)).toContain("gmb_name");
  });
});
