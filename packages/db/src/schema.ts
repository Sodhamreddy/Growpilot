import {
  pgTable, pgEnum, text, uuid, timestamp, integer, real, boolean,
  jsonb, index, uniqueIndex, primaryKey, vector, bigint, type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

/**
 * Data model — spec §13.
 *
 * Tenancy rule: every table below `workspaces` carries `workspace_id` and is
 * indexed on it first. Repositories always filter on it (see src/repo.ts), so
 * a query that forgets the tenant filter does not type-check.
 */

// ─── Enums ──────────────────────────────────────────────────────────────────

export const authProvider = pgEnum("auth_provider", ["email", "google"]);
export const userStatus = pgEnum("user_status", ["pending", "active", "suspended"]);
export const memberRole = pgEnum("member_role", ["owner", "admin", "editor", "viewer"]);
export const planTier = pgEnum("plan_tier", ["trial", "starter", "growth", "agency"]);
export const crawlStatus = pgEnum("crawl_status", ["pending", "running", "succeeded", "failed", "blocked"]);
export const searchIntent = pgEnum("search_intent", [
  "informational", "commercial", "transactional", "navigational", "local",
]);
export const topicStatus = pgEnum("topic_status", [
  "idea", "planned", "briefed", "drafting", "review", "approved", "published", "archived",
]);
export const articleStatus = pgEnum("article_status", [
  "draft", "generating", "qa", "needs_changes", "awaiting_approval",
  "approved", "scheduled", "published", "failed",
]);
export const jobStatus = pgEnum("job_status", ["queued", "running", "succeeded", "failed", "cancelled"]);
export const integrationStatus = pgEnum("integration_status", [
  "connected", "expired", "revoked", "error", "paused",
]);
export const gateVerdict = pgEnum("gate_verdict", ["pass", "warn", "fail"]);

/*
 * Social — a month is planned, then written.
 *
 * `planned` topics come out of the calendar prompt. `slated` means a person
 * kept it for this month. Only a slated topic is worth writing a content pack
 * for, which is what keeps the expensive call off the ones nobody chose.
 */
export const socialMonthStatus = pgEnum("social_month_status", [
  "planning", "planned", "writing", "written", "failed",
]);
/**
 * A topic's life.
 *
 * `idea` is the pool: generated per category, reviewed, never yet tied to a
 * date. `scheduled` means a month's calendar claimed it. The pool is built
 * once and drawn from for months afterwards, so the two are separate states
 * rather than one flag.
 */
export const socialTopicStatus = pgEnum("social_topic_status", [
  "idea", "rejected", "scheduled", "written", "approved", "published",
]);

const EMPTY_ARRAY = sql`'[]'::jsonb`;
const EMPTY_OBJECT = sql`'{}'::jsonb`;

// ─── Identity & tenancy ─────────────────────────────────────────────────────

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull(),
  emailNormalized: text("email_normalized").notNull(),
  name: text("name"),
  authProvider: authProvider("auth_provider").notNull().default("email"),
  /** scrypt hash; null for OAuth-only accounts. Never plaintext (spec §2.1). */
  passwordHash: text("password_hash"),
  status: userStatus("status").notNull().default("pending"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("users_email_norm_uq").on(t.emailNormalized)]);

/** Spec §10.3 / §15.1 — workspace automation and approval policy. */
export interface WorkspaceSettings {
  /**
   * Unattended content runs.
   *
   * Off by default, and deliberately so: a workspace that starts generating on
   * its own the moment onboarding finishes would spend a customer's AI budget
   * before they had decided they wanted that. Turning it on is a choice.
   *
   * `draftCount` is what actually costs money — topics are cheap, drafts are
   * not — so it is capped rather than left open.
   */
  contentSchedule?: {
    enabled: boolean;
    /** Day of week, 0 = Sunday. */
    weekday: number;
    /** Hour in the workspace timezone, 0–23. */
    hour: number;
    /** How many topics to plan each run. */
    topicCount: number;
    /** How many of those to draft immediately. */
    draftCount: number;
  };
  requireApprovalBeforePublish?: boolean;
  requireHumanReviewForSensitive?: boolean;
  autoPublishEnabled?: boolean;
  minSeoScoreToPublish?: number;
  minVoiceScoreToPublish?: number;
  /**
   * Answers collected during onboarding (spec §2.2). Stored here rather than in
   * their own table because they configure the workspace rather than describing
   * an entity — and because §2.2 requires autosave, which a jsonb patch does
   * without a migration per question.
   */
  onboarding?: {
    /** Attribution. Explicitly skippable per §2.2. */
    heardFrom?: string;
    /** Which modules the customer wants — drives which questions get asked. */
    goals?: ("articles" | "local" | "social")[];
    /** Detected from the customer's own site, then corrected by them. */
    brandColors?: { hex: string; role: string }[];
    /** Themes the content plan is built around. */
    contentPillars?: string[];
    tone?: string;
    businessId?: string;
    sourceMode?: "website" | "manual";
    sourceUrl?: string;
    manual?: { name: string; offer: string; audience: string; serviceArea: string };
    /** Networks the customer intends to post to. */
    platforms?: string[];
    completedSteps?: string[];
  };
}

export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  timezone: text("timezone").notNull().default("UTC"),
  locale: text("locale").notNull().default("en-US"),
  plan: planTier("plan").notNull().default("trial"),
  settings: jsonb("settings").$type<WorkspaceSettings>().notNull().default(EMPTY_OBJECT),
  /** Monthly AI spend ceiling in micro-dollars (spec §5.2 per-workspace budgets). */
  aiBudgetMicros: bigint("ai_budget_micros", { mode: "number" }).notNull().default(50_000_000),
  onboardingStep: text("onboarding_step").notNull().default("goals"),
  onboardingCompletedAt: timestamp("onboarding_completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("workspaces_slug_uq").on(t.slug),
  index("workspaces_owner_idx").on(t.ownerId),
]);

export const workspaceMembers = pgTable("workspace_members", {
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  selectedBusinessId: uuid("selected_business_id").references((): AnyPgColumn => businesses.id, { onDelete: "set null" }),
  role: memberRole("role").notNull().default("editor"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.workspaceId, t.userId] }),
  index("wm_user_idx").on(t.userId),
]);

/**
 * Password reset tokens — spec §2.1.
 *
 * Only a SHA-256 of the token is stored, the same rule sessions follow: a reset
 * token is a temporary credential, and a database dump must not hand an
 * attacker the ability to take over accounts.
 *
 * `usedAt` rather than deleting the row on use. A reset link that has already
 * been used is a different answer from one that never existed — the first means
 * "request a new one", the second may mean someone is guessing tokens — and
 * deleting the row collapses those into the same dead end.
 */
export const passwordResets = pgTable("password_resets", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  /** SHA-256 of the emailed token. The raw value is never stored. */
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  requestedIp: text("requested_ip"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("pwreset_token_uq").on(t.tokenHash),
  index("pwreset_user_idx").on(t.userId),
]);

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  /** SHA-256 of the cookie value — the raw token is never stored. */
  tokenHash: text("token_hash").notNull(),
  activeWorkspaceId: uuid("active_workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
  userAgent: text("user_agent"),
  ip: text("ip"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("sessions_token_uq").on(t.tokenHash),
  index("sessions_user_idx").on(t.userId),
]);

// ─── Business intelligence (spec §3) ────────────────────────────────────────

/**
 * Customer-written steering for the generation prompts.
 *
 * Held against the business, not the workspace. An agency runs several clients
 * from one login and they are rarely in the same trade: a pharmacy's
 * instructions told a marketing agency's articles to close on a prescription
 * line, because the boxes belonged to whichever workspace was open rather than
 * to the client on screen.
 *
 * Appended to the built-in task prompts rather than replacing them. The rules
 * that stop the model inventing services, faking locations and hallucinating
 * URLs are not negotiable; what these boxes control is editorial judgement.
 */
export interface BusinessPrompts {
  blog?: {
    /** Steers which topics get proposed. */
    topics?: string;
    /** Steers how the article itself is written. */
    article?: string;
    /**
     * An example the model should take its cue from.
     *
     * The strongest signal of the three: a customer pasting an article they
     * liked says more than any adjective they could pick from a dropdown.
     */
    reference?: string;
  };
  /**
   * Social-only steering.
   *
   * Kept apart from the blog's because the two pillars want different things:
   * a blog cares about internal links and a focus keyword, a post cares about
   * image treatments and a character ceiling.
   */
  social?: {
    topics?: string;
    post?: string;
    image?: string;
    reference?: string;
    /** Brand clichés the copy must never use. */
    wordsToAvoid?: string[];
  };
}

export const businesses = pgTable("businesses", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  industry: text("industry"),
  audience: text("audience"),
  description: text("description"),
  usp: text("usp"),
  primaryCta: text("primary_cta"),
  /**
   * Writing instructions for this client.
   *
   * Per business rather than per workspace: an agency's clients are rarely in
   * the same trade, and instructions written for one were being applied to all
   * of them.
   */
  prompts: jsonb("prompts").$type<BusinessPrompts>().notNull().default(EMPTY_OBJECT),
  websiteUrl: text("website_url"),
  /** Logo URL. Used wherever generated content carries the brand. */
  logoUrl: text("logo_url"),
  /**
   * The business name exactly as it appears on Google Business Profile.
   *
   * Separate from `name` because the two genuinely differ: a listing is often
   * registered as "Kleza Solutions Pvt Ltd" while the site says "Kleza". Review
   * replies and local content have to use the listing's name to be recognised,
   * and guessing one from the other produces confidently wrong output.
   */
  gmbName: text("gmb_name"),
  /**
   * Social channels the business already runs.
   *
   * Recorded even before any account is connected: knowing which networks a
   * business is on shapes what content gets planned for it, and that is useful
   * well before anyone has authorised posting.
   */
  socialProfiles: jsonb("social_profiles")
    .$type<{ network: string; handle: string; url: string }[]>()
    .notNull().default(EMPTY_ARRAY),
  /**
   * Which Facebook Page and Instagram account this client's insights come from.
   *
   * One Meta connection can administer pages for many unrelated businesses —
   * an agency login routinely reaches fifteen — so the connection alone cannot
   * say whose numbers are whose. Without this, every page's metrics landed
   * against whichever client happened to be selected when someone connected.
   *
   * Null means "not chosen yet", which the sync treats as nothing to fetch
   * rather than defaulting to the first page and quietly attributing another
   * business's audience to this one.
   */
  metaPageId: text("meta_page_id"),
  metaPageName: text("meta_page_name"),
  /**
   * Which Google listing is this client's, for reviews.
   *
   * Chosen, never guessed, for the same reason as the Facebook Page above: a
   * name search finds namesakes, and replying to another business's reviews
   * is a mistake nothing downstream could catch. Also carries the listing's
   * latest rating and review count, from whichever source synced last.
   */
  googleListing: jsonb("google_listing").$type<GoogleListing>(),
  /** Set when the customer confirms the extracted profile — spec §3.1 gate. */
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  confirmedBy: uuid("confirmed_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("businesses_ws_idx").on(t.workspaceId)]);

export const businessSources = pgTable("business_sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  canonicalUrl: text("canonical_url").notNull(),
  crawlStatus: crawlStatus("crawl_status").notNull().default("pending"),
  pagesDiscovered: integer("pages_discovered").notNull().default(0),
  pagesFetched: integer("pages_fetched").notNull().default(0),
  robotsAllowed: boolean("robots_allowed").notNull().default(true),
  lastCrawledAt: timestamp("last_crawled_at", { withTimezone: true }),
  lastError: text("last_error"),
  /**
   * Brand colours read from the site's markup during the crawl.
   *
   * Stored here rather than derived on demand because detection needs the raw
   * HTML, and `source_pages` keeps only extracted text — colour lives in style
   * attributes and style blocks that text extraction discards. An empty array
   * means detection found nothing, which is a real answer, not a missing one.
   */
  brandColors: jsonb("brand_colors").$type<{ hex: string; role: string; weight: number }[]>()
    .notNull().default(EMPTY_ARRAY),
  /**
   * URLs the site declares in its sitemap.
   *
   * Kept even when the crawl could not fetch the pages themselves. A sitemap is
   * the site's own statement of which URLs exist, so it is a trustworthy source
   * of internal link targets — and it is often readable when page fetching is
   * blocked, or when a budget stops the crawl well short of every page.
   *
   * Without this the generator had nothing to link to and correctly wrote no
   * internal links at all, which reads as a fault in the writing rather than a
   * missing input.
   */
  sitemapUrls: jsonb("sitemap_urls").$type<string[]>().notNull().default(EMPTY_ARRAY),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("bsrc_ws_idx").on(t.workspaceId),
  uniqueIndex("bsrc_biz_url_uq").on(t.businessId, t.canonicalUrl),
]);

/** One crawled page. Raw text is retained as retrieval evidence (spec §4). */
export const sourcePages = pgTable("source_pages", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  sourceId: uuid("source_id").notNull().references(() => businessSources.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  httpStatus: integer("http_status"),
  title: text("title"),
  metaDescription: text("meta_description"),
  canonical: text("canonical"),
  h1: text("h1"),
  pageType: text("page_type"),
  wordCount: integer("word_count").notNull().default(0),
  text: text("text").notNull().default(""),
  headings: jsonb("headings").$type<{ level: number; text: string }[]>().notNull().default(EMPTY_ARRAY),
  jsonLd: jsonb("json_ld").$type<unknown[]>().notNull().default(EMPTY_ARRAY),
  openGraph: jsonb("open_graph").$type<Record<string, string>>().notNull().default(EMPTY_OBJECT),
  internalLinks: jsonb("internal_links").$type<string[]>().notNull().default(EMPTY_ARRAY),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("spage_ws_idx").on(t.workspaceId),
  uniqueIndex("spage_source_url_uq").on(t.sourceId, t.url),
]);

/** Extracted fact with provenance — spec §3.1 "source URL, timestamp and confidence". */
export const businessFacts = pgTable("business_facts", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  value: text("value").notNull(),
  sourceUrl: text("source_url"),
  sourceQuote: text("source_quote"),
  confidence: real("confidence").notNull().default(0.5),
  /** True once a human accepted or edited it (spec §18 QA: "user can correct"). */
  verified: boolean("verified").notNull().default(false),
  supersededById: uuid("superseded_by_id"),
  extractedAt: timestamp("extracted_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("bfact_ws_biz_idx").on(t.workspaceId, t.businessId),
  index("bfact_key_idx").on(t.businessId, t.key),
]);

export const businessLocations = pgTable("business_locations", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  streetAddress: text("street_address"),
  locality: text("locality"),
  region: text("region"),
  postalCode: text("postal_code"),
  country: text("country"),
  phone: text("phone"),
  sourceUrl: text("source_url"),
  confidence: real("confidence").notNull().default(0.5),
}, (t) => [index("bloc_ws_idx").on(t.workspaceId, t.businessId)]);

// ─── Brand voice (spec §18) ─────────────────────────────────────────────────

/** Spec §18.3 voice profile structure. */
export interface VoiceProfile {
  tone: string[];
  toneIntensity: number;
  formality: "casual" | "balanced" | "formal";
  sentenceStyle: "short-direct" | "explanatory" | "narrative" | "detailed";
  pointOfView: "first-person" | "second-person" | "third-person" | "brand-led";
  emotionalStyle: "practical" | "encouraging" | "authoritative" | "warm" | "neutral";
  ctaStyle: "soft-educational" | "consultation" | "purchase" | "direct-action";
  spelling: "en-US" | "en-GB" | "en-AU" | "en-IN";
  formattingHabits: {
    useHeadings: boolean;
    useBullets: boolean;
    avgSentenceWords: number;
    useExamples: boolean;
  };
  notes?: string;
}

export const brandVoices = pgTable("brand_voices", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  version: integer("version").notNull().default(1),
  /** Structured rules — never a per-customer fine-tuned model (spec §18.8). */
  profile: jsonb("profile").$type<VoiceProfile>().notNull(),
  bannedTerms: jsonb("banned_terms").$type<string[]>().notNull().default(EMPTY_ARRAY),
  preferredTerms: jsonb("preferred_terms")
    .$type<{ use: string; insteadOf?: string }[]>().notNull().default(EMPTY_ARRAY),
  samples: jsonb("samples")
    .$type<{ sourceUrl?: string; text: string }[]>().notNull().default(EMPTY_ARRAY),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  approvedBy: uuid("approved_by").references(() => users.id, { onDelete: "set null" }),
  isActive: boolean("is_active").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("voice_ws_idx").on(t.workspaceId),
  uniqueIndex("voice_biz_version_uq").on(t.businessId, t.version),
]);

// ─── Knowledge base / RAG (spec §4) ─────────────────────────────────────────

export const knowledgeChunks = pgTable("knowledge_chunks", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  /** page | fact | article | upload */
  kind: text("kind").notNull(),
  refId: uuid("ref_id"),
  sourceUrl: text("source_url"),
  heading: text("heading"),
  content: text("content").notNull(),
  tokenCount: integer("token_count").notNull().default(0),
  embedding: vector("embedding", { dimensions: 1536 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("kchunk_ws_biz_idx").on(t.workspaceId, t.businessId)]);
// The IVFFlat vector index is created in the SQL migration — it needs table
// statistics to pick a sensible `lists` value.

// ─── SEO research (spec §6) ─────────────────────────────────────────────────

export const keywords = pgTable("keywords", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  term: text("term").notNull(),
  intent: searchIntent("intent"),
  volume: integer("volume"),
  difficulty: real("difficulty"),
  cpcMicros: integer("cpc_micros"),
  location: text("location").notNull().default(""),
  language: text("language").notNull().default("en"),
  clusterId: uuid("cluster_id"),
  /** Composite of business value, relevance and ranking opportunity (§6.1). */
  opportunityScore: real("opportunity_score"),
  /**
   * How central this term is to what the business actually sells, 0–1.
   *
   * Kept separately from `opportunityScore` because it means something
   * different and survives when that one cannot be computed: opportunity needs
   * market data (volume, difficulty) from a keyword provider, but relevance is
   * judged from the business's own pages and is always available. With no
   * provider configured it is the only honest basis for ranking, so it must be
   * persisted rather than discarded after scoring.
   */
  relevance: real("relevance"),
  provider: text("provider").notNull().default("stub"),
  refreshedAt: timestamp("refreshed_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("kw_ws_biz_idx").on(t.workspaceId, t.businessId),
  uniqueIndex("kw_biz_term_loc_uq").on(t.businessId, t.term, t.location),
]);

export const keywordClusters = pgTable("keyword_clusters", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  primaryKeywordId: uuid("primary_keyword_id"),
  intent: searchIntent("intent"),
  totalVolume: integer("total_volume").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("kcluster_ws_idx").on(t.workspaceId, t.businessId)]);

/** Spec §6.2 content plan row. */
export interface ContentBrief {
  angle: string;
  audience: string;
  searchIntent: string;
  outline: { heading: string; level: number; guidance: string }[];
  mustCoverFacts: string[];
  internalLinkTargets: { url: string; anchor: string }[];
  targetWordCount: number;
  ctaGuidance: string;
}

export const topics = pgTable("topics", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  primaryKeywordId: uuid("primary_keyword_id").references(() => keywords.id, { onDelete: "set null" }),
  secondaryTerms: jsonb("secondary_terms").$type<string[]>().notNull().default(EMPTY_ARRAY),
  intent: searchIntent("intent"),
  targetUrl: text("target_url"),
  priority: real("priority").notNull().default(0),
  publishDate: timestamp("publish_date", { withTimezone: true }),
  status: topicStatus("status").notNull().default("idea"),
  brief: jsonb("brief").$type<ContentBrief | null>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("topic_ws_status_idx").on(t.workspaceId, t.status),
  index("topic_biz_idx").on(t.businessId),
]);

// ─── Articles (spec §6.3) ───────────────────────────────────────────────────

export const articles = pgTable("articles", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  topicId: uuid("topic_id").references(() => topics.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  slug: text("slug").notNull(),
  metaTitle: text("meta_title"),
  metaDescription: text("meta_description"),
  bodyMarkdown: text("body_markdown").notNull().default(""),
  schemaJsonLd: jsonb("schema_json_ld").$type<unknown>(),
  status: articleStatus("status").notNull().default("draft"),
  version: integer("version").notNull().default(1),
  /** Weighted explainable score — spec §7.1. Breakdown lives in articleScores. */
  seoScore: real("seo_score"),
  voiceScore: real("voice_score"),
  wordCount: integer("word_count").notNull().default(0),
  brandVoiceId: uuid("brand_voice_id").references(() => brandVoices.id, { onDelete: "set null" }),
  approvedBy: uuid("approved_by").references(() => users.id, { onDelete: "set null" }),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  publishedUrl: text("published_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("article_ws_status_idx").on(t.workspaceId, t.status),
  uniqueIndex("article_biz_slug_uq").on(t.businessId, t.slug),
]);

export const articleRevisions = pgTable("article_revisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  articleId: uuid("article_id").notNull().references(() => articles.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  bodyMarkdown: text("body_markdown").notNull(),
  title: text("title").notNull(),
  authoredBy: text("authored_by").notNull(),
  aiJobId: uuid("ai_job_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("arev_article_version_uq").on(t.articleId, t.version),
  index("arev_ws_idx").on(t.workspaceId),
]);

export interface GateFinding {
  severity: "info" | "warn" | "error";
  message: string;
  evidence?: string;
  suggestion?: string;
  location?: string;
}

/** One quality-gate result — spec §15.1, explainable per §7.1. */
export const qualityGateResults = pgTable("quality_gate_results", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  articleId: uuid("article_id").notNull().references(() => articles.id, { onDelete: "cascade" }),
  articleVersion: integer("article_version").notNull(),
  /** grounding | business_facts | brand | seo | risk | publishing | audit */
  gate: text("gate").notNull(),
  verdict: gateVerdict("verdict").notNull(),
  score: real("score"),
  findings: jsonb("findings").$type<GateFinding[]>().notNull().default(EMPTY_ARRAY),
  aiJobId: uuid("ai_job_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("qgate_article_idx").on(t.articleId, t.articleVersion),
  index("qgate_ws_idx").on(t.workspaceId),
]);

export interface ScoreComponent {
  key: string;
  label: string;
  weight: number;
  score: number;
  reasons: string[];
}

/** Per-component breakdown so the headline number is always explainable. */
export const articleScores = pgTable("article_scores", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  articleId: uuid("article_id").notNull().references(() => articles.id, { onDelete: "cascade" }),
  articleVersion: integer("article_version").notNull(),
  total: real("total").notNull(),
  components: jsonb("components").$type<ScoreComponent[]>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("ascore_article_version_uq").on(t.articleId, t.articleVersion)]);

// ─── Integrations & publishing (spec §11) ───────────────────────────────────

export const integrations = pgTable("integrations", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  scopeKey: text("scope_key").notNull().default("workspace"),
  provider: text("provider").notNull(),
  status: integrationStatus("status").notNull().default("connected"),
  externalAccountId: text("external_account_id"),
  displayName: text("display_name"),
  scopes: jsonb("scopes").$type<string[]>().notNull().default(EMPTY_ARRAY),
  /** AES-256-GCM sealed blob. Never returned to the browser (spec §11.1). */
  credentialSealed: text("credential_sealed"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  lastError: text("last_error"),
  connectedAt: timestamp("connected_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("integration_ws_provider_uq").on(t.workspaceId, t.provider, t.scopeKey)]);

export const publishJobs = pgTable("publish_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  integrationId: uuid("integration_id").references(() => integrations.id, { onDelete: "set null" }),
  articleVersion: integer("article_version"),
  targetFingerprint: text("target_fingerprint"),
  provider: text("provider").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: uuid("entity_id").notNull(),
  /** Guarantees at-most-once external side effects (spec §11.1, §12.1). */
  idempotencyKey: text("idempotency_key").notNull(),
  status: jobStatus("status").notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  externalId: text("external_id"),
  externalUrl: text("external_url"),
  lastError: text("last_error"),
  scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("pubjob_idem_uq").on(t.workspaceId, t.idempotencyKey),
  index("pubjob_ws_status_idx").on(t.workspaceId, t.status),
]);

// ─── AI observability (spec §5.2, §14.1) ────────────────────────────────────

export const aiJobs = pgTable("ai_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  correlationId: text("correlation_id").notNull(),
  taskAlias: text("task_alias").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  promptVersion: text("prompt_version").notNull(),
  status: jobStatus("status").notNull().default("queued"),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
  costMicros: bigint("cost_micros", { mode: "number" }).notNull().default(0),
  latencyMs: integer("latency_ms"),
  /** Which entry in the fallback chain actually served the request. */
  attemptIndex: integer("attempt_index").notNull().default(0),
  resultRef: text("result_ref"),
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, (t) => [
  index("aijob_ws_started_idx").on(t.workspaceId, t.startedAt),
  index("aijob_correlation_idx").on(t.correlationId),
]);

// ─── Analytics (spec §16) ───────────────────────────────────────────────────

export const metricSnapshots = pgTable("metric_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  source: text("source").notNull(),
  metric: text("metric").notNull(),
  date: timestamp("date", { withTimezone: true }).notNull(),
  value: real("value").notNull(),
  dimensions: jsonb("dimensions").$type<Record<string, string>>().notNull().default(EMPTY_OBJECT),
  ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("metric_ws_metric_date_idx").on(t.workspaceId, t.metric, t.date)]);

// ─── Audit (spec §15) ───────────────────────────────────────────────────────

export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  actorId: text("actor_id").notNull(),
  actorType: text("actor_type").notNull().default("user"),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id"),
  before: jsonb("before").$type<unknown>(),
  after: jsonb("after").$type<unknown>(),
  correlationId: text("correlation_id"),
  ip: text("ip"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("audit_ws_created_idx").on(t.workspaceId, t.createdAt),
  index("audit_entity_idx").on(t.entityType, t.entityId),
]);

// ─── Relations ──────────────────────────────────────────────────────────────

export const workspaceRelations = relations(workspaces, ({ one, many }) => ({
  owner: one(users, { fields: [workspaces.ownerId], references: [users.id] }),
  members: many(workspaceMembers),
  businesses: many(businesses),
}));

export const businessRelations = relations(businesses, ({ one, many }) => ({
  workspace: one(workspaces, { fields: [businesses.workspaceId], references: [workspaces.id] }),
  sources: many(businessSources),
  facts: many(businessFacts),
  locations: many(businessLocations),
  voices: many(brandVoices),
  keywords: many(keywords),
  topics: many(topics),
  articles: many(articles),
}));

export const articleRelations = relations(articles, ({ one, many }) => ({
  business: one(businesses, { fields: [articles.businessId], references: [businesses.id] }),
  topic: one(topics, { fields: [articles.topicId], references: [topics.id] }),
  revisions: many(articleRevisions),
  gates: many(qualityGateResults),
}));

// ─── Social Media Timeline ──────────────────────────────────────────────────

/**
 * Content pack for one post — the output of the writing prompt.
 *
 * Stored as jsonb rather than columns because the fields are a contract with a
 * prompt, not a query surface. Nothing filters on `altText`; it is read whole,
 * with the post, or not at all.
 *
 * `imageBrief` and `aiPrompt` are deliberately both here. The brief is
 * direction for a person ("no music bed under the first few seconds"); the
 * prompt is what an image model is given. One does not substitute for the
 * other, and keeping only the brief would mean rewriting it by hand every time
 * an image is generated.
 */
export interface SocialContentPack {
  caption: string;
  shortCaption: string;
  hashtags: string[];
  imageBrief: string;
  aiPrompt: string;
  altText: string;
  /** Carousel slides, reel script, or Q&A pairs. Empty for a single image. */
  formatExtra: string;
  /**
   * The words printed on the post image: headline, then subline.
   *
   * Optional because packs written before it existed only carry it inside the
   * image brief; readers fall back to parsing it from there.
   */
  imageText?: string;
  /** The post's picture, once one is generated or uploaded (step 4). */
  image?: PackImage;
  /** When and where it publishes, and what happened (step 5). */
  schedule?: PackSchedule;
}

export type SocialNetworkId = "facebook" | "instagram";

/**
 * A post's publishing: the time, the networks, and each network's outcome.
 *
 * Per network, because Facebook and Instagram succeed and fail separately,
 * and a retry must publish only where it has not already: posting the same
 * photo to a Page twice is the one failure worse than not posting.
 */
export interface PackSchedule {
  /** Bound destination; old schedules must be reviewed and rescheduled. */
  pageId?: string;
  instagramId?: string;
  /** ISO time it publishes. */
  at: string;
  networks: SocialNetworkId[];
  status: "scheduled" | "publishing" | "published" | "partial" | "failed";
  results: Partial<Record<SocialNetworkId, {
    status: "published" | "failed";
    /** The network's own id for the post. */
    id?: string;
    url?: string;
    error?: string;
    at: string;
  }>>;
}

/**
 * A post's picture and its review.
 *
 * Kept on the pack because it belongs to the copy it was made from: the
 * image text is printed on it. Rewriting the copy keeps the picture but sends
 * it back to draft, since its words may no longer match.
 */
export interface PackImage {
  /** Storage key, "<workspaceId>/<topicId>-<time>.<ext>". */
  key: string;
  mimeType: string;
  source: "generated" | "uploaded";
  status: "draft" | "approved";
  /** ISO time it was made. */
  createdAt: string;
  /** What the model was asked, so a regeneration can be compared with it. */
  prompt?: string;
  model?: string;
}

/**
 * A content category — one service line, holding its own pool of topics.
 *
 * The pool is built per category rather than per month because the categories
 * are what the business actually sells: a topic belongs to "Dementia Care"
 * permanently, and only borrows a date when a month picks it up. Building the
 * pool first also means a month's calendar is an editorial choice from stock,
 * not a fresh generation each time.
 */
export const socialCategories = pgTable("social_categories", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  /** What this category covers, used to steer topic generation. */
  description: text("description").notNull().default(""),
  /** Display order. Lower first. */
  position: integer("position").notNull().default(0),
  /** How many topics this category should hold. */
  targetCount: integer("target_count").notNull().default(16),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("social_cat_biz_name_uq").on(t.businessId, t.name),
  index("social_cat_ws_idx").on(t.workspaceId),
]);

/**
 * A planned month — the calendar, built by drawing from the topic pool.
 *
 * Created only once the pool exists. Format spread and audience balance are
 * properties of a set, so the month is assembled and tallied as a whole.
 */
export const socialMonths = pgTable("social_months", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  /** "2026-10". One plan per business per month. */
  monthKey: text("month_key").notNull(),
  status: socialMonthStatus("status").notNull().default("planning"),
  /** Day number → event names, joined with " · ". */
  calendarEvents: jsonb("calendar_events").$type<Record<string, string>>().notNull().default(EMPTY_OBJECT),
  monthLongObservances: jsonb("month_long_observances").$type<string[]>().notNull().default(EMPTY_ARRAY),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("social_month_biz_key_uq").on(t.businessId, t.monthKey),
  index("social_month_ws_idx").on(t.workspaceId, t.status),
]);

/**
 * One topic in the pool.
 *
 * Belongs to a category permanently; belongs to a month only once scheduled.
 * `monthId` is therefore nullable and `postDate` with it — an idea that has
 * not been picked up yet is the normal case, not an incomplete row.
 */
export const socialTopics = pgTable("social_topics", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  categoryId: uuid("category_id").notNull().references(() => socialCategories.id, { onDelete: "cascade" }),
  /** Set when a month's calendar schedules this topic. */
  monthId: uuid("month_id").references(() => socialMonths.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  /**
   * The argument the post makes, in prose — 60-90 words.
   *
   * Not a one-line brief: a reviewer approving 144 topics needs to see what
   * the post would actually say, because two topics can share a title and be
   * entirely different posts. This is also what the writing prompt works from.
   */
  hook: text("hook").notNull(),
  audience: text("audience").notNull(),
  format: text("format").notNull(),
  imageIdea: text("image_idea").notNull().default(""),
  /** Set when scheduled into a month. */
  postDate: timestamp("post_date", { withTimezone: true }),
  occasion: text("occasion"),
  /**
   * How a dated observance was derived, e.g. "2nd Thursday of the month".
   *
   * Recorded because observances fixed by a rule move every year, and reusing
   * last year's date is the likeliest error in this task. Showing the rule
   * lets a reviewer check it rather than trust it.
   */
  dateRule: text("date_rule"),
  /**
   * The model's own read of whether this belongs in the next month.
   *
   * A pool of 146 is more than anyone wants to rank by hand, so the generator
   * flags the ones it would pick. It is a suggestion and nothing reads it but
   * the UI: a recommendation cannot schedule a post, and a person can pick any
   * topic regardless.
   */
  recommended: boolean("recommended").notNull().default(false),
  /** Why it was recommended. Shown on hover rather than asserted silently. */
  recommendedWhy: text("recommended_why"),
  status: socialTopicStatus("status").notNull().default("idea"),
  /** Written copy. Null until the writing prompt has run for this topic. */
  pack: jsonb("pack").$type<SocialContentPack | null>(),
  imageUrl: text("image_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("social_topic_cat_idx").on(t.categoryId, t.status),
  index("social_topic_month_idx").on(t.monthId),
  index("social_topic_ws_idx").on(t.workspaceId),
]);

export const socialCategoriesRelations = relations(socialCategories, ({ one, many }) => ({
  business: one(businesses, { fields: [socialCategories.businessId], references: [businesses.id] }),
  topics: many(socialTopics),
}));

export const socialMonthsRelations = relations(socialMonths, ({ one, many }) => ({
  workspace: one(workspaces, { fields: [socialMonths.workspaceId], references: [workspaces.id] }),
  business: one(businesses, { fields: [socialMonths.businessId], references: [businesses.id] }),
  topics: many(socialTopics),
}));

export const socialTopicsRelations = relations(socialTopics, ({ one }) => ({
  category: one(socialCategories, { fields: [socialTopics.categoryId], references: [socialCategories.id] }),
  month: one(socialMonths, { fields: [socialTopics.monthId], references: [socialMonths.id] }),
}));

// ─── GMB reviews ────────────────────────────────────────────────────────────

/** Where a review was read from. */
/**
 * Where a review was read from, best first: Business Profile (all reviews,
 * replies post from here), Places API (latest five), the listing's public Maps
 * page (read by a browser, used only when neither API is available).
 */
export type ReviewSource = "gbp" | "places" | "maps" | "manual";

export interface GoogleListing {
  /** Google Places id: the public listing, readable with an API key. */
  placeId?: string;
  title?: string;
  address?: string;
  /** The listing on Google Maps, where replies can always be written by hand. */
  mapsUri?: string;
  /** The Google Maps link the customer gave, read by the browser crawler when no API is available. */
  mapsLink?: string;
  /** When the Maps page was last read, so it is read at most about once a day. */
  mapsReadAt?: string;
  /** "accounts/1/locations/2": the owner's listing in Business Profile, which replies post to. */
  gbpLocation?: string;
  gbpTitle?: string;
  rating?: number | null;
  reviewCount?: number | null;
  /** Which source the totals and reviews came from last. */
  source?: ReviewSource;
  syncedAt?: string;
  /** Why the last sync failed, in words a person can act on. */
  lastError?: string | null;
  /**
   * Business Profile, separately: "pending" while Google has not approved API
   * access, which is expected for weeks and not a failure of the sync.
   */
  gbpStatus?: "ok" | "pending" | "error";
  gbpError?: string | null;
}

/** The reply being prepared for one review. */
export interface ReviewReplyDraft {
  body: string;
  status: "draft" | "approved" | "posted" | "posted_by_hand";
  /**
   * The review is one a person must answer (a legal threat, an injury, a
   * one-star complaint). No reply is generated for it; the box starts empty.
   */
  requiresHumanEdit: boolean;
  withheldReason: string | null;
  /** Edited by a person since it was generated. */
  edited: boolean;
  model?: string;
  createdAt: string;
  updatedAt: string;
  postedAt?: string;
  error?: string | null;
}

/**
 * One Google review of a client, and the reply prepared for it.
 *
 * Keyed by Google's own id per source. Reviews read through the Places API
 * (at most five, and cached no longer than Google's terms allow) and through
 * Business Profile (all of them, repliable) have different ids, so the page
 * shows Business Profile's once it has any.
 */
export const gmbReviews = pgTable("gmb_reviews", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  source: text("source").$type<ReviewSource>().notNull(),
  externalId: text("external_id").notNull(),
  authorName: text("author_name").notNull().default(""),
  authorPhotoUrl: text("author_photo_url"),
  authorUrl: text("author_url"),
  rating: integer("rating").notNull(),
  /** Reviewers can leave stars and no words. */
  comment: text("comment"),
  languageCode: text("language_code"),
  reviewUrl: text("review_url"),
  publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
  editedAt: timestamp("edited_at", { withTimezone: true }),
  /** The reply already on Google, ours or anyone's. */
  googleReply: jsonb("google_reply").$type<{ comment: string; updatedAt: string } | null>(),
  draft: jsonb("draft").$type<ReviewReplyDraft | null>(),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("gmb_review_ext_uq").on(t.businessId, t.source, t.externalId),
  index("gmb_review_biz_idx").on(t.workspaceId, t.businessId, t.publishedAt),
]);

/** In-flight AI spend, reserved under the workspace lock before contacting a provider. */
export const aiReservations = pgTable("ai_reservations", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  costMicros: bigint("cost_micros", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("ai_reservation_workspace_idx").on(t.workspaceId, t.createdAt)]);
