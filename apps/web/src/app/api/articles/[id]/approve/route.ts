export const dynamic = "force-dynamic";

import { z } from "zod";
import { eq } from "drizzle-orm";
import { AppError } from "@ob/core";
import { articles, repo } from "@ob/db";
import { assertTransition, assertMayApprove } from "@ob/pipeline";
import { route, parseBody } from "@/lib/api";
import { db } from "@/lib/services";

/**
 * POST /api/articles/:id/approve — spec §14, §15.1 "Publishing: approval
 * policy must pass", §15 "Audit publish/approve/connect actions".
 *
 * Approval is a human act with consequences, so it is: role-gated, refused
 * while any gate is failing, and written to the audit log with the approver
 * and the exact article version they approved.
 */

const schema = z.object({
  /*
   * "note" records a comment without changing the article's state.
   *
   * A reviewer reading a fresh draft — before quality gates have run, so
   * neither approving nor requesting changes is possible yet — still needs
   * somewhere to write what they noticed. Without this the only way to leave a
   * remark was to first move the article, which is a decision, not a comment.
   */
  decision: z.enum(["approve", "request_changes", "note"]),
  note: z.string().max(2000).optional(),
});

export const POST = route(async (ctx, req) => {
  assertMayApprove(ctx);
  const body = await parseBody(req, schema);
  const id = articleIdFrom(req);
  const database = db();

  const article = await repo.getArticle(database, ctx, id);

  if (body.decision === "note") {
    if (!body.note?.trim()) {
      throw new AppError("validation_failed", "Write something before saving the note.", {
        retryable: false,
      });
    }

    // Recorded against the version it was written about: a note saying "the
    // third paragraph is wrong" means nothing once the text has changed.
    await repo.writeAudit(database, ctx, {
      action: "article.note_added",
      entityType: "article",
      entityId: id,
      after: { version: article.version, status: article.status, note: body.note.trim() },
    });

    return { ok: true, status: article.status, noted: true };
  }

  if (body.decision === "request_changes") {
    assertTransition(article.status, "needs_changes");
    await database
      .update(articles)
      .set({ status: "needs_changes", updatedAt: new Date() })
      .where(eq(articles.id, id));

    await repo.writeAudit(database, ctx, {
      action: "article.changes_requested",
      entityType: "article",
      entityId: id,
      before: { status: article.status },
      after: { status: "needs_changes", version: article.version, note: body.note ?? null },
    });

    return { ok: true, status: "needs_changes" };
  }

  // Re-check the gates at approval time. They ran against this version, but
  // the profile or the workspace policy may have changed since (spec §18.1
  // critical test: "business profile changed after draft").
  const gates = await repo.listGateResults(database, ctx, id, article.version);

  if (gates.length === 0) {
    throw new AppError("quality_gate_failed", "Quality gates have not run for this version yet.", {
      details: { articleId: id, version: article.version },
      retryable: false,
    });
  }

  const failing = gates.filter((g) => g.verdict === "fail");
  if (failing.length > 0) {
    throw new AppError(
      "quality_gate_failed",
      "This article cannot be approved while quality gates are failing.",
      {
        details: {
          failing: failing.map((g) => ({
            gate: g.gate,
            errors: g.findings.filter((f) => f.severity === "error").map((f) => f.message),
          })),
        },
        retryable: false,
      },
    );
  }

  assertTransition(article.status, "approved");

  await database
    .update(articles)
    .set({ status: "approved", approvedBy: ctx.userId, approvedAt: new Date(), updatedAt: new Date() })
    .where(eq(articles.id, id));

  await repo.writeAudit(database, ctx, {
    action: "article.approved",
    entityType: "article",
    entityId: id,
    before: { status: article.status },
    after: {
      status: "approved",
      version: article.version,
      seoScore: article.seoScore,
      voiceScore: article.voiceScore,
      note: body.note ?? null,
    },
  });

  return { ok: true, status: "approved", version: article.version };
});

function articleIdFrom(req: Request): string {
  const segments = new URL(req.url).pathname.split("/");
  return segments[segments.indexOf("articles") + 1] ?? "";
}
