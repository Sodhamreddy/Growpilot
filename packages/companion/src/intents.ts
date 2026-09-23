/**
 * What the companion is allowed to do, and which of those need asking first.
 *
 * The whole safety model is this table. Everything the companion can do is
 * declared here with a `confirm` flag, and the caller refuses anything not on
 * it: a model that invents an action name gets nothing, rather than something
 * approximately right.
 *
 * The split is not about how clever the action is, it is about what a mistake
 * costs. Navigating to the wrong page costs a click. Regenerating a category
 * spends money and replaces sixteen topics somebody may have been reading.
 * Those are different, and a companion that treated them the same would be
 * either annoying or dangerous depending on which way it erred.
 */

export type IntentName =
  | "navigate"
  | "filter"
  | "explain"
  | "generate_topics"
  | "generate_blog"
  | "revise_section"
  | "plan_month"
  | "none";

export interface IntentSpec {
  name: IntentName;
  /** Whether a person has to approve before it runs. */
  confirm: boolean;
  /** Shown in the confirmation. Says what will happen, and what it costs. */
  describe: (args: Record<string, unknown>) => string;
}

/**
 * Routes the companion can navigate to.
 *
 * An allowlist rather than free-form: a model asked for "the page about X"
 * will produce a plausible path, and a 404 from the companion is worse than a
 * refusal, because it looks like the feature is broken rather than absent.
 */
export const ROUTES: Record<string, { path: string; label: string }> = {
  home: { path: "/home", label: "Home" },
  blog: { path: "/articles", label: "Blog Automation" },
  social: { path: "/social", label: "Social Media Timeline" },
  reviews: { path: "/reviews", label: "GMB Reviews" },
  keywords: { path: "/keywords", label: "Keywords" },
  voice: { path: "/voice", label: "Brand Voice" },
  business: { path: "/business", label: "Business Intelligence" },
  businessInfo: { path: "/settings/business", label: "Business Info" },
  integrations: { path: "/integrations", label: "Integrations" },
  preferences: { path: "/preferences", label: "Preferences" },
};

export const INTENTS: Record<IntentName, IntentSpec> = {
  /* ── Reversible: done immediately ────────────────────────────────────── */

  navigate: {
    name: "navigate",
    confirm: false,
    describe: (a) => `Go to ${ROUTES[String(a["route"])]?.label ?? "a page"}`,
  },
  filter: {
    name: "filter",
    confirm: false,
    describe: (a) => `Filter by ${String(a["value"] ?? "")}`,
  },
  explain: {
    name: "explain",
    confirm: false,
    describe: () => "Answer a question",
  },
  none: {
    name: "none",
    confirm: false,
    describe: () => "Nothing to do",
  },

  /* ── Spends money or changes content: asked first ────────────────────── */

  generate_topics: {
    name: "generate_topics",
    confirm: true,
    describe: (a) =>
      `Generate topics for ${String(a["category"] ?? "a category")}. ` +
      `One model call against this workspace's budget.`,
  },
  generate_blog: {
    name: "generate_blog",
    confirm: true,
    describe: (a) =>
      `Write an article on "${String(a["title"] ?? "")}". ` +
      `Several model calls, a few minutes.`,
  },
  revise_section: {
    name: "revise_section",
    confirm: true,
    describe: (a) =>
      `Rewrite the ${String(a["section"] ?? "selected")} section. ` +
      `You will see the change before it is applied.`,
  },
  plan_month: {
    name: "plan_month",
    confirm: true,
    describe: (a) =>
      `Lay out ${String(a["month"] ?? "the month")} from the topic pool. ` +
      `No model call, but it schedules real posts.`,
  },
};

/** Whether a name the model returned is one we actually support. */
export function isKnownIntent(name: string): name is IntentName {
  return Object.hasOwn(INTENTS, name);
}
