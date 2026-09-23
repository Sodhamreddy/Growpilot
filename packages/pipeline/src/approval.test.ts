import { describe, it, expect } from "vitest";
import { AppError } from "@ob/core";
import {
  canTransition, assertTransition, statusAfterGates, canPublish,
  type ArticleStatus,
} from "./approval.js";

describe("article state machine", () => {
  it("allows the happy path through to published", () => {
    const path: ArticleStatus[] = ["draft", "generating", "qa", "awaiting_approval", "approved", "published"];
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
    }
  });

  it("refuses to publish straight from draft", () => {
    expect(canTransition("draft", "published")).toBe(false);
    expect(() => assertTransition("draft", "published")).toThrow(AppError);
  });

  it("refuses to publish from qa without passing through approval", () => {
    expect(canTransition("qa", "published")).toBe(false);
  });

  it("refuses to publish from awaiting_approval directly", () => {
    expect(canTransition("awaiting_approval", "published")).toBe(false);
  });

  it("allows a published article to be revised but not re-approved directly", () => {
    expect(canTransition("published", "needs_changes")).toBe(true);
    expect(canTransition("published", "approved")).toBe(false);
  });

  it("reports the allowed targets on a rejected transition", () => {
    try {
      assertTransition("draft", "published");
      expect.unreachable();
    } catch (e) {
      const err = e as AppError;
      expect(err.code).toBe("conflict");
      expect(err.details["allowed"]).toEqual(["generating", "failed"]);
      // The message must be readable by a person (spec §10.3).
      expect(err.safeMessage).toBe('An article cannot move from "draft" to "published".');
    }
  });
});

describe("statusAfterGates", () => {
  it("sends a failing article back for changes", () => {
    expect(statusAfterGates(false, {})).toBe("needs_changes");
    expect(statusAfterGates(false, { requireApprovalBeforePublish: false })).toBe("needs_changes");
  });

  it("requires approval by default", () => {
    expect(statusAfterGates(true, {})).toBe("awaiting_approval");
  });

  it("auto-approves only when the workspace explicitly opts out", () => {
    expect(statusAfterGates(true, { requireApprovalBeforePublish: false })).toBe("approved");
    expect(statusAfterGates(true, { requireApprovalBeforePublish: true })).toBe("awaiting_approval");
  });
});

describe("canPublish", () => {
  const approved = {
    status: "approved" as ArticleStatus,
    seoScore: 85,
    voiceScore: 88,
    approvedAt: new Date(),
  };
  const passingGates = [
    { gate: "grounding", verdict: "pass" as const },
    { gate: "seo", verdict: "warn" as const },
  ];

  it("permits a fully approved article with passing gates", () => {
    expect(canPublish(approved, {}, passingGates)).toEqual({ allowed: true, reasons: [] });
  });

  it("blocks an unapproved article", () => {
    const r = canPublish({ ...approved, status: "qa", approvedAt: null }, {}, passingGates);
    expect(r.allowed).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/only approved articles/);
  });

  it("blocks when approval is required but missing", () => {
    const r = canPublish({ ...approved, approvedAt: null }, { requireApprovalBeforePublish: true }, passingGates);
    expect(r.allowed).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/requires human approval/);
  });

  it("blocks on a failing gate", () => {
    const r = canPublish(approved, {}, [...passingGates, { gate: "grounding", verdict: "fail" }]);
    expect(r.allowed).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/Quality gates failing: grounding/);
  });

  it("blocks when gates have not run at all", () => {
    const r = canPublish(approved, {}, []);
    expect(r.allowed).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/have not run/);
  });

  it("enforces the workspace SEO score floor", () => {
    const r = canPublish({ ...approved, seoScore: 55 }, { minSeoScoreToPublish: 70 }, passingGates);
    expect(r.allowed).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/SEO score 55.0 is below the minimum of 70/);
  });

  it("enforces the workspace voice score floor", () => {
    const r = canPublish({ ...approved, voiceScore: 40 }, { minVoiceScoreToPublish: 70 }, passingGates);
    expect(r.allowed).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/voice score 40 is below/);
  });

  it("applies a default score floor of 70 when none is configured", () => {
    expect(canPublish({ ...approved, seoScore: 69 }, {}, passingGates).allowed).toBe(false);
    expect(canPublish({ ...approved, seoScore: 71 }, {}, passingGates).allowed).toBe(true);
  });

  it("reports every blocking reason at once rather than the first", () => {
    const r = canPublish(
      { status: "draft", seoScore: 10, voiceScore: 10, approvedAt: null },
      { requireApprovalBeforePublish: true },
      [{ gate: "grounding", verdict: "fail" }],
    );
    expect(r.reasons.length).toBeGreaterThanOrEqual(4);
  });
});

describe("resuming an abandoned generation", () => {
  it("still refuses generating → generating as a transition", () => {
    // The worker resumes an abandoned claim explicitly rather than by widening
    // the state machine: allowing this would let a second worker trample a
    // generation that is genuinely in flight.
    expect(canTransition("generating", "generating")).toBe(false);
  });

  it("allows a failed article to be generated again", () => {
    expect(canTransition("failed", "generating")).toBe(true);
  });
});
