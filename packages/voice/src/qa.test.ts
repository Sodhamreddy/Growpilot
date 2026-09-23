import { describe, it, expect } from "vitest";
import { runVoiceQa, stripMarkdown } from "./qa.js";
import { DEFAULT_VOICE_PROFILE, DEFAULT_BANNED_TERMS } from "./profile.js";

const CLEAN_BODY = [
  "We fit dental implants at our Hyderabad clinic.",
  "The procedure takes about two hours and most people return to work the next day.",
  "Our team will talk you through what to expect before anything is booked.",
  "If you would like to discuss your options, book a consultation with us.",
].join(" ");

function qa(body: string, overrides: Partial<Parameters<typeof runVoiceQa>[0]> = {}) {
  return runVoiceQa({
    bodyMarkdown: body,
    profile: DEFAULT_VOICE_PROFILE,
    bannedTerms: [...DEFAULT_BANNED_TERMS],
    preferredTerms: [],
    ...overrides,
  });
}

describe("runVoiceQa — banned terms", () => {
  it("fails on a banned term", () => {
    const r = qa("Our results are guaranteed. Book a consultation.");
    expect(r.verdict).toBe("fail");
    expect(r.findings.some((f) => f.check === "vocabulary" && f.severity === "error")).toBe(true);
  });

  it("matches a banned term regardless of casing", () => {
    expect(qa("GUARANTEED results. Book a consultation.").verdict).toBe("fail");
  });

  it("does not match a banned term inside a longer word", () => {
    // "cure" is banned; "manicure" and "secure" must not trip it.
    const r = qa("We offer a secure booking system. Book a consultation with us today.");
    expect(r.findings.filter((f) => f.check === "vocabulary")).toHaveLength(0);
  });

  it("quotes the surrounding text as evidence", () => {
    const f = qa("Our implants are guaranteed for life. Book a consultation.")
      .findings.find((x) => x.check === "vocabulary")!;
    expect(f.evidence).toContain("guaranteed");
  });
});

describe("runVoiceQa — unsupported claims", () => {
  it.each([
    "We promise a perfect smile.",
    "This treatment is 100% effective.",
    "We are the number one clinic in the city.",
    "Get instant results with our whitening.",
    "This is a risk-free procedure.",
  ])("flags %j", (sentence) => {
    const r = qa(`${sentence} Book a consultation.`);
    expect(r.findings.some((f) => f.check === "claims" || f.check === "vocabulary")).toBe(true);
    expect(r.verdict).toBe("fail");
  });

  it("passes clean, evidence-shaped copy", () => {
    const r = qa(CLEAN_BODY);
    expect(r.findings.filter((f) => f.check === "claims")).toHaveLength(0);
  });
});

describe("runVoiceQa — preferred terms", () => {
  it("warns when the disfavoured term is used", () => {
    const r = qa("Book a sales call with our team today.", {
      preferredTerms: [{ use: "consultation", insteadOf: "sales call" }],
    });
    const f = r.findings.find((x) => x.check === "vocabulary");
    expect(f?.severity).toBe("warn");
    expect(f?.suggestion).toContain("consultation");
  });
});

describe("runVoiceQa — CTA", () => {
  it("warns when no CTA matching the brand style is present", () => {
    const r = qa("We fit dental implants. The procedure takes two hours.");
    expect(r.findings.some((f) => f.check === "cta")).toBe(true);
  });

  it("accepts a consultation CTA for the consultation style", () => {
    const r = qa(CLEAN_BODY);
    expect(r.findings.filter((f) => f.check === "cta")).toHaveLength(0);
  });

  it("does not accept a purchase CTA for the consultation style", () => {
    const r = qa("We fit implants. Buy now and save.", {
      profile: { ...DEFAULT_VOICE_PROFILE, ctaStyle: "consultation" },
    });
    expect(r.findings.some((f) => f.check === "cta")).toBe(true);
  });
});

describe("runVoiceQa — tone", () => {
  it("notes when the semantic tone check has not run", () => {
    const r = qa(CLEAN_BODY);
    expect(r.findings.some((f) => f.check === "tone" && f.severity === "info")).toBe(true);
  });

  it("fails on a low tone-match score", () => {
    expect(qa(CLEAN_BODY, { toneMatchScore: 40 }).verdict).toBe("fail");
  });

  it("warns on a borderline tone-match score", () => {
    const r = qa(CLEAN_BODY, { toneMatchScore: 70 });
    expect(r.findings.some((f) => f.check === "tone" && f.severity === "warn")).toBe(true);
  });

  it("uses the tone score as the score baseline", () => {
    expect(qa(CLEAN_BODY, { toneMatchScore: 95 }).score).toBeGreaterThan(
      qa(CLEAN_BODY, { toneMatchScore: 78 }).score,
    );
  });
});

describe("runVoiceQa — score and verdict", () => {
  it("keeps the score within 0–100", () => {
    const r = qa("guaranteed cure #1 instant results risk-free miracle 100% effective");
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
  });

  it("escalates verdict with severity", () => {
    expect(qa(CLEAN_BODY, { toneMatchScore: 90 }).verdict).toBe("pass");
    expect(qa("We fit implants.", { toneMatchScore: 90 }).verdict).toBe("warn");
    expect(qa("Guaranteed results.", { toneMatchScore: 90 }).verdict).toBe("fail");
  });
});

describe("stripMarkdown", () => {
  it("removes formatting but keeps prose and anchor text", () => {
    const out = stripMarkdown("## Heading\n\nSome **bold** and [a link](https://x.com) text.\n\n- bullet");
    expect(out).toBe("Heading Some bold and a link text. bullet");
  });

  it("removes fenced code blocks entirely", () => {
    expect(stripMarkdown("Before\n\n```js\nconst guaranteed = 1;\n```\n\nAfter")).toBe("Before After");
  });

  it("removes image markup but keeps surrounding text", () => {
    expect(stripMarkdown("See ![alt text](img.png) here")).toBe("See here");
  });
});
