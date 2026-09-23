import type { WorkspaceSettings } from "@ob/db";

/**
 * Onboarding flow definition — spec §2.2.
 *
 * The spec's rules, encoded here rather than scattered through the screens:
 *  - "Ask only questions needed by the selected module" → `requiredFor`
 *  - "Keep optional attribution questions skippable"     → `skippable`
 *  - "Show progress and remaining steps"                 → `stepsRemaining`
 *
 * Because later steps depend on earlier answers, the step list is computed from
 * the answers so far rather than being a fixed array.
 */

export type Goal = "articles" | "local" | "social";

export type StepId =
  | "discovery" | "goals" | "source" | "detecting" | "confirm" | "colors" | "pillars";

export interface StepDef {
  id: StepId;
  /** Group shown in the progress bar. */
  group: "About you" | "Your business" | "Your setup";
  label: string;
  skippable: boolean;
  /** Only asked when one of these goals was chosen. Undefined = always asked. */
  requiredFor?: Goal[];
}

export const STEPS: StepDef[] = [
  { id: "discovery", group: "About you", label: "How you found us", skippable: true },
  { id: "goals", group: "Your business", label: "What you want", skippable: false },
  { id: "source", group: "Your business", label: "Where we learn", skippable: false },
  { id: "detecting", group: "Your business", label: "Reading your site", skippable: false },
  // Spec §3.1: the profile must be confirmed before anything is generated.
  { id: "confirm", group: "Your business", label: "Confirm what we found", skippable: false },
  { id: "colors", group: "Your setup", label: "Brand colours", skippable: true },
  { id: "pillars", group: "Your setup", label: "Themes and voice", skippable: false },
];

export interface OnboardingState {
  brandColors?: { hex: string; role: string }[];
  contentPillars?: string[];
  tone?: string;
  platforms?: string[];
  sourceMode?: "website" | "manual";
  sourceUrl?: string;
  manual?: { name: string; offer: string; audience: string; serviceArea: string };
  heardFrom?: string;
  goals: Goal[];
  completedSteps: StepId[];
}

export function readState(settings: WorkspaceSettings | undefined): OnboardingState {
  const o = settings?.onboarding;
  return {
    brandColors: o?.brandColors ?? [],
    contentPillars: o?.contentPillars ?? [],
    tone: o?.tone ?? "professional",
    platforms: o?.platforms ?? [],
    sourceMode: o?.sourceMode ?? "website",
    sourceUrl: o?.sourceUrl ?? "",
    manual: o?.manual ?? { name: "", offer: "", audience: "", serviceArea: "" },
    ...(o?.heardFrom ? { heardFrom: o.heardFrom } : {}),
    goals: (o?.goals ?? []) as Goal[],
    completedSteps: (o?.completedSteps ?? []) as StepId[],
  };
}

/** The steps this customer will actually see, given what they have chosen. */
export function applicableSteps(goals: Goal[]): StepDef[] {
  return STEPS.filter((s) => !s.requiredFor || s.requiredFor.some((g) => goals.includes(g)));
}

/** Spec §2.2 "Show progress and remaining steps". */
export function stepsRemaining(current: StepId, goals: Goal[]): number {
  const steps = applicableSteps(goals);
  const idx = steps.findIndex((s) => s.id === current);
  return idx === -1 ? 0 : Math.max(0, steps.length - idx - 1);
}

export function nextStep(current: StepId, goals: Goal[]): StepId | null {
  const steps = applicableSteps(goals);
  const idx = steps.findIndex((s) => s.id === current);
  return idx === -1 || idx === steps.length - 1 ? null : steps[idx + 1]!.id;
}

export function previousStep(current: StepId, goals: Goal[]): StepId | null {
  const steps = applicableSteps(goals);
  const idx = steps.findIndex((s) => s.id === current);
  return idx <= 0 ? null : steps[idx - 1]!.id;
}

/** Where to resume — spec §2.2 "Refresh/back does not lose progress". */
export function resumeAt(state: OnboardingState): StepId {
  const steps = applicableSteps(state.goals);
  const firstIncomplete = steps.find((s) => !state.completedSteps.includes(s.id));
  return firstIncomplete?.id ?? "pillars";
}

// ─── Step content ───────────────────────────────────────────────────────────

export const HEARD_FROM = [
  { id: "friends", label: "Friends or colleagues", icon: "◍" },
  { id: "podcast", label: "Podcast", icon: "◉" },
  { id: "news", label: "In the news", icon: "▤" },
  { id: "work", label: "From work", icon: "▣" },
  { id: "newsletter", label: "Newsletter or blog", icon: "✎" },
  { id: "ai", label: "ChatGPT, Claude, etc.", icon: "✦" },
  { id: "x", label: "X (Twitter)", icon: "✕" },
  { id: "google", label: "Google search", icon: "◎" },
  { id: "linkedin", label: "LinkedIn", icon: "in" },
  { id: "facebook", label: "Facebook", icon: "f" },
  { id: "instagram", label: "Instagram", icon: "◧" },
  { id: "youtube", label: "YouTube", icon: "▶" },
  { id: "other", label: "Somewhere else", icon: "⋯" },
];

export const GOALS: { id: Goal; title: string; desc: string; status: "ready" | "partial" }[] = [
  {
    id: "articles",
    title: "Blog content & SEO",
    desc: "Research keywords and draft SEO-friendly articles from your website.",
    status: "ready",
  },
  {
    id: "local",
    title: "Google Business Profile (GMB)",
    desc: "Draft and manage posts, read reviews, and reply in your brand voice.",
    status: "partial",
  },
  {
    id: "social",
    title: "Social media",
    desc: "Generate and schedule posts for Facebook, Instagram, LinkedIn, X, and more.",
    status: "partial",
  },
];

/**
 * The one thing standing between this workspace and published content.
 *
 * A dashboard that lists everything a person could do tells them nothing about
 * what to do now. This picks the single next step, in the order the pipeline
 * actually requires: there is no point suggesting a draft be approved when the
 * business profile has never been confirmed, because the draft would be built
 * on facts nobody checked.
 *
 * Ordered by dependency, not by importance. The first unmet condition wins.
 */
export interface NextAction {
  title: string;
  description: string;
  label: string;
  href: string;
}

export function deriveNextAction(state: {
  hasBusiness: boolean;
  crawlStatus: string | null;
  confirmed: boolean;
  awaitingApproval: number;
  totalArticles: number;
}): NextAction {
  if (!state.hasBusiness) {
    return {
      title: "Add your website",
      description: "Everything else is built from what your site already says about you.",
      label: "Add a website",
      href: "/onboarding",
    };
  }

  if (state.crawlStatus === "running" || state.crawlStatus === "pending") {
    return {
      title: "Reading your website",
      description: "This takes a few minutes. Your business profile appears when it finishes.",
      label: "See progress",
      href: "/business",
    };
  }

  if (state.crawlStatus === "failed" || state.crawlStatus === "blocked") {
    return {
      title: "The crawl could not finish",
      description: "Add your business details by hand instead, or try the crawl again.",
      label: "Fix it",
      href: "/settings/business",
    };
  }

  if (!state.confirmed) {
    return {
      title: "Confirm your business profile",
      description: "Check what we read from your site. Everything generated is built on it.",
      label: "Review the profile",
      href: "/settings/business",
    };
  }

  /*
   * Approvals come before new work.
   *
   * A queue of unreviewed drafts is a workspace spending money faster than it
   * publishes, and suggesting more generation would make that worse.
   */
  if (state.awaitingApproval > 0) {
    return {
      title: `${state.awaitingApproval} draft${state.awaitingApproval === 1 ? "" : "s"} waiting on you`,
      description: "Nothing publishes until a person approves it.",
      label: "Review drafts",
      href: "/articles?status=awaiting_approval",
    };
  }

  if (state.totalArticles === 0) {
    return {
      title: "Write your first article",
      description: "Suggest topics from your services, pick one, and review the draft.",
      label: "Suggest topics",
      href: "/articles",
    };
  }

  return {
    title: "Everything is up to date",
    description: "Generate more topics, or plan next month's social calendar.",
    label: "Open Blog Automation",
    href: "/articles",
  };
}
