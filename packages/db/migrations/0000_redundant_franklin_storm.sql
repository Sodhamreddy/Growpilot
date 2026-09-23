CREATE TYPE "public"."article_status" AS ENUM('draft', 'generating', 'qa', 'needs_changes', 'awaiting_approval', 'approved', 'scheduled', 'published', 'failed');--> statement-breakpoint
CREATE TYPE "public"."auth_provider" AS ENUM('email', 'google');--> statement-breakpoint
CREATE TYPE "public"."crawl_status" AS ENUM('pending', 'running', 'succeeded', 'failed', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."gate_verdict" AS ENUM('pass', 'warn', 'fail');--> statement-breakpoint
CREATE TYPE "public"."integration_status" AS ENUM('connected', 'expired', 'revoked', 'error', 'paused');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('owner', 'admin', 'editor', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."plan_tier" AS ENUM('trial', 'starter', 'growth', 'agency');--> statement-breakpoint
CREATE TYPE "public"."search_intent" AS ENUM('informational', 'commercial', 'transactional', 'navigational', 'local');--> statement-breakpoint
CREATE TYPE "public"."topic_status" AS ENUM('idea', 'planned', 'briefed', 'drafting', 'review', 'approved', 'published', 'archived');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('pending', 'active', 'suspended');--> statement-breakpoint
CREATE TABLE "ai_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"correlation_id" text NOT NULL,
	"task_alias" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"latency_ms" integer,
	"attempt_index" integer DEFAULT 0 NOT NULL,
	"result_ref" text,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "article_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"article_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"body_markdown" text NOT NULL,
	"title" text NOT NULL,
	"authored_by" text NOT NULL,
	"ai_job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "article_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"article_id" uuid NOT NULL,
	"article_version" integer NOT NULL,
	"total" real NOT NULL,
	"components" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "articles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"topic_id" uuid,
	"title" text NOT NULL,
	"slug" text NOT NULL,
	"meta_title" text,
	"meta_description" text,
	"body_markdown" text DEFAULT '' NOT NULL,
	"schema_json_ld" jsonb,
	"status" "article_status" DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"seo_score" real,
	"voice_score" real,
	"word_count" integer DEFAULT 0 NOT NULL,
	"brand_voice_id" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"published_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"actor_type" text DEFAULT 'user' NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"before" jsonb,
	"after" jsonb,
	"correlation_id" text,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brand_voices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"profile" jsonb NOT NULL,
	"banned_terms" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"preferred_terms" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"samples" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approved_at" timestamp with time zone,
	"approved_by" uuid,
	"is_active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "business_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"source_url" text,
	"source_quote" text,
	"confidence" real DEFAULT 0.5 NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"superseded_by_id" uuid,
	"extracted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "business_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"label" text NOT NULL,
	"street_address" text,
	"locality" text,
	"region" text,
	"postal_code" text,
	"country" text,
	"phone" text,
	"source_url" text,
	"confidence" real DEFAULT 0.5 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "business_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"url" text NOT NULL,
	"canonical_url" text NOT NULL,
	"crawl_status" "crawl_status" DEFAULT 'pending' NOT NULL,
	"pages_discovered" integer DEFAULT 0 NOT NULL,
	"pages_fetched" integer DEFAULT 0 NOT NULL,
	"robots_allowed" boolean DEFAULT true NOT NULL,
	"last_crawled_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "businesses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"industry" text,
	"audience" text,
	"description" text,
	"usp" text,
	"primary_cta" text,
	"website_url" text,
	"confirmed_at" timestamp with time zone,
	"confirmed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"status" "integration_status" DEFAULT 'connected' NOT NULL,
	"external_account_id" text,
	"display_name" text,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"credential_sealed" text,
	"expires_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "keyword_clusters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"label" text NOT NULL,
	"primary_keyword_id" uuid,
	"intent" "search_intent",
	"total_volume" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "keywords" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"term" text NOT NULL,
	"intent" "search_intent",
	"volume" integer,
	"difficulty" real,
	"cpc_micros" integer,
	"location" text DEFAULT '' NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"cluster_id" uuid,
	"opportunity_score" real,
	"provider" text DEFAULT 'stub' NOT NULL,
	"refreshed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ref_id" uuid,
	"source_url" text,
	"heading" text,
	"content" text NOT NULL,
	"token_count" integer DEFAULT 0 NOT NULL,
	"embedding" vector(1536),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "metric_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source" text NOT NULL,
	"metric" text NOT NULL,
	"date" timestamp with time zone NOT NULL,
	"value" real NOT NULL,
	"dimensions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "publish_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"external_id" text,
	"external_url" text,
	"last_error" text,
	"scheduled_for" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quality_gate_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"article_id" uuid NOT NULL,
	"article_version" integer NOT NULL,
	"gate" text NOT NULL,
	"verdict" "gate_verdict" NOT NULL,
	"score" real,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ai_job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"active_workspace_id" uuid,
	"user_agent" text,
	"ip" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"url" text NOT NULL,
	"http_status" integer,
	"title" text,
	"meta_description" text,
	"canonical" text,
	"h1" text,
	"page_type" text,
	"word_count" integer DEFAULT 0 NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"headings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"json_ld" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"open_graph" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"internal_links" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "topics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"title" text NOT NULL,
	"primary_keyword_id" uuid,
	"secondary_terms" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"intent" "search_intent",
	"target_url" text,
	"priority" real DEFAULT 0 NOT NULL,
	"publish_date" timestamp with time zone,
	"status" "topic_status" DEFAULT 'idea' NOT NULL,
	"brief" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"email_normalized" text NOT NULL,
	"name" text,
	"auth_provider" "auth_provider" DEFAULT 'email' NOT NULL,
	"password_hash" text,
	"status" "user_status" DEFAULT 'pending' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_members" (
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "member_role" DEFAULT 'editor' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_members_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"locale" text DEFAULT 'en-US' NOT NULL,
	"plan" "plan_tier" DEFAULT 'trial' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ai_budget_micros" bigint DEFAULT 50000000 NOT NULL,
	"onboarding_step" text DEFAULT 'goals' NOT NULL,
	"onboarding_completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_jobs" ADD CONSTRAINT "ai_jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_revisions" ADD CONSTRAINT "article_revisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_revisions" ADD CONSTRAINT "article_revisions_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_scores" ADD CONSTRAINT "article_scores_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_scores" ADD CONSTRAINT "article_scores_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_brand_voice_id_brand_voices_id_fk" FOREIGN KEY ("brand_voice_id") REFERENCES "public"."brand_voices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_voices" ADD CONSTRAINT "brand_voices_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_voices" ADD CONSTRAINT "brand_voices_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_voices" ADD CONSTRAINT "brand_voices_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_facts" ADD CONSTRAINT "business_facts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_facts" ADD CONSTRAINT "business_facts_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_locations" ADD CONSTRAINT "business_locations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_locations" ADD CONSTRAINT "business_locations_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_sources" ADD CONSTRAINT "business_sources_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_sources" ADD CONSTRAINT "business_sources_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "keyword_clusters" ADD CONSTRAINT "keyword_clusters_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "keyword_clusters" ADD CONSTRAINT "keyword_clusters_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "keywords" ADD CONSTRAINT "keywords_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "keywords" ADD CONSTRAINT "keywords_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_snapshots" ADD CONSTRAINT "metric_snapshots_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_jobs" ADD CONSTRAINT "publish_jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_gate_results" ADD CONSTRAINT "quality_gate_results_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_gate_results" ADD CONSTRAINT "quality_gate_results_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_active_workspace_id_workspaces_id_fk" FOREIGN KEY ("active_workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_pages" ADD CONSTRAINT "source_pages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_pages" ADD CONSTRAINT "source_pages_source_id_business_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."business_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_primary_keyword_id_keywords_id_fk" FOREIGN KEY ("primary_keyword_id") REFERENCES "public"."keywords"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "aijob_ws_started_idx" ON "ai_jobs" USING btree ("workspace_id","started_at");--> statement-breakpoint
CREATE INDEX "aijob_correlation_idx" ON "ai_jobs" USING btree ("correlation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "arev_article_version_uq" ON "article_revisions" USING btree ("article_id","version");--> statement-breakpoint
CREATE INDEX "arev_ws_idx" ON "article_revisions" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ascore_article_version_uq" ON "article_scores" USING btree ("article_id","article_version");--> statement-breakpoint
CREATE INDEX "article_ws_status_idx" ON "articles" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "article_biz_slug_uq" ON "articles" USING btree ("business_id","slug");--> statement-breakpoint
CREATE INDEX "audit_ws_created_idx" ON "audit_logs" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "audit_logs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "voice_ws_idx" ON "brand_voices" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "voice_biz_version_uq" ON "brand_voices" USING btree ("business_id","version");--> statement-breakpoint
CREATE INDEX "bfact_ws_biz_idx" ON "business_facts" USING btree ("workspace_id","business_id");--> statement-breakpoint
CREATE INDEX "bfact_key_idx" ON "business_facts" USING btree ("business_id","key");--> statement-breakpoint
CREATE INDEX "bloc_ws_idx" ON "business_locations" USING btree ("workspace_id","business_id");--> statement-breakpoint
CREATE INDEX "bsrc_ws_idx" ON "business_sources" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bsrc_biz_url_uq" ON "business_sources" USING btree ("business_id","canonical_url");--> statement-breakpoint
CREATE INDEX "businesses_ws_idx" ON "businesses" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_ws_provider_uq" ON "integrations" USING btree ("workspace_id","provider");--> statement-breakpoint
CREATE INDEX "kcluster_ws_idx" ON "keyword_clusters" USING btree ("workspace_id","business_id");--> statement-breakpoint
CREATE INDEX "kw_ws_biz_idx" ON "keywords" USING btree ("workspace_id","business_id");--> statement-breakpoint
CREATE UNIQUE INDEX "kw_biz_term_loc_uq" ON "keywords" USING btree ("business_id","term","location");--> statement-breakpoint
CREATE INDEX "kchunk_ws_biz_idx" ON "knowledge_chunks" USING btree ("workspace_id","business_id");--> statement-breakpoint
CREATE INDEX "metric_ws_metric_date_idx" ON "metric_snapshots" USING btree ("workspace_id","metric","date");--> statement-breakpoint
CREATE UNIQUE INDEX "pubjob_idem_uq" ON "publish_jobs" USING btree ("workspace_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "pubjob_ws_status_idx" ON "publish_jobs" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "qgate_article_idx" ON "quality_gate_results" USING btree ("article_id","article_version");--> statement-breakpoint
CREATE INDEX "qgate_ws_idx" ON "quality_gate_results" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_uq" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "spage_ws_idx" ON "source_pages" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "spage_source_url_uq" ON "source_pages" USING btree ("source_id","url");--> statement-breakpoint
CREATE INDEX "topic_ws_status_idx" ON "topics" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "topic_biz_idx" ON "topics" USING btree ("business_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_norm_uq" ON "users" USING btree ("email_normalized");--> statement-breakpoint
CREATE INDEX "wm_user_idx" ON "workspace_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_slug_uq" ON "workspaces" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "workspaces_owner_idx" ON "workspaces" USING btree ("owner_id");