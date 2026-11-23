export const dynamic = "force-dynamic";

import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { AppError, forbidden } from "@ob/core";
import { articles, articleReviews, repo } from "@ob/db";
import {
  assertTransition, assertMayApprove, changesRequestedAt, mayActForTeam, mayRequestChanges, stageTeams, teamReviewStage,
  REVIEW_TEAM_LABELS, type ReviewTeam,
} from "@ob/pipeline";
import { route, parseBody } from "@/lib/api";
import { db } from "@/lib/services";
import { loadSignOffs, loadTeamSetup, reviewProcessFor, teamNames, type TeamSetup } from "@/lib/team-review-server";

/**
 * POST /api/articles/:id/approve — spec §14, §15.1 "Publishing: approval
 * policy must pass", §15 "Audit publish/approve/connect actions".
 *
 * Approval is a human act with consequences, so it is: role-gated, refused
 * while any gate is failing, and written to the audit log with the approver
 * and the exact article version they approved.
 *
 * In a workspace using the team review, "approve" means the next level: the
 * Content team's approval moves the article on to a Manager, and only a
 * Manager's approval makes it publishable. Each level is checked against the
 * team roster on the server, whatever the page showed.
 */

const schema = z.object({
  expectedVersion: z.number().int().positive(),
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
  if (body.expectedVersion !== article.version) {
    throw new AppError("conflict", "The draft changed. Review the latest version before making a decision.", { retryable: false });
  }

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

  // The team review, when this workspace uses it: who may act depends on the level the article is at.
  const setup = (await reviewProcessFor(database, ctx)) === "team" ? await loadTeamSetup(database, ctx) : null;
  const team = setup?.process === "team" ? setup : null;
  const actor = { userId: ctx.userId, role: ctx.role };
  const stage = team ? teamReviewStage(article, await loadSignOffs(database, ctx, [id])) : null;
  const note = body.note?.trim() || null;

  if (body.decision === "request_changes") {
    if (team && stage && !mayRequestChanges(stage, actor, team.roster)) {
      const waiting = stageTeams(stage);
      throw forbidden(waiting.length ? `Only ${waiting.map((key) => who(team, key)).join(" or ")} can send this article back at this level.` : "This article can't be sent back right now.");
    }
    assertTransition(article.status, "needs_changes");
    const [changed] = await database
      .update(articles)
      .set({ status: "needs_changes", approvedAt: null, approvedBy: null, updatedAt: new Date() })
      .where(and(eq(articles.id, id), eq(articles.workspaceId, ctx.workspaceId),
        eq(articles.version, article.version), eq(articles.status, article.status))).returning({ id: articles.id });
    if (!changed) throw new AppError("conflict", "The article changed. Refresh before requesting changes.", { retryable: false });

    const step = team && stage ? changesRequestedAt(stage, actor, team.roster) : null;
    if (step) {
      await database.insert(articleReviews).values({ workspaceId: ctx.workspaceId, articleId: id, articleVersion: article.version,
        step, decision: "changes_requested", userId: ctx.userId, note });
    }
    await repo.writeAudit(database, ctx, {
      action: "article.changes_requested",
      entityType: "article",
      entityId: id,
      before: { status: article.status },
      after: { status: "needs_changes", version: article.version, note: body.note ?? null, ...(step ? { step } : {}) },
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

  if (team && stage) {
    if (stage === "content") {
      // Level 1: the Content team approves the draft for a Manager. The article's status does not change.
      if (!mayActForTeam("content", actor, team.roster)) throw forbidden(`This article is waiting for ${who(team, "content")}. Only they can approve this level.`);
      await database.insert(articleReviews).values({ workspaceId: ctx.workspaceId, articleId: id, articleVersion: article.version,
        step: "content", decision: "approved", userId: ctx.userId, note });
      await repo.writeAudit(database, ctx, { action: "article.content_approved", entityType: "article", entityId: id,
        after: { version: article.version, step: "content", note } });
      return { ok: true, status: article.status, version: article.version, stage: "manager" };
    }
    if (stage !== "manager") throw new AppError("conflict", "This article is not waiting for an approval.", { retryable: false });
    // Level 2: only a Manager's approval makes the article publishable.
    if (!mayActForTeam("manager", actor, team.roster)) throw forbidden(`This article is waiting for ${who(team, "manager")}. Only they can give the final approval.`);
  }

  assertTransition(article.status, "approved");

  const [approved] = await database
    .update(articles)
    .set({ status: "approved", approvedBy: ctx.userId, approvedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(articles.id, id), eq(articles.workspaceId, ctx.workspaceId),
      eq(articles.version, article.version), eq(articles.status, article.status))).returning({ id: articles.id });
  if (!approved) throw new AppError("conflict", "The article changed. Review the current version before approving.", { retryable: false });

  if (team) {
    await database.insert(articleReviews).values({ workspaceId: ctx.workspaceId, articleId: id, articleVersion: article.version,
      step: "manager", decision: "approved", userId: ctx.userId, note });
  }
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
      ...(team ? { step: "manager" } : {}),
    },
  });

  return { ok: true, status: "approved", version: article.version };
});

/** "the Content team (Priya, Rahul)" — or the admins, when nobody is on that team yet. */
function who(team: TeamSetup, key: ReviewTeam): string {
  const names = teamNames(team, key);
  const label = REVIEW_TEAM_LABELS[key];
  const article = key === "content" ? "the " : "";
  return names.length ? `${article}${label} (${names.join(", ")})` : `the workspace admins (nobody is on ${label} yet)`;
}

function articleIdFrom(req: Request): string {
  const segments = new URL(req.url).pathname.split("/");
  return segments[segments.indexOf("articles") + 1] ?? "";
}
