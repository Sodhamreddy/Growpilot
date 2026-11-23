import { describe, expect, it } from "vitest";
import { canPublish, statusAfterGates } from "./approval.js";
import {
  changesRequestedAt, contentApproved, emptyRoster, isWaitingOn, mayActForTeam, mayPublish, mayRequestChanges,
  reviewProcessOf, stageTeams, teamReviewStage, type ReviewSignOff, type TeamRoster,
} from "./team-review.js";

const roster: TeamRoster = { content: ["writer"], manager: ["boss"] };
const actor = (userId: string, role: "owner" | "admin" | "editor" | "viewer" = "editor") => ({ userId, role });
const signOff = (step: ReviewSignOff["step"], decision: ReviewSignOff["decision"], version: number, minute: number): ReviewSignOff =>
  ({ step, decision, version, at: new Date(Date.UTC(2026, 10, 18, 9, minute)) });

describe("team review stages", () => {
  it("walks Content review, Manager approval and Publish", () => {
    expect(teamReviewStage({ status: "qa", version: 1 }, [])).toBe("drafting");
    expect(teamReviewStage({ status: "awaiting_approval", version: 1 }, [])).toBe("content");
    expect(teamReviewStage({ status: "awaiting_approval", version: 1 }, [signOff("content", "approved", 1, 1)])).toBe("manager");
    expect(teamReviewStage({ status: "approved", version: 1 }, [])).toBe("publish");
    expect(teamReviewStage({ status: "approved", version: 1 }, [], { delivered: true })).toBe("sent");
    expect(teamReviewStage({ status: "published", version: 1 }, [])).toBe("live");
    expect(teamReviewStage({ status: "needs_changes", version: 1 }, [])).toBe("revision");
  });

  it("starts again at Content review after an edit makes a new version", () => {
    expect(teamReviewStage({ status: "awaiting_approval", version: 2 }, [signOff("content", "approved", 1, 1)])).toBe("content");
  });

  it("does not let re-run checks skip the Content team after the article was sent back", () => {
    const history = [signOff("content", "approved", 3, 1), signOff("manager", "changes_requested", 3, 5)];
    expect(contentApproved(3, history)).toBe(false);
    expect(teamReviewStage({ status: "awaiting_approval", version: 3 }, history)).toBe("content");
    expect(contentApproved(3, [...history, signOff("content", "approved", 3, 9)])).toBe(true);
  });

  it("names the teams whose turn it is: publishing belongs to both", () => {
    expect(stageTeams("content")).toEqual(["content"]);
    expect(stageTeams("revision")).toEqual(["content"]);
    expect(stageTeams("manager")).toEqual(["manager"]);
    expect(stageTeams("publish")).toEqual(["content", "manager"]);
    expect(stageTeams("sent")).toEqual([]);
    expect(stageTeams("drafting")).toEqual([]);
  });
});

describe("who may act", () => {
  it("lets only a team's members act for it", () => {
    expect(mayActForTeam("content", actor("writer"), roster)).toBe(true);
    expect(mayActForTeam("manager", actor("writer"), roster)).toBe(false);
    expect(mayActForTeam("content", actor("someone", "owner"), roster)).toBe(false);
  });

  it("never lets a viewer act, even when listed", () => {
    expect(mayActForTeam("content", actor("writer", "viewer"), roster)).toBe(false);
  });

  it("lets admins act for a team nobody is on, so no level can be stuck", () => {
    const empty = { ...roster, manager: [] };
    expect(mayActForTeam("manager", actor("admin-1", "admin"), empty)).toBe(true);
    expect(mayActForTeam("manager", actor("editor-1", "editor"), empty)).toBe(false);
    expect(mayActForTeam("content", actor("owner-1", "owner"), emptyRoster())).toBe(true);
  });

  it("lets anyone on the Content team or a Manager publish, and nobody else", () => {
    expect(mayPublish(actor("writer"), roster)).toBe(true);
    expect(mayPublish(actor("boss"), roster)).toBe(true);
    expect(mayPublish(actor("outsider", "owner"), roster)).toBe(false);
    expect(mayPublish(actor("writer", "viewer"), roster)).toBe(false);
  });

  it("lets either team send an approved article back, and records the level", () => {
    expect(mayRequestChanges("publish", actor("boss"), roster)).toBe(true);
    expect(mayRequestChanges("publish", actor("writer"), roster)).toBe(true);
    expect(mayRequestChanges("publish", actor("outsider", "owner"), roster)).toBe(false);
    expect(mayRequestChanges("manager", actor("writer"), roster)).toBe(false);
    expect(changesRequestedAt("publish", actor("writer"), roster)).toBe("content");
    expect(changesRequestedAt("publish", actor("boss"), roster)).toBe("manager");
    expect(changesRequestedAt("content", actor("writer"), roster)).toBe("content");
  });

  it("knows whose queue an article is in", () => {
    expect(isWaitingOn("revision", actor("writer"), roster)).toBe(true);
    expect(isWaitingOn("manager", actor("writer"), roster)).toBe(false);
    expect(isWaitingOn("publish", actor("writer"), roster)).toBe(true);
    expect(isWaitingOn("publish", actor("boss"), roster)).toBe(true);
    expect(isWaitingOn("sent", actor("boss"), roster)).toBe(false);
  });
});

describe("the review process setting", () => {
  it("defaults to the single reviewer", () => {
    expect(reviewProcessOf({})).toBe("single");
    expect(reviewProcessOf(null)).toBe("single");
    expect(reviewProcessOf({ reviewProcess: "team" })).toBe("team");
  });

  it("always sends a passing article to review in team mode, even when single approval is switched off", () => {
    expect(statusAfterGates(true, { reviewProcess: "team", requireApprovalBeforePublish: false })).toBe("awaiting_approval");
    expect(statusAfterGates(false, { reviewProcess: "team" })).toBe("needs_changes");
  });

  it("refuses to publish an unapproved article in team mode", () => {
    const article = { status: "approved" as const, seoScore: 90, voiceScore: 90, approvedAt: null };
    const gates = [{ gate: "seo", verdict: "pass" as const }];
    expect(canPublish(article, { reviewProcess: "team", requireApprovalBeforePublish: false }, gates).allowed).toBe(false);
    expect(canPublish({ ...article, approvedAt: new Date() }, { reviewProcess: "team" }, gates).allowed).toBe(true);
  });
});
