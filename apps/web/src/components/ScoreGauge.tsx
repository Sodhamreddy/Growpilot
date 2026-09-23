import type { ScoreComponent } from "@ob/db";

/**
 * Explainable score display — spec §7.1.
 *
 * The ring gives the headline number at a glance; the component bars beside it
 * give the reasoning. The spec requires the score to be explainable, so the
 * breakdown is not hidden behind an interaction.
 */

const CIRCUMFERENCE = 2 * Math.PI * 52;

export function tone(score: number): "ok" | "warn" | "fail" {
  return score >= 75 ? "ok" : score >= 50 ? "warn" : "fail";
}

export function ScoreGauge({
  score,
  label = "SEO score",
  components,
}: {
  score: number;
  label?: string;
  components?: ScoreComponent[];
}) {
  const clamped = Math.max(0, Math.min(100, score));
  const offset = CIRCUMFERENCE - (clamped / 100) * CIRCUMFERENCE;

  return (
    <div className="scorepanel">
      <div className="gauge">
        <svg viewBox="0 0 120 120" role="img" aria-label={`${label}: ${clamped.toFixed(1)} out of 100`}>
          <circle className="track" cx="60" cy="60" r="52" fill="none" strokeWidth="10" />
          <circle
            className={`fill ${tone(clamped)}`}
            cx="60" cy="60" r="52" fill="none" strokeWidth="10"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={offset}
          />
        </svg>
        <div className="readout">
          <b>{clamped.toFixed(0)}</b>
          <span>{label}</span>
        </div>
      </div>

      {components?.length ? (
        <div className="components">
          {components.map((c) => (
            <div className="component" key={c.key}>
              <span className="cname">{c.label}</span>
              <span className="cweight">{c.weight}% weight</span>
              <div className="bar">
                <i className={tone(c.score)} style={{ width: `${Math.max(c.score, 1)}%` }} />
              </div>
              <span className="cscore">{c.score.toFixed(0)}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
