-- Details a customer supplies rather than the crawler discovering them.
--
-- Logo, Google Business Profile name and social channels are rarely present in
-- a site's markup in any reliable form, so onboarding cannot extract them and
-- they need somewhere to be entered by hand. gmb_name is deliberately separate
-- from name: a listing registered as "Kleza Solutions Pvt Ltd" while the site
-- says "Kleza" is the normal case, not the exception.
ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "logo_url" text;
ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "gmb_name" text;
ALTER TABLE "businesses"
  ADD COLUMN IF NOT EXISTS "social_profiles" jsonb NOT NULL DEFAULT '[]'::jsonb;
