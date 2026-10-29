import { describe, expect, it } from "vitest";
import { articleReviewState } from "./article-review";

const ready = { status: "awaiting_approval", editing: false, canEdit: true, canReview: true, hasContent: true, verdicts: ["pass", "warn"] };

describe("article review availability", () => {
  it("allows a reviewer to decide on the checked current version", () => {
    expect(articleReviewState(ready)).toMatchObject({ canApprove: true, canRequestChanges: true });
  });
  it("shows the path to approval when checks are missing", () => {
    expect(articleReviewState({ ...ready, verdicts: [] })).toMatchObject({ canApprove: false, canRequestChanges: true, canRunQa: true });
    expect(articleReviewState({ ...ready, verdicts: [] }).explanation).toMatch(/Run quality checks/);
  });
  it("keeps a failing version blocked while still allowing rejection", () => {
    expect(articleReviewState({ ...ready, verdicts: ["pass", "fail"] })).toMatchObject({ canApprove: false, canRequestChanges: true });
    expect(articleReviewState({ ...ready, verdicts: ["fail"] }).explanation).toMatch(/Fix the 1 failing/);
  });
  it("offers checks after editing sends the article back for changes", () => {
    expect(articleReviewState({ ...ready, status: "needs_changes", verdicts: [] })).toMatchObject({ canApprove: false, canRequestChanges: false, canRunQa: true });
    expect(articleReviewState({ ...ready, status: "needs_changes" }).rejectReason).toMatch(/already been returned/);
  });
  it("does not approve a draft based only on existing gate results", () => {
    expect(articleReviewState({ ...ready, status: "draft" })).toMatchObject({ canApprove: false, canRequestChanges: false, canRunQa: true });
  });
  it.each(["approved", "published"])("allows requesting changes from %s without approving again", status => {
    expect(articleReviewState({ ...ready, status })).toMatchObject({ canApprove: false, canRequestChanges: true, canRunQa: false });
  });
  it("keeps decisions disabled while manual edits are open", () => {
    expect(articleReviewState({ ...ready, editing: true })).toMatchObject({ canApprove: false, canRequestChanges: false, canRunQa: false });
  });
  it("keeps viewer access read-only", () => {
    expect(articleReviewState({ ...ready, canEdit: false, canReview: false })).toMatchObject({ canApprove: false, canRequestChanges: false, canRunQa: false });
  });
  it("does not request checks for an empty draft", () => {
    expect(articleReviewState({ ...ready, status: "draft", hasContent: false })).toMatchObject({ canApprove: false, canRunQa: false });
  });
  it("does not offer rejection while scheduled publishing may be running", () => {
    expect(articleReviewState({ ...ready, status: "scheduled" })).toMatchObject({ canApprove: false, canRequestChanges: false, canRunQa: false });
  });
});
