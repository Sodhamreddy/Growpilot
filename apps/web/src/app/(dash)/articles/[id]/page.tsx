import Link from "next/link";

/** States in which a draft accepts changes — mirrors DraftEditor. */
const DRAFT_EDITABLE = ["draft", "qa", "needs_changes", "awaiting_approval"];
import { requireTenant } from "@/lib/auth";
import { db } from "@/lib/services";
import { eq, and } from "drizzle-orm";
import { repo, topics, keywords, integrations } from "@ob/db";
// Section splitting lives with the blog module that owns article structure.
import { splitSections } from "@ob/blog";
import type { GateFinding, ScoreComponent } from "@ob/db";
import { ApprovalActions } from "@/components/ApprovalActions";
import { ScoreGauge, tone } from "@/components/ScoreGauge";
import { TopBar } from "@/components/TopBar";
import { DraftEditor } from "@/components/DraftEditor";
import { BlogCompanion } from "@/components/BlogCompanion";
import { getSession } from "@/lib/auth";

/**
 * Article review — where a person approves or rejects.
 *
 * Spec §7.1 requires the score to be explainable and §18 requires QA to
 * "explain results", so the weighted breakdown and every gate finding are on
 * the page rather than behind an interaction.
 */

export const dynamic = "force-dynamic";

const GATES: Record<string, { title: string; desc: string }> = {
  grounding: { title: "Grounding", desc: "Claims map to evidence" },
  business_facts: { title: "Business facts", desc: "Uses the verified profile" },
  brand: { title: "Brand voice", desc: "Tone, vocabulary and CTA" },
  seo: { title: "SEO", desc: "Deterministic on-page checks" },
  risk: { title: "Risk", desc: "Sensitive topics need a human" },
  publishing: { title: "Publishing", desc: "Workspace approval policy" },
  audit: { title: "Audit", desc: "Model and prompt recorded" },
};

const STATUS_TONE: Record<string, string> = {
  published: "ok", approved: "ok", awaiting_approval: "warn",
  needs_changes: "warn", failed: "fail",
};

export default async function ArticlePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireTenant();
  const initials = await avatarInitials();
  const { id } = await params;
  const database = db();

  const article = await repo.getArticle(database, ctx, id);
  /*
   * Gates still load, even though their detail is no longer shown.
   *
   * Approval depends on them: an article cannot be approved while a gate is
   * failing, and the reason has to be nameable. What was removed is the wall of
   * diagnostics, not the check itself.
   */
  const gates = await repo.listGateResults(database, ctx, id, article.version);
  const business = await repo.getBusiness(database, ctx, article.businessId);

  /*
   * The focus keyword, from the topic this article was planned against.
   *
   * It drives the whole draft — the brief, the title, the meta description —
   * but was not shown anywhere, so a reviewer could not tell what the article
   * was even aiming to rank for. Null when an article was created without a
   * topic, which is honest rather than falling back to the title and implying
   * a keyword nobody chose.
   */
  const [topic] = article.topicId
    ? await database
        .select({ keywordId: topics.primaryKeywordId, secondary: topics.secondaryTerms })
        .from(topics)
        .where(and(eq(topics.workspaceId, ctx.workspaceId), eq(topics.id, article.topicId)))
        .limit(1)
    : [];

  const [focusKeyword] = topic?.keywordId
    ? await database
        .select({ term: keywords.term })
        .from(keywords)
        .where(and(eq(keywords.workspaceId, ctx.workspaceId), eq(keywords.id, topic.keywordId)))
        .limit(1)
    : [];

  /*
   * Counted from the body rather than stored, so an edit shows immediately.
   *
   * "Internal" means the client's own site, not "relative URL". The generator
   * links to crawled pages by their absolute address, so a scheme check alone
   * reported four links to the customer's own services pages as outbound —
   * which is the opposite of what an SEO reviewer needs to know.
   */
  const siteHost = (() => {
    try {
      return business?.websiteUrl ? new URL(business.websiteUrl).hostname.replace(/^www\./, "") : null;
    } catch {
      return null;
    }
  })();

  const linkMatches = [...article.bodyMarkdown.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)];
  const externalLinks = linkMatches.filter((m) => {
    const url = m[2]!;
    if (!/^https?:\/\//i.test(url)) return false;
    if (!siteHost) return true;
    try {
      return new URL(url).hostname.replace(/^www\./, "") !== siteHost;
    } catch {
      return true;
    }
  }).length;
  const internalLinks = linkMatches.length - externalLinks;

  const failing = gates.filter((g) => g.verdict === "fail");
  const canApprove = article.status === "awaiting_approval" && failing.length === 0;
  const errorCount = gates.reduce(
    (n, g) => n + (g.findings as GateFinding[]).filter((f) => f.severity === "error").length, 0);
  const warnCount = gates.reduce(
    (n, g) => n + (g.findings as GateFinding[]).filter((f) => f.severity === "warn").length, 0);

  const canEditDraft = ctx.role === "owner" || ctx.role === "admin" || ctx.role === "editor";

  /*
   * Where this article would publish to.
   *
   * The publish route accepts a provider and checks the connection is live;
   * asking here means the button can say "Publish to wordpress" and can be
   * replaced with an explanation when nothing is connected, rather than
   * failing after the click.
   */
  const connected = await database
    .select({ provider: integrations.provider, status: integrations.status })
    .from(integrations)
    .where(eq(integrations.workspaceId, ctx.workspaceId));
  const publishTarget =
    connected.find((c) => c.status === "connected" && c.provider === "wordpress")?.provider
    ?? connected.find((c) => c.status === "connected")?.provider
    ?? null;

  const published = article.status === "published";
  const canPublish =
    article.status === "approved" && Boolean(publishTarget) && canEditDraft;
  // Re-running the gates is what the blocked-approval message asks for, so it
  // is offered exactly while the draft can still be changed.
  const canRunQa = canEditDraft && DRAFT_EDITABLE.includes(article.status);

  return (
    <>
      <TopBar section="Create" page="Article" initials={initials} />
      <div className="content">
      <div className="pagehead">
        <p className="small" style={{ marginBottom: 8 }}>
          <Link href="/articles">← Articles</Link>
        </p>
        <div className="titlerow">
          <h1>{article.title}</h1>
          <span className={`badge ${STATUS_TONE[article.status] ?? "neutral"}`}>
            {article.status.replace(/_/g, " ")}
          </span>
        </div>
        <p className="mono" style={{ fontSize: 12 }}>/{article.slug}</p>
        {/* The keyword the draft was written to rank for, next to the title it
            shaped, rather than in a stats row away from it. */}
        {focusKeyword?.term ? (
          <p className="small" style={{ margin: "8px 0 0" }}>
            <span className="muted">Focus keyword: </span>
            <strong>{focusKeyword.term}</strong>
            {topic?.secondary?.length ? (
              <span className="muted"> · +{topic.secondary.length} secondary</span>
            ) : null}
          </p>
        ) : null}
      </div>

      {/* ── Draft, with the companion beside it ── */}
      <div className="sectionhead">
        <h2>Draft</h2>
        <span className="note">Preview it, edit it, or ask for a change</span>
      </div>
      <div className="draftlayout">
        <DraftEditor
          canEdit={canEditDraft}
          article={{
            id: article.id,
            title: article.title,
            metaTitle: article.metaTitle,
            metaDescription: article.metaDescription,
            bodyMarkdown: article.bodyMarkdown,
            status: article.status,
            version: article.version,
            wordCount: article.wordCount,
          }}
        />
        <BlogCompanion
          articleId={article.id}
          canEdit={canEditDraft}
          editable={DRAFT_EDITABLE.includes(article.status)}
          sections={splitSections(article.bodyMarkdown).map((sec) => ({
            id: sec.id, heading: sec.heading, level: sec.level,
          }))}
        />
      </div>

      <div className="sectionhead"><h2>Approval</h2></div>
      <div className="card" style={{ marginBottom: 24 }}>
        {article.approvedAt ? (
          <p className="muted small">Approved on {article.approvedAt.toISOString().slice(0, 10)}.</p>
        ) : null}
        {/*
          * Why it is blocked, not just that it is.
          *
          * This used to name the failing gates and then say "fix the errors
          * above" — which asked a reviewer to scroll back up and work out
          * which of the findings there were the blocking ones, when the
          * findings are already in hand here. Naming three gates tells
          * somebody the shape of the problem and none of the substance.
          *
          * Only the errors are listed. Warnings do not block approval, so
          * including them would pad the one list a person needs to act on
          * with items that changing nothing about would still let them
          * through.
          */}
        {failing.length > 0 ? (
          <div className="finding error" style={{ marginBottom: 14 }}>
            <div>
              Cannot be approved while {failing.length} gate{failing.length === 1 ? "" : "s"}{" "}
              {failing.length === 1 ? "is" : "are"} failing.
            </div>
            <ul className="blockers">
              {failing.flatMap((g) => {
                /*
                 * A failing gate with no error-severity finding would list
                 * nothing at all, leaving "cannot be approved" with no reason
                 * under it — worse than the message this replaces. Falling
                 * back to the gate's own description keeps every failure
                 * accounted for whatever a future gate reports.
                 */
                const errors = g.findings.filter((f) => f.severity === "error");
                const rows = errors.length > 0
                  ? errors
                  : [{ message: GATES[g.gate]?.desc ?? "This check did not pass.", suggestion: "" }];

                return rows.map((f, i) => (
                  <li key={`${g.gate}-${i}`}>
                    <span className="blockers-gate">{GATES[g.gate]?.title ?? g.gate}</span>
                    <span className="blockers-msg">{f.message}</span>
                    {f.suggestion ? (
                      <span className="blockers-fix">{f.suggestion}</span>
                    ) : null}
                  </li>
                ));
              })}
            </ul>
            <div className="suggestion">→ Fix these, then re-run QA.</div>
          </div>
        ) : null}
        <ApprovalActions
          articleId={article.id}
          canApprove={canApprove}
          canRequestChanges={["qa", "awaiting_approval"].includes(article.status)}
          canPublish={canPublish}
          canRunQa={canRunQa}
          publishTarget={publishTarget}
          published={published}
        />
      </div>

      </div>
    </>
  );
}

/** Initials for the top-bar avatar. */
async function avatarInitials(): Promise<string> {
  const session = await getSession();
  return (
    (session?.name ?? session?.email ?? "?")
      .split(/[\s@.]+/).filter(Boolean).slice(0, 2)
      .map((p) => p[0]!.toUpperCase()).join("") || "?"
  );
}
