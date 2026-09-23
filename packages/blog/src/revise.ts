import type { TenantContext } from "@ob/core";
import type { Gateway } from "@ob/ai";
import {
  composeSystemPrompt, BASE_SYSTEM_RULES, BASE_SAFETY,
  renderBusinessFacts, PROMPT_VERSIONS,
} from "@ob/ai";
import { renderVoiceLayer, type VoiceProfile } from "@ob/voice";

/**
 * Targeted revision — the blog companion.
 *
 * A reviewer reading a draft usually wants one thing changed, not a new
 * article. Before this, the options were to edit by hand or regenerate, and
 * regenerating threw away everything that was already right to fix one
 * sentence. This rewrites a single section against an instruction and returns
 * the proposed text; nothing is saved until a person approves it.
 *
 * Deliberately narrow: it revises prose that already exists. It does not
 * research, does not fetch, and cannot introduce a fact — the same grounding
 * rules that governed the original draft apply here, because a revision is
 * just as publishable as a first draft and there is no second gate that would
 * catch a claim invented at this stage.
 */

export interface ArticleSection {
  /** Stable id derived from position, so a repeated heading is addressable. */
  id: string;
  /** The heading text, or "" for the opening passage before any heading. */
  heading: string;
  level: number;
  /** Body text under this heading, excluding the heading line itself. */
  content: string;
}

/**
 * Split a draft into addressable sections.
 *
 * The companion offers these in a picker, so the split has to be stable: the
 * id is the index, not a slug of the heading, because two sections called
 * "Costs" would otherwise collide and the reviewer's choice would apply to the
 * wrong one.
 */
export function splitSections(markdown: string): ArticleSection[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const sections: ArticleSection[] = [];
  let heading = "";
  let level = 0;
  let buffer: string[] = [];

  const flush = () => {
    const content = buffer.join("\n").trim();
    // An empty lead-in before the first heading is not a section.
    if (!content && !heading) { buffer = []; return; }
    sections.push({ id: String(sections.length), heading, level, content });
    buffer = [];
  };

  for (const line of lines) {
    const m = /^(#{2,6})\s+(.*)$/.exec(line);
    if (m) {
      flush();
      level = m[1]!.length;
      heading = m[2]!.trim();
      continue;
    }
    buffer.push(line);
  }
  flush();

  return sections;
}

/** Reassemble a draft with one section's content replaced. */
export function replaceSection(
  markdown: string,
  sectionId: string,
  newContent: string,
): string {
  const sections = splitSections(markdown);
  return sections
    .map((s) => {
      const body = s.id === sectionId ? newContent.trim() : s.content;
      const head = s.heading ? `${"#".repeat(s.level)} ${s.heading}` : "";
      return [head, body].filter(Boolean).join("\n\n");
    })
    .join("\n\n")
    .trim();
}

export interface ReviseInput {
  business: { name: string; industry?: string | null; audience?: string | null; usp?: string | null };
  facts: { key: string; value: string; sourceUrl?: string | null; confidence: number; verified: boolean }[];
  voice: {
    profile: VoiceProfile;
    bannedTerms: string[];
    preferredTerms: { use: string; insteadOf?: string }[];
    samples: { text: string }[];
  } | null;
  articleTitle: string;
  primaryKeyword: string;
  /** The section being revised; `null` heading means the opening passage. */
  section: ArticleSection;
  /** What the reviewer asked for, in their own words. */
  instruction: string;
  /** URLs the original draft was allowed to link to. */
  allowedLinks: { url: string; anchor: string }[];
}

const REVISE_RULES = `${BASE_SYSTEM_RULES}

You are revising ONE section of an article that is already written.

Rules:
- Return the revised section only. No heading, no preamble, no explanation.
- Change what the instruction asks for and leave the rest of the section alone.
  A reviewer asking for one sentence to be softened does not want the whole
  section rewritten in a different voice.
- You may remove or soften a claim. You may NOT add a fact that is not already
  in the section or in BUSINESS FACTS — a revision is published exactly like a
  first draft, and nothing downstream will catch an invention made here.
- Never introduce a URL. You may keep or drop a link that is already present.
- If the instruction asks for something that would require inventing a fact,
  make the part of the change you safely can and leave the rest.
- Keep the same markdown conventions: ## for sub-headings, - for bullets.`;

export interface RevisedSection {
  /** The proposed replacement text. */
  content: string;
  /** Whether the model actually changed anything. */
  changed: boolean;
}

export async function reviseSection(
  gateway: Gateway,
  ctx: TenantContext,
  input: ReviseInput,
): Promise<RevisedSection> {
  const links = input.allowedLinks.length
    ? input.allowedLinks.map((l) => `- ${l.url}`).join("\n")
    : "- None. Do not add any link.";

  const { system, cacheablePrefixLength } = composeSystemPrompt({
    systemRules: REVISE_RULES,
    safety: BASE_SAFETY,
    businessFacts: renderBusinessFacts(input.business, input.facts),
    brandVoice: input.voice
      ? renderVoiceLayer({ ...input.voice, channel: "article" })
      : "No approved brand voice is on file. Keep the register of the surrounding text.",
    task: [
      `Article: "${input.articleTitle}"`,
      `Primary keyword: ${input.primaryKeyword}`,
      input.section.heading
        ? `Section: "${input.section.heading}"`
        : "Section: the opening passage, before the first heading.",
      "",
      "The reviewer asked for this change:",
      '"""',
      // Bounded and fenced: this is customer-typed text read by a model, and
      // an unfenced instruction could pose as a system rule.
      input.instruction.trim().slice(0, 1000),
      '"""',
      "",
      "Links that already exist and may be kept:",
      links,
      "",
      "Current section text:",
      '"""',
      input.section.content,
      '"""',
    ].join("\n"),
    outputFormat:
      "Return only the revised section text as Markdown. No heading line, no commentary, no code fence.",
  });

  const res = await gateway.generate(ctx, {
    // The alias that exists for exactly this: changing prose that is already
    // written, where a cheaper model is appropriate than for a first draft.
    taskAlias: "editing_rewrite",
    system,
    cacheableSystemPrefixLength: cacheablePrefixLength,
    messages: [{ role: "user", content: "Revise the section now." }],
    promptVersion: PROMPT_VERSIONS.articleDraft,
  });

  const content = stripFence(res.text).trim();

  return {
    content,
    changed: content !== "" && normalise(content) !== normalise(input.section.content),
  };
}

/**
 * Remove a code fence the model wrapped the answer in.
 *
 * Asked for "markdown, no code fence", models still fence it often enough that
 * handling it here is cheaper than a retry — and an unhandled fence would be
 * pasted into the article as literal backticks.
 */
function stripFence(text: string): string {
  const m = /^\s*```(?:markdown|md)?\s*\n([\s\S]*?)\n\s*```\s*$/.exec(text.trim());
  return m?.[1] ?? text;
}

const normalise = (s: string): string => s.replace(/\s+/g, " ").trim();
