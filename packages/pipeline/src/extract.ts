import type { TenantContext } from "@ob/core";
import type { Gateway } from "@ob/ai";
import { composeSystemPrompt, BASE_SYSTEM_RULES, BASE_SAFETY, PROMPT_VERSIONS } from "@ob/ai";
import type { CrawledPage } from "@ob/seo";

/**
 * Business fact extraction — spec §3.1 / §3.2.
 *
 * Produces facts that each carry a source URL, a verbatim quote, and a
 * confidence. Nothing is written to the profile without provenance, because
 * §18's acceptance criteria require "facts include evidence/confidence" and
 * the UI must show the customer where each fact came from.
 */

/**
 * A single attributed value: what was found, where, and how sure we are.
 * Inlined at each use site rather than referenced with `$ref` — structured
 * output support for schema references varies by provider, and this schema
 * has to work across every rung of the fallback chain.
 */
const ATTRIBUTED_VALUE = {
  type: "object",
  additionalProperties: false,
  required: ["value", "sourceUrl", "quote", "confidence"],
  properties: {
    value: { type: "string" },
    sourceUrl: { type: "string" },
    quote: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
} as const;

export const EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["businessName", "industry", "audience", "description", "services", "facts", "locations", "confidenceNotes"],
  properties: {
    businessName: ATTRIBUTED_VALUE,
    industry: ATTRIBUTED_VALUE,
    audience: ATTRIBUTED_VALUE,
    description: ATTRIBUTED_VALUE,
    services: {
      type: "array",
      maxItems: 50,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "sourceUrl", "quote", "confidence"],
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          sourceUrl: { type: "string" },
          quote: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
      },
    },
    facts: {
      type: "array",
      maxItems: 60,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "value", "sourceUrl", "quote", "confidence"],
        properties: {
          key: {
            type: "string",
            enum: ["usp", "cta", "proof", "differentiator", "founded", "team_size",
                   "certification", "award", "guarantee", "hours", "payment", "other"],
          },
          value: { type: "string" },
          sourceUrl: { type: "string" },
          quote: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
      },
    },
    locations: {
      type: "array",
      maxItems: 50,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "sourceUrl", "confidence"],
        properties: {
          label: { type: "string" },
          streetAddress: { type: "string" },
          locality: { type: "string" },
          region: { type: "string" },
          postalCode: { type: "string" },
          country: { type: "string" },
          phone: { type: "string" },
          sourceUrl: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
      },
    },
    confidenceNotes: { type: "string" },
  },
} as const;

export interface ExtractedFact {
  key: string;
  value: string;
  sourceUrl: string;
  quote: string;
  confidence: number;
}

export interface ExtractionResult {
  businessName: ExtractedFact | null;
  industry: ExtractedFact | null;
  audience: ExtractedFact | null;
  description: ExtractedFact | null;
  services: { name: string; description?: string; sourceUrl: string; quote: string; confidence: number }[];
  facts: ExtractedFact[];
  locations: {
    label: string; streetAddress?: string; locality?: string; region?: string;
    postalCode?: string; country?: string; phone?: string; sourceUrl: string; confidence: number;
  }[];
  confidenceNotes: string;
}

/** The business profile fields extraction can write. */
export interface ProfileFields {
  name?: string;
  industry?: string | null;
  audience?: string | null;
  description?: string | null;
  usp?: string | null;
  primaryCta?: string | null;
}

/**
 * What extraction should change on a business row, given what is already there.
 *
 * Extraction seeds empty fields and never touches filled ones. A person who
 * typed their industry when adding the client, or corrected it in Settings
 * afterwards, has told us something the website does not say; replacing it
 * with whatever the model read off the homepage undoes a deliberate edit and
 * looks, from the outside, like the field reverted on its own.
 *
 * That makes a re-crawl safe to run at any time, which is the point of having
 * one. The customer's copy is the authority; the site is only the default.
 *
 * The name is the exception and overwrites whatever is there, because it is
 * the one field a person supplies before seeing the site — often as a
 * shorthand ("Stadium") where the business trades under something longer —
 * and only at a confidence the caller has already checked.
 */
export function profileUpdates(
  extracted: Pick<ExtractionResult, "businessName" | "industry" | "audience" | "description" | "facts">,
  current: ProfileFields,
  /** Below this, the extracted name is not trusted enough to rename a client. */
  nameConfidence = 0.5,
): ProfileFields {
  const updates: ProfileFields = {};
  const empty = (v: string | null | undefined): boolean => !v || !v.trim();

  if (extracted.businessName && extracted.businessName.confidence >= nameConfidence) {
    updates.name = extracted.businessName.value;
  }
  if (extracted.industry && empty(current.industry)) {
    updates.industry = extracted.industry.value;
  }
  if (extracted.audience && empty(current.audience)) {
    updates.audience = extracted.audience.value;
  }
  if (extracted.description && empty(current.description)) {
    updates.description = extracted.description.value;
  }

  const usp = extracted.facts.find((f) => f.key === "usp");
  if (usp && empty(current.usp)) updates.usp = usp.value;
  const cta = extracted.facts.find((f) => f.key === "cta");
  if (cta && empty(current.primaryCta)) updates.primaryCta = cta.value;

  return updates;
}

const EXTRACTION_RULES = `
${BASE_SYSTEM_RULES}

You are extracting verifiable facts about a business from its own website.

Extraction rules:
- Every fact must be supported by a verbatim quote from the supplied page text.
- Set "quote" to the exact substring you relied on. Do not paraphrase it.
- Set "sourceUrl" to the page the quote came from.
- Set "confidence" honestly: 0.9+ only when the page states the fact explicitly;
  0.5-0.7 when you are inferring from context; below 0.5 when you are guessing.
- If a field is not supported by any page, omit it rather than inventing a value.
- Structured data (JSON-LD Organization / LocalBusiness) outranks body copy.
- Do not extract facts about other companies mentioned on the site.
- Extract every distinct service or product supported by the supplied pages.
- Extract every distinct office, branch, facility, and stated service area.
- The description should be a concise, factual summary grounded in the site,
  not marketing copy invented by you.
`.trim();

export async function extractBusinessProfile(
  gateway: Gateway,
  ctx: TenantContext,
  pages: CrawledPage[],
): Promise<ExtractionResult> {
  // Spec §3.1 prioritises Home/About/Services/Products/Locations/Contact/FAQ.
  const ordered = [...pages].sort((a, b) => rank(a.pageType) - rank(b.pageType));
  const selected = ordered.slice(0, 16);

  const evidence = selected
    .map((p) => {
      const structured = p.jsonLd.length > 0
        ? `\nStructured data: ${JSON.stringify(p.jsonLd).slice(0, 2000)}`
        : "";
      return [
        `=== ${p.url} (${p.pageType}) ===`,
        p.title ? `Title: ${p.title}` : "",
        p.metaDescription ? `Meta: ${p.metaDescription}` : "",
        p.headings.slice(0, 12).map((h) => `H${h.level}: ${h.text}`).join("\n"),
        "",
        p.text.slice(0, 5000),
        structured,
      ].filter(Boolean).join("\n");
    })
    .join("\n\n");

  const { system, cacheablePrefixLength } = composeSystemPrompt({
    systemRules: EXTRACTION_RULES,
    safety: BASE_SAFETY,
    sourceEvidence: evidence,
    task: "Extract the business profile from the supplied pages. Return JSON matching the schema.",
    outputFormat: "Return only JSON conforming to the provided schema. No prose, no code fences.",
  });

  const res = await gateway.generate(ctx, {
    taskAlias: "structured_json",
    system,
    cacheableSystemPrefixLength: cacheablePrefixLength,
    messages: [{ role: "user", content: "Extract the business profile now." }],
    schema: EXTRACTION_SCHEMA as unknown as Record<string, unknown>,
    promptVersion: PROMPT_VERSIONS.businessExtraction,
  });

  return normalize(res.parsed, selected);
}

function rank(pageType: string): number {
  const order = ["home", "about", "services", "product", "location", "contact", "faq", "blog", "other", "legal"];
  const idx = order.indexOf(pageType);
  return idx === -1 ? order.length : idx;
}

/**
 * Validate the model's output against the pages we actually crawled.
 *
 * A fact whose quote does not appear in its cited page is not evidence — it is
 * a hallucination with a citation attached. Those are down-weighted rather than
 * dropped, so the customer still sees them in the confirmation step but they
 * never arrive pre-verified.
 */
function normalize(parsed: unknown, pages: CrawledPage[]): ExtractionResult {
  const empty: ExtractionResult = {
    businessName: null, industry: null, audience: null, description: null,
    services: [], facts: [], locations: [], confidenceNotes: "",
  };
  if (!parsed || typeof parsed !== "object") return empty;

  const raw = parsed as Record<string, unknown>;
  const textByUrl = new Map(pages.map((p) => [p.url, normalizeWhitespace(p.text + " " + (p.title ?? ""))]));

  const verify = (fact: ExtractedFact | null): ExtractedFact | null => {
    if (!fact?.value) return null;
    const pageText = textByUrl.get(fact.sourceUrl);
    const quote = normalizeWhitespace(fact.quote ?? "");
    const grounded = Boolean(pageText && quote.length >= 8 && pageText.includes(quote));
    return {
      ...fact,
      confidence: grounded ? fact.confidence : Math.min(fact.confidence, 0.35),
    };
  };

  const asFact = (v: unknown): ExtractedFact | null => {
    if (!v || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    if (typeof o["value"] !== "string" || o["value"].trim() === "") return null;
    return {
      key: "",
      value: String(o["value"]).trim(),
      sourceUrl: String(o["sourceUrl"] ?? ""),
      quote: String(o["quote"] ?? ""),
      confidence: clamp01(Number(o["confidence"] ?? 0.5)),
    };
  };

  const facts = Array.isArray(raw["facts"])
    ? (raw["facts"] as Record<string, unknown>[])
        .map((f) => {
          const base = asFact(f);
          return base ? verify({ ...base, key: String(f["key"] ?? "other") }) : null;
        })
        .filter((f): f is ExtractedFact => f !== null)
    : [];

  const services = Array.isArray(raw["services"])
    ? (raw["services"] as Record<string, unknown>[])
        .filter((s) => typeof s["name"] === "string" && s["name"].trim() !== "")
        .map((s) => ({
          name: String(s["name"]).trim(),
          description: typeof s["description"] === "string" ? s["description"] : undefined,
          sourceUrl: String(s["sourceUrl"] ?? ""),
          quote: String(s["quote"] ?? ""),
          confidence: clamp01(Number(s["confidence"] ?? 0.5)),
        }))
    : [];

  const locations = Array.isArray(raw["locations"])
    ? (raw["locations"] as Record<string, unknown>[])
        .filter((l) => typeof l["label"] === "string" && l["label"].trim() !== "")
        .map((l) => ({
          label: String(l["label"]).trim(),
          streetAddress: str(l["streetAddress"]),
          locality: str(l["locality"]),
          region: str(l["region"]),
          postalCode: str(l["postalCode"]),
          country: str(l["country"]),
          phone: str(l["phone"]),
          sourceUrl: String(l["sourceUrl"] ?? ""),
          confidence: clamp01(Number(l["confidence"] ?? 0.5)),
        }))
    : [];

  return {
    businessName: verify(asFact(raw["businessName"])),
    industry: verify(asFact(raw["industry"])),
    audience: verify(asFact(raw["audience"])),
    description: verify(asFact(raw["description"])),
    services,
    facts,
    locations,
    confidenceNotes: typeof raw["confidenceNotes"] === "string" ? raw["confidenceNotes"] : "",
  };
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5);

const normalizeWhitespace = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();
