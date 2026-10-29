import { describe, expect, it } from "vitest";
import { extractStructure } from "./structure.js";

describe("extractStructure", () => {
  it("uses the saved article title as the H1 when the body starts with sections", () => {
    const result = extractStructure("An introduction.\n\n## Choosing care\n\nA useful explanation.\n\n### Questions to ask\n\nMore detail.", "Home care guide");

    expect(result.headings).toEqual([
      { level: 1, text: "Home care guide" },
      { level: 2, text: "Choosing care" },
      { level: 3, text: "Questions to ask" },
    ]);
  });

  it("preserves a body H1 rather than injecting a second one from the saved title", () => {
    const result = extractStructure("# Existing heading\n\nIntroduction.\n\n## Details\n\nMore detail.", "Different saved title");

    expect(result.headings).toEqual([
      { level: 1, text: "Existing heading" },
      { level: 2, text: "Details" },
    ]);
    expect(extractStructure("Introduction.", " ").headings).toEqual([]);
  });

  it("distinguishes same-site and relative links from external citations", () => {
    const result = extractStructure([
      "[Care services](https://care.example/services)",
      "[Our team](https://www.care.example/team)",
      "[Consultations](/consultations)",
      "[Care options](options)",
      "[Research](https://research.example/study)",
      "[Other website](//other.example/guide)",
      "[Email us](mailto:hello@care.example)",
    ].join("\n"), "Care guide", "https://www.care.example/");

    expect(result.internalLinks).toEqual([
      { anchor: "Care services", url: "https://care.example/services" },
      { anchor: "Our team", url: "https://www.care.example/team" },
      { anchor: "Consultations", url: "/consultations" },
      { anchor: "Care options", url: "options" },
    ]);
    expect(result.externalLinks).toEqual([
      { anchor: "Research", url: "https://research.example/study" },
      { anchor: "Other website", url: "//other.example/guide" },
    ]);
  });

  it("does not claim absolute links are internal without a configured site", () => {
    const result = extractStructure("[Care](https://care.example/services) [Details](/details)");

    expect(result.internalLinks).toEqual([{ anchor: "Details", url: "/details" }]);
    expect(result.externalLinks).toEqual([{ anchor: "Care", url: "https://care.example/services" }]);
  });

  it("extracts image alt text without counting images as article links", () => {
    const result = extractStructure([
      "![A caregiver and family](https://care.example/team.jpg)",
      "![](/decorative.png)",
      "[Our services](/services)",
    ].join("\n"), "Home care", "https://care.example");

    expect(result.images).toEqual([
      { src: "https://care.example/team.jpg", alt: "A caregiver and family" },
      { src: "/decorative.png", alt: null },
    ]);
    expect(result.internalLinks).toEqual([{ anchor: "Our services", url: "/services" }]);
    expect(result.externalLinks).toEqual([]);
  });

  it("extracts a specific call to action for conversion scoring", () => {
    const result = extractStructure("## Next steps\n\nSchedule a consultation with our care team. We can discuss your needs.");

    expect(result).toMatchObject({ hasCta: true, ctaText: "Schedule a consultation with our care team" });
  });

  it("leaves conversion unverified when no call to action appears", () => {
    const result = extractStructure("## Care options\n\nFamilies can compare the available types of home care.");

    expect(result).toMatchObject({ hasCta: false, ctaText: null });
  });
});
