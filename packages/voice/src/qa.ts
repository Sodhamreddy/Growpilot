import type { VoiceProfile } from "./profile.js";

/**
 * Voice QA — spec §18.5.
 *
 * The spec's table has six checks. Four are deterministic and run here with no
 * model: vocabulary (preferred/banned terms), CTA conformance, consistency
 * (sentence-length stability), and unsupported-promise detection. Tone match
 * needs semantic judgement and is supplied by the caller from an LLM pass; the
 * sixth, human review, is a workflow state, not a computation.
 */

export interface VoiceFinding {
  check: "tone" | "vocabulary" | "claims" | "cta" | "consistency";
  severity: "info" | "warn" | "error";
  message: string;
  evidence?: string;
  suggestion?: string;
}

export interface VoiceQaInput {
  bodyMarkdown: string;
  profile: VoiceProfile;
  bannedTerms: string[];
  preferredTerms: { use: string; insteadOf?: string }[];
  /** 0–100 tone-match score from the semantic pass, when available. */
  toneMatchScore?: number;
}

export interface VoiceQaResult {
  score: number;
  verdict: "pass" | "warn" | "fail";
  findings: VoiceFinding[];
}

/** Phrases that promise an outcome no evidence can support (spec §18.5 "Claims"). */
const UNSUPPORTED_PROMISE = [
  /\bguarantee(?:d|s)?\b/i,
  /\bwe promise\b/i,
  /\b100%\s+(?:effective|safe|successful|guaranteed)\b/i,
  /\bno\s+risk\b/i,
  /\brisk[- ]free\b/i,
  /\binstant(?:ly)?\s+(?:results|relief|cure)\b/i,
  /\b(?:cure|cures|curing)\b/i,
  /\bnumber\s*(?:one|1)\b/i,
  /\b#1\b/,
  /\bbest\s+in\s+(?:the\s+)?(?:world|country|industry)\b/i,
];

const CTA_PATTERNS: Record<VoiceProfile["ctaStyle"], RegExp> = {
  "soft-educational": /\b(learn more|read more|explore|discover|find out)\b/i,
  consultation: /\b(book|schedule|arrange|request)\s+(?:a\s+)?(consultation|appointment|call|demo|assessment)\b/i,
  purchase: /\b(buy|order|purchase|add to (?:cart|basket)|shop|get started)\b/i,
  "direct-action": /\b(call|contact|email|visit|apply|sign up|get in touch)\b/i,
};

export function runVoiceQa(input: VoiceQaInput): VoiceQaResult {
  const findings: VoiceFinding[] = [];
  const body = input.bodyMarkdown;
  const prose = stripMarkdown(body);

  // ── Vocabulary: banned terms ──
  for (const term of input.bannedTerms) {
    const re = new RegExp(`\\b${escapeRegExp(term)}\\b`, "gi");
    const match = re.exec(prose);
    if (match) {
      findings.push({
        check: "vocabulary",
        severity: "error",
        message: `Banned term "${term}" appears in the copy.`,
        evidence: excerpt(prose, match.index),
        suggestion: `Remove "${term}" or rephrase without it.`,
      });
    }
  }

  // ── Vocabulary: preferred terms ──
  for (const pref of input.preferredTerms) {
    if (!pref.insteadOf) continue;
    const re = new RegExp(`\\b${escapeRegExp(pref.insteadOf)}\\b`, "gi");
    const match = re.exec(prose);
    if (match) {
      findings.push({
        check: "vocabulary",
        severity: "warn",
        message: `Copy uses "${pref.insteadOf}" where the brand prefers "${pref.use}".`,
        evidence: excerpt(prose, match.index),
        suggestion: `Replace with "${pref.use}".`,
      });
    }
  }

  // ── Claims ──
  for (const re of UNSUPPORTED_PROMISE) {
    const match = re.exec(prose);
    if (match) {
      findings.push({
        check: "claims",
        severity: "error",
        message: `The copy makes an unsupported promise: "${match[0]}".`,
        evidence: excerpt(prose, match.index),
        suggestion: "State what the business actually does, without promising an outcome.",
      });
    }
  }

  // ── CTA ──
  const ctaRe = CTA_PATTERNS[input.profile.ctaStyle];
  if (!ctaRe.test(prose)) {
    findings.push({
      check: "cta",
      severity: "warn",
      message: `No call to action matching the brand's "${input.profile.ctaStyle}" style was found.`,
      suggestion: `Close with a ${input.profile.ctaStyle.replace(/-/g, " ")} call to action.`,
    });
  }

  // ── Consistency: sentence length against the profile target ──
  const sentences = splitSentences(prose);
  if (sentences.length >= 5) {
    const lengths = sentences.map((s) => (s.match(/[\p{L}\p{N}']+/gu) ?? []).length).filter((n) => n > 0);
    const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    const target = input.profile.formattingHabits.avgSentenceWords;
    const drift = Math.abs(mean - target) / target;

    if (drift > 0.5) {
      findings.push({
        check: "consistency",
        severity: "warn",
        message: `Average sentence length is ${mean.toFixed(1)} words against a brand target of ${target}.`,
        suggestion: mean > target ? "Break up the longer sentences." : "Combine some short sentences.",
      });
    }

    const variance = lengths.reduce((sum, n) => sum + (n - mean) ** 2, 0) / lengths.length;
    if (Math.sqrt(variance) > mean * 0.9) {
      findings.push({
        check: "consistency",
        severity: "info",
        message: "Sentence length varies widely, which reads as inconsistent voice.",
        suggestion: "Even out the rhythm across sections.",
      });
    }
  }

  // ── Tone (semantic, supplied) ──
  if (input.toneMatchScore !== undefined) {
    if (input.toneMatchScore < 60) {
      findings.push({
        check: "tone",
        severity: "error",
        message: `Tone match is ${input.toneMatchScore}/100 against the approved voice.`,
        suggestion: "Rewrite to match the approved tone before publishing.",
      });
    } else if (input.toneMatchScore < 75) {
      findings.push({
        check: "tone",
        severity: "warn",
        message: `Tone match is ${input.toneMatchScore}/100.`,
        suggestion: "Adjust register toward the approved voice.",
      });
    }
  } else {
    findings.push({
      check: "tone",
      severity: "info",
      message: "Semantic tone check has not run; only deterministic voice rules were applied.",
    });
  }

  return { score: computeScore(findings, input.toneMatchScore), verdict: verdictFor(findings), findings };
}

function computeScore(findings: VoiceFinding[], toneMatchScore?: number): number {
  // Start from the semantic tone score when available, else a neutral 80.
  let score = toneMatchScore ?? 80;
  for (const f of findings) {
    if (f.check === "tone") continue; // already reflected in the baseline
    if (f.severity === "error") score -= 20;
    else if (f.severity === "warn") score -= 8;
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

function verdictFor(findings: VoiceFinding[]): "pass" | "warn" | "fail" {
  if (findings.some((f) => f.severity === "error")) return "fail";
  if (findings.some((f) => f.severity === "warn")) return "warn";
  return "pass";
}

/** Strip markdown syntax so checks run against prose, not formatting. */
export function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")          // fenced code
    .replace(/`[^`]*`/g, " ")                  // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")     // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")   // links → anchor text
    .replace(/^#{1,6}\s+/gm, "")               // headings
    .replace(/^[>\-*+]\s+/gm, "")              // quotes and bullets
    .replace(/[*_~]/g, "")                     // emphasis
    .replace(/\s+/g, " ")
    .trim();
}

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+(?=[A-Z"'(])/).filter((s) => s.trim().length > 0);
}

function excerpt(text: string, index: number, radius = 60): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + radius);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
