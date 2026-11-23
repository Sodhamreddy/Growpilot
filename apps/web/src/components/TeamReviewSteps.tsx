import { publishers, shortDate, waitingFor, type TeamKey, type TeamReviewView } from "@/lib/team-review-view";
import styles from "./TeamReviewSteps.module.css";

type StepState = "done" | "current" | "changes" | "upcoming";

/**
 * The three levels of the team review in one compact row, with who signed
 * each off and who the article is waiting for. Sits above the decision buttons
 * in the review panel; the hint above it carries the full sentence.
 */
export function TeamReviewSteps({ team }: { team: TeamReviewView }) {
  const { stage } = team;
  const afterManager = stage === "publish" || stage === "sent" || stage === "live";
  type Step = { state: StepState; detail: string; full: string };
  const current = (can: boolean, key: TeamKey): Step => {
    const text = can ? "Your turn" : `Waiting for ${waitingFor(team, key)}`;
    return { state: "current", detail: text, full: text };
  };
  const done = (by: TeamReviewView["contentBy"]): Step => by
    ? { state: "done", detail: by.name, full: `Approved by ${by.name} on ${shortDate(by.at)}` }
    : { state: "done", detail: "Approved", full: "Approved" };
  const upcoming = (key: TeamKey, label: string): Step => ({ state: "upcoming", detail: waitingFor(team, key), full: `${label}: ${waitingFor(team, key)}` });

  const content: Step = stage === "revision"
    ? { state: "changes", detail: "Sent back", full: team.changes ? `Sent back by ${team.changes.name} on ${shortDate(team.changes.at)}` : "Sent back for changes" }
    : stage === "content" ? current(team.can.content, "content")
      : team.contentBy || stage === "manager" || afterManager ? done(team.contentBy)
        : upcoming("content", "Content team");
  const manager: Step = stage === "manager" ? current(team.can.manager, "manager")
    : afterManager ? done(team.managerBy)
      : upcoming("manager", "Managers");
  // Publishing belongs to both teams: whoever is free sends the approved article.
  const publishText = team.can.publish ? "Your turn" : `Waiting for ${publishers(team)}`;
  const publish: Step = stage === "publish" ? { state: "current", detail: publishText, full: publishText }
    : stage === "sent" ? { state: "done", detail: "In WordPress", full: "Draft created in WordPress" }
      : stage === "live" ? { state: "done", detail: "Published", full: "Published" }
        : { state: "upcoming", detail: "Content or Manager", full: "Anyone on the Content team or a Manager can publish" };
  const steps: (Step & { key: string; title: string })[] = [
    { key: "content", title: "Content", ...content },
    { key: "manager", title: "Manager", ...manager },
    { key: "publish", title: "Publish", ...publish },
  ];

  return <section className={styles.steps} aria-label="Team review">
    <span className={styles.label}>Team review</span>
    <ol>{steps.map((step, index) => <li key={step.key} data-state={step.state} title={step.full}
      aria-current={step.state === "current" || step.state === "changes" ? "step" : undefined}>
      <span className={styles.marker} aria-hidden="true">{step.state === "done" ? "✓" : step.state === "changes" ? "!" : index + 1}</span>
      <strong>{step.title}</strong>
      <small>{step.detail}<span className={styles.srOnly}>. {step.full}</span></small>
    </li>)}</ol>
    {stage === "revision" && team.changes ? <p className={styles.changes}>
      <b>Sent back by {team.changes.name} · {shortDate(team.changes.at)}</b>
      {team.changes.note ? <q>{team.changes.note}</q> : null}
    </p> : null}
  </section>;
}
