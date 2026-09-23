CREATE TYPE "public"."social_month_status" AS ENUM('planning', 'planned', 'writing', 'written', 'failed');--> statement-breakpoint
CREATE TYPE "public"."social_topic_status" AS ENUM('planned', 'slated', 'rejected', 'written', 'approved', 'published');--> statement-breakpoint
CREATE TABLE "password_resets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"requested_ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "social_months" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"month_key" text NOT NULL,
	"status" "social_month_status" DEFAULT 'planning' NOT NULL,
	"calendar_events" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"month_long_observances" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rejected" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "social_topics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"month_id" uuid NOT NULL,
	"title" text NOT NULL,
	"brief" text NOT NULL,
	"audience" text NOT NULL,
	"format" text NOT NULL,
	"post_date" timestamp with time zone,
	"occasion" text,
	"date_rule" text,
	"image_idea" text,
	"slate_reason" text,
	"status" "social_topic_status" DEFAULT 'planned' NOT NULL,
	"pack" jsonb,
	"image_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "business_sources" ADD COLUMN "brand_colors" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "business_sources" ADD COLUMN "sitemap_urls" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "logo_url" text;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "gmb_name" text;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "social_profiles" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "keywords" ADD COLUMN "relevance" real;--> statement-breakpoint
ALTER TABLE "password_resets" ADD CONSTRAINT "password_resets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_months" ADD CONSTRAINT "social_months_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_months" ADD CONSTRAINT "social_months_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_topics" ADD CONSTRAINT "social_topics_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_topics" ADD CONSTRAINT "social_topics_month_id_social_months_id_fk" FOREIGN KEY ("month_id") REFERENCES "public"."social_months"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pwreset_token_uq" ON "password_resets" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "pwreset_user_idx" ON "password_resets" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "social_month_biz_key_uq" ON "social_months" USING btree ("business_id","month_key");--> statement-breakpoint
CREATE INDEX "social_month_ws_idx" ON "social_months" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "social_topic_month_idx" ON "social_topics" USING btree ("month_id","status");--> statement-breakpoint
CREATE INDEX "social_topic_ws_idx" ON "social_topics" USING btree ("workspace_id");