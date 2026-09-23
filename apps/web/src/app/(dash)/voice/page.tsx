import { eq, and, desc } from "drizzle-orm";
import { getClient } from "@/lib/tenant";
import { requireTenant } from "@/lib/auth";
import { db } from "@/lib/services";
import { repo, brandVoices } from "@ob/db";
import { ActivateVoice } from "@/components/ActivateVoice";
import { IconVoiceNav } from "@/components/Icons";
import { TopBar } from "@/components/TopBar";
import { getSession } from "@/lib/auth";

/**
 * Brand Voice — spec §18.
 *
 * Shows what was learned from the customer's own copy, which version is active,
 * and the term lists the brand gate enforces. Spec §18.8's rule — voice is
 * rules plus examples, never a per-customer fine-tune — is stated on the page.
 */

export const dynamic = "force-dynamic";

export default async function VoicePage() {
  const ctx = await requireTenant();
  const initials = await avatarInitials();
  const database = db();
  const business = await getClient();
  /*
   * Activating a voice is an admin action.
   *
   * The API requires `admin` (api/voice/[id]/activate), and this page showed
   * the button to everyone — so an editor saw a prominent "Action needed"
   * call to action, clicked it, and was told they lacked the role. Offering a
   * control and then refusing it is worse than not offering it.
   */
  const canActivate = ctx.role === "owner" || ctx.role === "admin";

  if (!business) {
    return (
      <>
        <div className="pagehead"><h1>Brand Voice</h1></div>
        <div className="empty">
          <span className="empty-ico"><IconVoiceNav size={22} /></span>
          <strong>No business yet</strong>
          <span>Voice is learned from a business&rsquo;s published copy. Add one first.</span>
        </div>
      </>
    );
  }

  const voices = await database
    .select().from(brandVoices)
    .where(and(eq(brandVoices.workspaceId, ctx.workspaceId), eq(brandVoices.businessId, business.id)))
    .orderBy(desc(brandVoices.version));

  const active = voices.find((v) => v.isActive);
  const latest = voices[0];

  return (
    <>
      <TopBar section="Create" page="Brand Voice" initials={initials} />
      <div className="content">
      <div className="pagehead">
        <div className="titlerow">
          <h1>Brand Voice</h1>
          <span className={`badge ${active ? "ok" : "warn"}`}>
            {active ? `v${active.version} active` : "None active"}
          </span>
        </div>
        <p>Learned from {business.name}&rsquo;s own writing. Applied to every article, post and reply.</p>
      </div>

      {voices.length === 0 ? (
        <div className="empty">
          <span className="empty-ico"><IconVoiceNav size={22} /></span>
          <strong>No voice profile yet</strong>
          <span>One is created automatically once the website crawl finishes.</span>
        </div>
      ) : (
        <>
          {!active && latest ? (
            <div className="hero" style={{ marginBottom: 24 }}>
              <span className="hero-ico"><IconVoiceNav size={19} /></span>
              <div className="hero-copy">
                <span className="eyebrow">Action needed</span>
                <strong>No voice is active</strong>
                <span className="desc">Generation is using a neutral fallback register until you activate one.</span>
              </div>
              <div style={{ marginLeft: "auto" }}>
                {canActivate ? <ActivateVoice voiceId={latest.id} version={latest.version} /> : null}
              </div>
            </div>
          ) : null}

          {voices.map((v) => (
            <div key={v.id} style={{ marginBottom: 24 }}>
              <div className="sectionhead">
                <h2>Version {v.version}</h2>
                {v.approvedAt ? (
                  <span className="note">Approved {v.approvedAt.toISOString().slice(0, 10)}</span>
                ) : <span className="note">Draft</span>}
                <div className="spacer" />
                {v.isActive ? (
                  <span className="badge ok">active</span>
                ) : canActivate ? (
                  <ActivateVoice voiceId={v.id} version={v.version} />
                ) : null}
              </div>

              <div className="specs" style={{ marginBottom: 14 }}>
                <div className="spec"><span className="k">Tone</span><span className="v">{v.profile.tone.join(", ")}</span></div>
                <div className="spec"><span className="k">Formality</span><span className="v">{v.profile.formality}</span></div>
                <div className="spec"><span className="k">Sentences</span><span className="v">{v.profile.sentenceStyle.replace(/-/g, " ")}</span></div>
                <div className="spec"><span className="k">Point of view</span><span className="v">{v.profile.pointOfView.replace(/-/g, " ")}</span></div>
                <div className="spec"><span className="k">Register</span><span className="v">{v.profile.emotionalStyle}</span></div>
                <div className="spec"><span className="k">CTA style</span><span className="v">{v.profile.ctaStyle.replace(/-/g, " ")}</span></div>
                <div className="spec"><span className="k">Spelling</span><span className="v">{v.profile.spelling}</span></div>
                <div className="spec"><span className="k">Avg sentence</span><span className="v">{v.profile.formattingHabits.avgSentenceWords} words</span></div>
              </div>

              <div className="grid cols-2">
                {v.preferredTerms.length > 0 ? (
                  <div className="card">
                    <h3>Preferred vocabulary</h3>
                    <p className="small muted" style={{ marginBottom: 10 }}>The brand&rsquo;s own words, taken from its copy.</p>
                    <div className="chips">
                      {v.preferredTerms.map((t, i) => (
                        <span className="chip accent" key={i}>
                          <b>{t.use}</b>{t.insteadOf ? ` not “${t.insteadOf}”` : ""}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}

                {v.bannedTerms.length > 0 ? (
                  <div className="card">
                    <h3>Never use</h3>
                    <p className="small muted" style={{ marginBottom: 10 }}>
                      The brand gate fails any draft containing these.
                    </p>
                    <div className="chips">
                      {v.bannedTerms.map((t) => <span className="chip danger" key={t}>{t}</span>)}
                    </div>
                  </div>
                ) : null}
              </div>

              {v.samples.length > 0 ? (
                <div className="card" style={{ marginTop: 16 }}>
                  <h3>Approved samples</h3>
                  <p className="small muted" style={{ marginBottom: 10 }}>
                    {v.samples.length} passage{v.samples.length === 1 ? "" : "s"} the model matches for rhythm and register — never for content.
                  </p>
                  {v.samples.slice(0, 2).map((sample, i) => (
                    <div className="finding info" key={i}>
                      <div style={{ fontStyle: "italic" }}>“{sample.text.slice(0, 260)}{sample.text.length > 260 ? "…" : ""}”</div>
                      {sample.sourceUrl ? <div className="evidence">{sample.sourceUrl}</div> : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </>
      )}

      <div className="card">
        <h3>How voice is stored</h3>
        <p className="muted small" style={{ margin: 0 }}>
          Structured rules plus a handful of approved samples, retrieved at generation time from the
          knowledge base. No model is fine-tuned per customer (spec §18.8). Style never overrides
          evidence: if a rule would require an unsupported claim, the evidence wins.
        </p>
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
