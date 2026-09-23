import { describe, it, expect, vi, afterEach } from "vitest";
import { readState, resumeAt, nextStep, deriveNextAction } from "./onboarding";
import { onboardingRequest } from "./onboarding-request";

afterEach(() => vi.unstubAllGlobals());

describe("onboarding recovery", () => {
  it("restores completed setup choices after refresh", () => {
    const state = readState({ onboarding: { goals: ["articles"], tone: "bold", contentPillars: ["education", "authority"], brandColors: [{ hex: "#123456", role: "primary" }], platforms: ["LinkedIn"], sourceMode: "manual", manual: { name: "Clinic", offer: "Dental care", audience: "Families", serviceArea: "Hyderabad" }, completedSteps: ["discovery", "goals", "source", "detecting", "confirm", "colors"] } });
    expect(resumeAt(state)).toBe("pillars");
    expect(state.tone).toBe("bold");
    expect(state.brandColors?.[0]?.hex).toBe("#123456");
    expect(state.manual?.serviceArea).toBe("Hyderabad");
    expect(state.platforms).toEqual(["LinkedIn"]);
  });
  it("lets users retry completion when the final save succeeded but completion failed", () => {
    const state = readState({ onboarding: { goals: ["articles"], completedSteps: ["discovery", "goals", "source", "detecting", "confirm", "colors", "pillars"] } });
    expect(resumeAt(state)).toBe("pillars");
  });
  it("manual source proceeds through review and setup", () => {
    const state = readState({ onboarding: { goals: ["local"], completedSteps: ["discovery", "goals", "source", "detecting"] } });
    expect(resumeAt(state)).toBe("confirm");
    expect(nextStep("confirm", state.goals)).toBe("colors");
  });
});

describe("onboarding requests", () => {
  it("rejects failed completion instead of allowing dashboard navigation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "Review your business first." } }), { status: 400 })));
    await expect(onboardingRequest("/api/onboarding/step", { method: "PUT" })).rejects.toThrow("Review your business first.");
  });
  it("shows field validation errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "Validation failed", details: { fields: { url: ["Enter a valid website address."] } } } }), { status: 400 })));
    await expect(onboardingRequest("/api/onboarding/business-source")).rejects.toThrow("Enter a valid website address.");
  });
  it("rejects non-JSON server failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Unavailable", { status: 503 })));
    await expect(onboardingRequest("/api/onboarding/step")).rejects.toThrow("Could not save");
  });
});

describe("the next action", () => {
  const base = {
    hasBusiness: true,
    crawlStatus: "succeeded" as string | null,
    confirmed: true,
    awaitingApproval: 0,
    totalArticles: 3,
  };

  it("asks for a website before anything else", () => {
    expect(deriveNextAction({ ...base, hasBusiness: false }).href).toBe("/onboarding");
  });

  it("waits while the crawl runs", () => {
    for (const status of ["running", "pending"]) {
      expect(deriveNextAction({ ...base, crawlStatus: status }).title).toContain("Reading");
    }
  });

  it("offers a way out of a failed crawl", () => {
    // A dead end here is the worst case: the site cannot be read and nothing
    // tells them manual entry exists.
    for (const status of ["failed", "blocked"]) {
      expect(deriveNextAction({ ...base, crawlStatus: status }).href).toBe("/settings/business");
    }
  });

  it("wants the profile confirmed before any writing", () => {
    const a = deriveNextAction({ ...base, confirmed: false, totalArticles: 0 });
    expect(a.title).toContain("Confirm");
  });

  it("puts approvals ahead of new work", () => {
    /*
     * A queue of unreviewed drafts means the workspace is spending faster
     * than it publishes. Suggesting more generation would make that worse.
     */
    const a = deriveNextAction({ ...base, awaitingApproval: 4, totalArticles: 10 });
    expect(a.title).toContain("4 drafts");
    expect(a.href).toContain("awaiting_approval");
  });

  it("uses the singular for one draft", () => {
    expect(deriveNextAction({ ...base, awaitingApproval: 1 }).title).toContain("1 draft waiting");
  });

  it("suggests a first article once set up", () => {
    expect(deriveNextAction({ ...base, totalArticles: 0 }).title).toContain("first article");
  });

  it("has something to say when nothing is outstanding", () => {
    const a = deriveNextAction(base);
    expect(a.title.length).toBeGreaterThan(0);
    expect(a.href).toBe("/articles");
  });
});
