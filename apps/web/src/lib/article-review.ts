/** Review availability mirrors the existing article lifecycle and quality requirements. */
export function articleReviewState({ status, editing, canEdit, canReview, hasContent, verdicts }: {
  status: string; editing: boolean; canEdit: boolean; canReview: boolean; hasContent: boolean; verdicts: string[];
}) {
  const failedChecks = verdicts.filter(verdict => verdict === "fail").length;
  const canApprove = canReview && !editing && hasContent && status === "awaiting_approval" && verdicts.length > 0 && failedChecks === 0;
  const canRequestChanges = canReview && !editing && ["qa", "awaiting_approval", "approved", "published"].includes(status);
  const canRunQa = canEdit && !editing && hasContent && ["draft", "needs_changes", "awaiting_approval"].includes(status);
  let explanation: string;
  if (!canReview) explanation = "You have view-only access. An editor or administrator can review this article.";
  else if (editing) explanation = "Save or discard your edits before reviewing this version.";
  else if (["generating", "qa"].includes(status)) explanation = "Review becomes available after writing and quality checks finish.";
  else if (status === "failed") explanation = "Writing did not finish. Resolve the failed generation before approving this article.";
  else if (["approved", "published"].includes(status)) explanation = "This version is already approved. Request changes to return it to editing.";
  else if (status === "scheduled") explanation = "This article is already approved and scheduled for publishing.";
  else if (!hasContent) explanation = "Generate the article before reviewing it.";
  else if (status === "needs_changes") explanation = failedChecks
    ? `This draft already needs changes. Fix the ${failedChecks} failing quality check${failedChecks === 1 ? "" : "s"}, then run quality checks again.`
    : "Changes are already requested. Edit this draft, then run quality checks to send it back for approval.";
  else if (failedChecks) explanation = `Fix the ${failedChecks} failing quality check${failedChecks === 1 ? "" : "s"}, then run quality checks again to enable approval.`;
  else if (!canApprove) explanation = "Run quality checks for this version to send it for approval.";
  else explanation = "Review the article, then approve it or request changes.";
  return { canApprove, canRequestChanges, canRunQa, explanation,
    rejectReason: status === "needs_changes" ? "This draft has already been returned for changes. Edit it, then run quality checks again."
      : canRequestChanges ? "Return this draft for changes" : explanation };
}
