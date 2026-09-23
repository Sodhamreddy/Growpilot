import type { TenantContext } from "@ob/core";
import type { Gateway } from "@ob/ai";
import { composeSystemPrompt, BASE_SYSTEM_RULES, BASE_SAFETY, PROMPT_VERSIONS } from "@ob/ai";
import { INTENTS, ROUTES, isKnownIntent, type IntentName } from "./intents.js";

/**
 * Turning what somebody typed into something the dashboard can do.
 *
 * The model chooses from a fixed list and fills in arguments; it never decides
 * what the list contains and never executes anything. Everything it returns
 * passes back through `INTENTS` before it reaches a caller, so an invented
 * action name or a route that does not exist becomes a refusal rather than a
 * 404 or, worse, an approximation of what was asked.
 *
 * It also answers questions. Most of what people ask a dashboard companion is
 * "where is X" or "why is this failing", and routing those to a page they then
 * have to read is worse than answering.
 */

export interface CompanionContext {
  /** Where the person is now, so "generate topics" means this category. */
  currentPath: string;
  /** The page's own state: selected category, open article, active filter. */
  pageState?: Record<string, string | number | null>;
  /** What exists to act on, so the model does not offer what is not there. */
  available?: {
    categories?: { id: string; name: string; filled: number; target: number }[];
    articleId?: string;
    articleSections?: { id: string; heading: string }[];
  };
}

export interface CompanionTurn {
  role: "user" | "assistant";
  content: string;
}

export interface Interpretation {
  intent: IntentName;
  args: Record<string, unknown>;
  /** What the companion says back. Always present, even when acting. */
  reply: string;
  /** True when a person must approve before this runs. */
  needsConfirmation: boolean;
  /** One line describing what would happen. Shown on the confirmation. */
  action: string | null;
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["intent", "reply", "route", "category", "section", "title", "month", "value"],
  properties: {
    intent: {
      type: "string",
      enum: Object.keys(INTENTS),
    },
    reply: { type: "string" },
    // Flat string arguments rather than a nested object: Gemini's schema
    // dialect has no union or oneOf, so one shape with empty slots survives
    // translation where a per-intent shape would not.
    route: { type: "string" },
    category: { type: "string" },
    section: { type: "string" },
    title: { type: "string" },
    month: { type: "string" },
    value: { type: "string" },
  },
} as const;

const RULES = `${BASE_SYSTEM_RULES}

You are the assistant inside an SEO and content automation dashboard. Somebody
types what they want and you choose ONE action from the list, or answer them.

WHAT YOU CAN DO
  navigate         Go to a page. Set "route" to one of the keys listed below.
  filter           Narrow what is on screen. Set "value".
  explain          Answer a question. Use this whenever nothing needs doing.
  generate_topics  Fill a social category with topics. Set "category".
  generate_blog    Write an article. Set "title".
  revise_section   Rewrite part of the open article. Set "section".
  plan_month       Build a month's calendar. Set "month" as YYYY-MM.
  none             Nothing to do, or you did not understand.

Leave every argument you are not using as an empty string.

CHOOSING
- Prefer "explain" over guessing. A wrong action costs somebody money or
  changes their content; a plain answer costs nothing.
- If the request is ambiguous, use "explain" and ask which one they meant.
  Do not pick the most likely and hope.
- Only reference categories, sections and pages that appear in the context
  below. If somebody asks for something that is not there, say so plainly.
- Never claim to have done something. The dashboard runs the action, not you,
  and some actions are refused after you choose them.

HOW YOU SOUND
Short. One or two sentences. You are a colleague who knows this product, not a
help system: say the thing, not a paragraph around it.

Never use an em dash or an en dash. Use a period, a comma or parentheses.`;

export async function interpret(
  gateway: Gateway,
  ctx: TenantContext,
  input: {
    message: string;
    context: CompanionContext;
    /** Recent turns, so "do that one instead" resolves. */
    history?: CompanionTurn[];
  },
): Promise<Interpretation> {
  const routeList = Object.entries(ROUTES)
    .map(([key, r]) => `  ${key.padEnd(14)} ${r.label}`)
    .join("\n");

  const cats = input.context.available?.categories ?? [];
  const catList = cats.length
    ? cats.map((c) => `  ${c.name} (${c.filled}/${c.target})`).join("\n")
    : "  none";

  const sections = input.context.available?.articleSections ?? [];
  const sectionList = sections.length
    ? sections.map((s) => `  ${s.heading || "(opening)"}`).join("\n")
    : "  no article open";

  const history = (input.history ?? [])
    .slice(-6)
    .map((t) => `${t.role === "user" ? "Them" : "You"}: ${t.content}`)
    .join("\n");

  const { system, cacheablePrefixLength } = composeSystemPrompt({
    systemRules: RULES,
    safety: BASE_SAFETY,
    businessFacts: [
      "PAGES",
      routeList,
      "",
      "SOCIAL CATEGORIES",
      catList,
      "",
      "SECTIONS OF THE OPEN ARTICLE",
      sectionList,
    ].join("\n"),
    task: [
      `They are on: ${input.context.currentPath}`,
      input.context.pageState
        ? `Page state: ${JSON.stringify(input.context.pageState)}`
        : "",
      history ? `\nRecent conversation:\n${history}` : "",
    ].filter(Boolean).join("\n"),
    outputFormat: "Return only JSON conforming to the schema. No prose, no code fences.",
  });

  const res = await gateway.generate(ctx, {
    taskAlias: "structured_json",
    system,
    cacheableSystemPrefixLength: cacheablePrefixLength,
    messages: [{ role: "user", content: input.message }],
    schema: SCHEMA as unknown as Record<string, unknown>,
    promptVersion: PROMPT_VERSIONS.businessExtraction,
  });

  return normalise(res.parsed, input.context);
}

/**
 * Check what came back before anybody acts on it.
 *
 * Three things are verified, and all three have been wrong in testing: the
 * action exists, its arguments point at something real, and the reply is not
 * empty. An unknown action degrades to `none` with the model's own words kept,
 * which reads as "I did not understand" rather than as a crash.
 */
function normalise(parsed: unknown, context: CompanionContext): Interpretation {
  const e = (parsed ?? {}) as Record<string, unknown>;
  const raw = String(e["intent"] ?? "none");
  const reply = stripDashes(String(e["reply"] ?? "").trim());

  let intent: IntentName = isKnownIntent(raw) ? raw : "none";

  const args: Record<string, unknown> = {};
  for (const key of ["route", "category", "section", "title", "month", "value"]) {
    const v = String(e[key] ?? "").trim();
    if (v) args[key] = v;
  }

  // A route the dashboard does not have is not a navigation.
  if (intent === "navigate" && !ROUTES[String(args["route"] ?? "")]) {
    intent = "none";
  }

  // A category that is not in this workspace is not a generation.
  if (intent === "generate_topics") {
    const known = context.available?.categories ?? [];
    const asked = String(args["category"] ?? "").toLowerCase();
    const match = known.find((c) => c.name.toLowerCase() === asked)
      ?? known.find((c) => c.name.toLowerCase().includes(asked) && asked.length > 3);
    if (!match) intent = "none";
    else {
      args["category"] = match.name;
      args["categoryId"] = match.id;
    }
  }

  // A section that is not in the open article is not a revision.
  if (intent === "revise_section") {
    const known = context.available?.articleSections ?? [];
    const asked = String(args["section"] ?? "").toLowerCase();
    const match = known.find((s) => s.heading.toLowerCase() === asked)
      ?? known.find((s) => s.heading.toLowerCase().includes(asked) && asked.length > 3);
    if (!match) intent = "none";
    else {
      args["section"] = match.heading;
      args["sectionId"] = match.id;
    }
  }

  /*
   * The shape has to parse AND the month has to exist.
   *
   * "2026-13" satisfies the pattern and is not a month. Left through, the
   * calendar would be asked to lay out a thirteenth month and produce
   * something silently wrong rather than refusing.
   */
  if (intent === "plan_month") {
    const m = /^(\d{4})-(\d{2})$/.exec(String(args["month"] ?? ""));
    const month = m ? Number(m[2]) : 0;
    if (!m || month < 1 || month > 12) intent = "none";
  }

  const spec = INTENTS[intent];

  return {
    intent,
    args,
    reply: reply || "I did not follow that. Try naming the page or the category.",
    needsConfirmation: spec.confirm,
    action: intent === "none" || intent === "explain" ? null : spec.describe(args),
  };
}

/** The house punctuation rule, applied to what the companion says too. */
function stripDashes(text: string): string {
  return text.replace(/\s*[—–]\s*/g, ", ").replace(/\s{2,}/g, " ").replace(/,\s*,/g, ",");
}
