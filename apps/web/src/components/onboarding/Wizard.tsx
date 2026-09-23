"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  HEARD_FROM, GOALS, applicableSteps, stepsRemaining, nextStep, previousStep,
  type Goal, type StepId, type OnboardingState,
} from "@/lib/onboarding";
import { onboardingRequest } from "@/lib/onboarding-request";
import { Logo } from "@/components/Logo";
import { ConfirmStep } from "./ConfirmStep";
import { ColorsStep, PillarsStep, type BrandColor } from "./SetupSteps";

/**
 * Onboarding wizard — spec §2.2.
 *
 * One client component drives every step so moving between them is instant and
 * nothing is lost on a back-navigation. Each completed step is POSTed to
 * /api/onboarding/step immediately ("autosave every completed step"), so a
 * refresh resumes from the server's record rather than from memory.
 */

export function Wizard({ initial }: { initial: OnboardingState & { startAt: StepId } }) {
  const router = useRouter();
  const [step, setStep] = useState<StepId>(initial.startAt);
  const [heardFrom, setHeardFrom] = useState<string | undefined>(initial.heardFrom);
  const [goals, setGoals] = useState<Goal[]>(initial.goals);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [sourceMode, setSourceMode] = useState<"website" | "manual">(initial.sourceMode ?? "website");
  const [url, setUrl] = useState(initial.sourceUrl ?? "");
  const [manual, setManual] = useState(initial.manual ?? { name: "", offer: "", audience: "", serviceArea: "" });
  const [brandColors, setBrandColors] = useState<BrandColor[]>(initial.brandColors ?? []);
  const [brandLogo, setBrandLogo] = useState<string | null>(null);
  const [pillars, setPillars] = useState<string[]>(initial.contentPillars ?? []);
  const [tone, setTone] = useState(initial.tone ?? "professional");
  const [platforms, setPlatforms] = useState<string[]>(initial.platforms ?? []);

  const steps = useMemo(() => applicableSteps(goals), [goals]);
  const remaining = stepsRemaining(step, goals);
  const handleDetected = useCallback(() => setStep("confirm"), []);

  const save = useCallback(
    async (payload: Record<string, unknown>) => {
      await onboardingRequest("/api/onboarding/step", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    },
    [],
  );

  async function advance(payload: Record<string, unknown>) {
    setError(null);
    const from = step;
    const nextGoals = payload["goals"] ? (payload["goals"] as Goal[]) : goals;
    const to = nextStep(from, nextGoals);
    if (to) setStep(to);
    try {
      await save({ step: from, ...payload });
    } catch (e) {
      setStep(from);
      setError(e instanceof Error ? e.message : "Something went wrong.");
    }
  }

  /** Last step: save, mark onboarding complete, and hand over to the dashboard. */
  async function finish() {
    setBusy(true);
    setError(null);
    try {
      await save({ step: "pillars", contentPillars: pillars, tone, platforms });
      await onboardingRequest("/api/onboarding/step", { method: "PUT" });
      router.replace("/home");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  function goBack() {
    const to = previousStep(step, goals);
    if (to) { setError(null); setStep(to === "detecting" ? "source" : to); }
  }

  async function submitSource() {
    setError(null);
    const destination = sourceMode === "manual" ? "confirm" : "detecting";
    setBusy(true);
    try {
      const payload =
        sourceMode === "website"
          ? { source: "website", url: url.trim() }
          : {
              source: "manual",
              name: manual.name,
              offer: manual.offer,
              audience: manual.audience,
              serviceArea: manual.serviceArea || undefined,
            };

      await onboardingRequest("/api/onboarding/business-source", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      // Do not mount the progress poll until the source row and crawl job both
      // exist. Previously the GET could win this race and report that no
      // website was queued even though the POST was still saving it.
      setStep(destination);
    } catch (e) {
      setStep("source");
      setError(e instanceof Error ? e.message : "Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`ob ob-step-${step}`}>
      <header className="ob-head">
        <span className="mark">
          <Logo size={24} />
          GrowPilot <em>Studio</em>
        </span>
        <ProgressBar steps={steps} current={step} />
        <span className="ob-account"><b>A</b><span>Your workspace</span></span>
        {/* Onboarding had no exit: /signin redirects a signed-in user straight
            back here, so without this the only way out was clearing cookies. */}
        <button
          type="button"
          className="ob-signout"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await fetch("/api/auth/signout", {
                method: "POST",
                signal: AbortSignal.timeout(5_000),
              });
            } catch {
              // Navigation still gives the user a clean retry path.
            }
            window.location.replace("/signin");
          }}
        >
          {busy ? "Signing out…" : "Sign out"}
        </button>
      </header>

      {step === "discovery" ? (
        <StepShell
          eyebrow="01 — About you"
          title="How did you hear about us?"
          lede="One tap, and it tells us which channels bring the people who stay. Skip it if you would rather get going."
        >
          <div className="ob-grid">
            {HEARD_FROM.map((h) => (
              <button
                key={h.id}
                type="button"
                className="ob-choice"
                aria-pressed={heardFrom === h.id}
                onClick={() => setHeardFrom(heardFrom === h.id ? undefined : h.id)}
              >
                <DiscoveryIcon id={h.id} fallback={h.icon} />
                <span className="cl">{h.label}</span>
              </button>
            ))}
          </div>
        </StepShell>
      ) : null}

      {step === "goals" ? (
        <StepShell
          eyebrow="02 — Your setup"
          title="What would you like to set up first?"
          lede="You can always change these later in Settings. Choose what you want GrowPilot to help with right now."
        >
          <div className="ob-options">
            {GOALS.map((g) => {
              const on = goals.includes(g.id);
              return (
                <button
                  key={g.id}
                  type="button"
                  className="ob-option"
                  aria-pressed={on}
                  onClick={() =>
                    setGoals(on ? goals.filter((x) => x !== g.id) : [...goals, g.id])
                  }
                >
                  <span className="ob-box">✓</span>
                  <GoalIcon goal={g.id} />
                  <span className="ot">
                    <strong>{g.title}</strong>
                    <span>{g.desc}</span>
                    {g.id === "articles" ? <span className="otag">Recommended</span> : null}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="ob-note">
            <div className="nt">You can select more than one</div>
            <p>
              {goals.length === 0
                ? "Pick at least one. We will guide you through the setup step by step."
                : `${goals.length} selected. We will tailor the next steps to these choices.`}
            </p>
          </div>
        </StepShell>
      ) : null}

      {step === "source" ? (
        <StepShell
          eyebrow="03 — Your business"
          title="Where should we learn about your business?"
          lede="One source is all we need. We’ll use it to fill in everything you would otherwise have to type."
        >
          <div className="ob-options">
            <div
              className="ob-option"
              role="radio"
              aria-checked={sourceMode === "website"}
              tabIndex={0}
              onClick={() => setSourceMode("website")}
              onKeyDown={(e) => e.key === "Enter" && setSourceMode("website")}
            >
              <span className="ob-box round">✓</span>
              <span className="ot">
                <strong>Use my website</strong>
                <span>We read your public pages and build the profile from them.</span>
                <span className="otag source-recommended">Recommended</span>
              </span>
              <div className="ob-nested" onClick={(e) => e.stopPropagation()}>
                    <label className="fieldlabel" htmlFor="onboarding-website">Website URL</label>
                    <div className="source-field"><span aria-hidden="true">↗</span><input
                        id="onboarding-website"
                        type="url"
                        aria-label="Website address"
                        placeholder="https://yourbusiness.com"
                        value={url}
                        onChange={(e) => setUrl(e.target.value)}
                      /></div>
                    <div className="source-checks">
                      <span>We&rsquo;ll read your public pages (no login needed)</span>
                      <span>Extract key information about your services</span>
                      <span>Fill locations, services and brand details automatically</span>
                    </div>
              </div>
            </div>

            <div
              className="ob-option"
              role="radio"
              aria-checked={sourceMode === "manual"}
              tabIndex={0}
              onClick={() => setSourceMode("manual")}
              onKeyDown={(e) => e.key === "Enter" && setSourceMode("manual")}
            >
              <span className="ob-box round">✓</span>
              <span className="ot">
                <strong>I&rsquo;ll describe it myself</strong>
                <span>Answer a few quick questions. No website needed.</span>
              </span>
              <div className="ob-nested" onClick={(e) => e.stopPropagation()}>
                    <label className="fieldlabel" htmlFor="onboarding-business-name">Business name</label>
                    <div className="source-field"><span aria-hidden="true">▥</span><input
                        id="onboarding-business-name"
                        placeholder="e.g. Assured Home Nursing"
                        value={manual.name}
                        onChange={(e) => setManual({ ...manual, name: e.target.value })}
                      /></div>
                    <label className="fieldlabel" htmlFor="onboarding-offer">What do you sell or do?</label>
                    <div className="source-field source-field-area"><span aria-hidden="true">▤</span><textarea
                        id="onboarding-offer"
                        placeholder="In a sentence or two..."
                        rows={3}
                        value={manual.offer}
                        onChange={(e) => setManual({ ...manual, offer: e.target.value })}
                      /></div>
                    <label className="fieldlabel" htmlFor="onboarding-audience">Who is it for?</label>
                    <div className="source-field"><span aria-hidden="true">♙</span><input
                        id="onboarding-audience"
                        placeholder="e.g. Seniors, individuals, families..."
                        value={manual.audience}
                        onChange={(e) => setManual({ ...manual, audience: e.target.value })}
                      /></div>
                    <label className="fieldlabel" htmlFor="onboarding-service-area">Where do you serve customers?</label>
                    <div className="source-field"><span aria-hidden="true">⌾</span><input
                        id="onboarding-service-area"
                        placeholder="City, state, country or Everywhere"
                        value={manual.serviceArea}
                        onChange={(e) => setManual({ ...manual, serviceArea: e.target.value })}
                      /></div>
              </div>
            </div>
          </div>
        </StepShell>
      ) : null}

      {step === "detecting" ? (
        <Detecting onDone={handleDetected} onRestart={() => setStep("source")} />
      ) : null}

      {step === "confirm" ? <ConfirmStep onDone={() => setStep("colors")} onBack={() => setStep("source")} /> : null}

      {step === "colors" ? (
        <StepShell
          eyebrow="05 — Your setup"
          title="How should your content look?"
          lede="Choose your brand colours and logo. Adjust anything found on your website, or add your own."
        >
          <ColorsStep
            value={brandColors}
            onChange={setBrandColors}
            logoValue={brandLogo}
            onLogoChange={setBrandLogo}
          />
        </StepShell>
      ) : null}

      {step === "pillars" ? (
        <StepShell
          eyebrow="06 — Your setup"
          title="What should we write about?"
          lede="The last thing to pick. Choose the themes, and we build the first plan from everything you just confirmed."
        >
          <PillarsStep
            pillars={pillars} tone={tone} platforms={platforms}
            onPillars={setPillars} onTone={setTone} onPlatforms={setPlatforms}
            showPlatforms={goals.includes("social")}
          />
        </StepShell>
      ) : null}

      {step !== "detecting" && step !== "confirm" ? (
        <footer className="ob-foot">
          {previousStep(step, goals) ? (
            <button type="button" className="back" onClick={goBack} disabled={busy}>
              <span aria-hidden="true">←</span> Back
            </button>
          ) : null}

          {step === "discovery" ? (
            <span className="ob-footnote">GrowPilot Studio <i /> Automate&nbsp;&nbsp; Grow&nbsp;&nbsp; Care</span>
          ) : (
            <span className="count">
              {remaining === 0 ? "Last step" : `${remaining} step${remaining === 1 ? "" : "s"} left`}
            </span>
          )}

          {step === "discovery" || step === "colors" ? (
            <button
              type="button"
              className="skip"
              disabled={busy}
              onClick={() => void advance(step === "discovery" ? { heardFrom: null, skipped: true } : { skipped: true })}
            >
              Skip
            </button>
          ) : null}

          {error ? <span role="alert" className="error">{error}</span> : null}

          <button
            type="button"
            className="btn primary"
            disabled={
              busy ||
              (step === "goals" && goals.length === 0) ||
              (step === "source" && (sourceMode === "website" ? !url.trim() : !manual.name.trim() || !manual.offer.trim() || !manual.audience.trim())) ||
              (step === "pillars" && pillars.length < 2)
            }
            onClick={() => {
              if (step === "discovery") void advance({ heardFrom: heardFrom ?? null });
              else if (step === "goals") void advance({ goals });
              else if (step === "source") void submitSource();
              else if (step === "colors") void advance({
                brandColors,
                ...(brandLogo ? { logoUrl: brandLogo } : {}),
              });
              else if (step === "pillars") void finish();
            }}
          >
            {busy ? "Working…" : step === "pillars" ? "Build my plan →" : "Continue →"}
          </button>
        </footer>
      ) : null}
    </div>
  );
}

function StepShell({
  eyebrow, title, lede, children,
}: {
  eyebrow: string; title: string; lede: string; children: React.ReactNode;
}) {
  return (
    <div className="ob-body">
      <div className="ob-ask">
        <div className="ob-eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{lede}</p>
        {eyebrow.startsWith("01") ? <div className="ob-support"><span>♙</span><div><strong>You’re on a trial plan</strong><small>We’ll tailor your setup based on your answer.</small></div></div> : null}
        {eyebrow.includes("Your business") ? <div className="ob-benefits"><span><BenefitIcon name="lightning" /><b>Quick setup</b><small>Get started in minutes.</small></span><span><BenefitIcon name="document" /><b>Accurate content</b><small>We use real information from your business.</small></span><span><BenefitIcon name="shield" /><b>You’re in control</b><small>You can change these later in Settings.</small></span></div> : null}
        {eyebrow.includes("Your setup") ? <div className="ob-benefits"><span><BenefitIcon name="calendar" /><b>Set it up once</b><small>We’ll handle the rest.</small></span><span><BenefitIcon name="clock" /><b>Save time</b><small>Automate your content and engagement.</small></span><span><BenefitIcon name="growth" /><b>Grow with confidence</b><small>Get measurable results.</small></span></div> : null}
      </div>
      <div>{children}</div>
    </div>
  );
}

function GoalIcon({ goal }: { goal: Goal }) {
  if (goal === "articles") return <span className="goal-icon goal-icon-articles" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M7 3.75h7l3 3V20.25H7z"/><path d="M14 3.75v3h3M9.75 11h4.5M9.75 14h4.5M9.75 17h3"/></svg></span>;
  if (goal === "local") return <span className="goal-icon goal-icon-local" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 20s5.25-5.2 5.25-10A5.25 5.25 0 0 0 6.75 10C6.75 14.8 12 20 12 20Z"/><circle cx="12" cy="10" r="1.8"/></svg></span>;
  return <span className="goal-icon goal-icon-social" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="7" cy="12" r="2"/><circle cx="16.5" cy="7" r="2"/><circle cx="16.5" cy="17" r="2"/><path d="m8.8 11.1 5.9-3.1M8.8 12.9l5.9 3.1"/></svg></span>;
}

function BenefitIcon({ name }: { name: "calendar" | "clock" | "growth" | "lightning" | "document" | "shield" }) {
  return <i className={`benefit-icon benefit-icon-${name}`} aria-hidden="true" />;
}

function DiscoveryIcon({ id, fallback }: { id: string; fallback: string }) {
  const labels: Record<string, string> = {
    friends: "●", podcast: "◉", news: "▤", work: "▣", newsletter: "▧",
    ai: "✦", x: "𝕏", google: "G", linkedin: "in", facebook: "f",
    instagram: "◎", youtube: "▶", other: "•••",
  };
  return <span className={`ci ci-${id}`} aria-hidden="true">{labels[id] ?? fallback}</span>;
}

function ProgressBar({ steps, current }: { steps: { id: StepId; group: string }[]; current: StepId }) {
  const groups = ["About you", "Your business", "Your setup"];
  const currentIdx = steps.findIndex((s) => s.id === current);
  const currentGroup = steps[currentIdx]?.group;

  return (
    <div className="ob-progress">
      {groups.map((g) => {
        const inGroup = steps.filter((s) => s.group === g);
        if (inGroup.length === 0) return null;
        const groupStart = steps.findIndex((s) => s.group === g);
        const done = currentIdx > groupStart + inGroup.length - 1;
        const active = currentGroup === g;
        return (
          <div key={g} className={`ob-group ${active ? "active" : done ? "done" : ""}`}>
            {g}
            {done ? (
              <span className="tick">✓</span>
            ) : (
              <span className="ob-dots">
                {inGroup.map((s) => (
                  <i key={s.id} className={steps.indexOf(s) <= currentIdx ? "on" : ""} />
                ))}
              </span>
            )}
            {active && current === "detecting" ? <span className="working">Working</span> : null}
          </div>
        );
      })}
    </div>
  );
}

/** Live crawl progress — polls the real source record (spec §3.1). */
function Detecting({ onDone, onRestart }: { onDone: () => void; onRestart: () => void }) {
  const [state, setState] = useState<{
    status: string; fetched: number; discovered: number; error: string | null; url: string;
  } | null>(null);
  // A crawl that sits at "pending" is almost always a worker that is not
  // running. Polling forever with no explanation is the worst possible UX, so
  // after a while the screen says what is probably wrong.
  const [waitedSeconds, setWaitedSeconds] = useState(0);
  const [pollError, setPollError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let polling = false;
    let finished = false;
    const tick = async () => {
      if (polling || finished) return;
      polling = true;
      try {
        const res = await fetch("/api/onboarding/business-source", { signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error("Unable to check progress. Retrying…");
        const body = (await res.json()) as {
          sources: {
            status: string; pagesFetched: number; pagesDiscovered: number;
            lastError: string | null; url: string;
          }[];
        };
        const s = body.sources[0];
        if (!alive) return;
        if (!s) throw new Error("No website is queued. Go back to choose a source.");
        setPollError(null);
        setState({
          status: s.status, fetched: s.pagesFetched, discovered: s.pagesDiscovered,
          error: s.lastError, url: s.url,
        });
        if (s.status === "succeeded") {
          await onboardingRequest("/api/onboarding/step", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ step: "detecting" }),
          });
          finished = true;
          if (alive) onDone();
        }
      } catch (e) {
        if (alive) setPollError(e instanceof Error ? e.message : "Connection interrupted. Retrying…");
      } finally { polling = false; }
    };
    void tick();
    // 5s rather than 3s. The worker is doing real work between polls — a
    // crawl, an extraction — and a tighter loop buys no responsiveness while
    // adding round trips to a database that is now a network hop away.
    const id = setInterval(() => void tick(), 5000);
    const clock = setInterval(() => setWaitedSeconds((n) => n + 1), 1000);
    return () => { alive = false; clearInterval(id); clearInterval(clock); };
  }, [onDone]);

  const status = state?.status ?? "pending";
  const failed = status === "failed" || status === "blocked";
  // Nothing has even started after a minute: the queue is not being drained.
  const stalled = !failed && (waitedSeconds > 180 || (status === "pending" && waitedSeconds > 60));
  const host = state?.url ? new URL(state.url).hostname : "your website";

  // Three visible phases mapped to the real job chain.
  const phases = [
    { key: "crawl", title: "Reading your website", desc: "Fetching public pages and parsing them.",
      done: (state?.fetched ?? 0) > 0, active: !failed && (state?.fetched ?? 0) === 0 },
    { key: "extract", title: "Understanding your business",
      desc: "Working out what you offer and who you serve.",
      done: status === "succeeded", active: !failed && status === "running" && (state?.fetched ?? 0) > 0 },
    { key: "review", title: "Preparing your review",
      desc: "Organising every fact with the page it came from.",
      done: false, active: status === "succeeded" },
  ];

  const pct = status === "succeeded" ? 100
    : state && state.discovered > 0 ? Math.min(90, Math.round((state.fetched / state.discovered) * 90))
    : 10;

  return (
    <div className="ob-body">
      <div className="ob-ask">
        {/* "Working · nothing to do" was meant as "it is working, nothing for
            you to do" and read as a contradiction. A status label has to say
            one thing. */}
        <div className="ob-eyebrow">
          {failed ? "Could not read it" : stalled ? "Not started yet" : "Reading your site"}
        </div>
        <h1>
          {failed
            ? "We could not read that site"
            : stalled
              ? "This has not started"
              : `Reading ${host}`}
        </h1>
        <p>
          {failed
            ? state?.error ?? "Check the address, or go back and describe the business yourself."
            : stalled
              ? "Nothing has picked this up yet. The crawler runs in a separate process — if you " +
                "are running this locally, start it with `pnpm dev:worker`. Your progress is " +
                "saved either way, and you can describe the business manually instead."
              : "Usually under two minutes. Leave this open and we will move you on automatically."}
        </p>
      </div>

      <div>
        <div className="ob-steps">
          <div className="ob-bar">
            <div className="track"><i style={{ width: `${failed ? 100 : pct}%` }} /></div>
            <span className="pct">{failed ? "Stopped" : stalled ? "Waiting" : `${pct}%`}</span>
          </div>
          {phases.map((p) => (
            <div key={p.key} className={`ob-phase ${p.done ? "done" : p.active ? "active" : ""}`}>
              <span className="dot">{p.done ? "✓" : ""}</span>
              <span className="pt">
                <strong>{p.title}</strong>
                <span>{p.desc}</span>
              </span>
            </div>
          ))}
        </div>

        {pollError ? <p role="alert" className="error">{pollError}</p> : null}
        {failed || stalled || pollError ? (
          <div className="ob-note" style={{ marginTop: 16 }}>
            <div className="nt">What now</div>
            <p style={{ marginBottom: 12 }}>
              {stalled
                ? "We will keep checking. You can also use another website or enter your business details manually."
                : "Try a different address, or describe the business yourself — it takes about a minute."}
            </p>
            <button type="button" className="btn" onClick={onRestart}>
              ← Try a different source
            </button>
          </div>
        ) : (
          <div className="ob-tip">
            <div className="nt">While you wait</div>
            <p>Everything we find is editable, and shown with the page it came from.</p>
          </div>
        )}
      </div>
    </div>
  );
}
