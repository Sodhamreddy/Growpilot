-- URLs a site declares in its sitemap.
--
-- Retained separately from source_pages because a sitemap is often readable
-- when page fetching is not — a blocked crawl still yields a usable list of
-- internal link targets, which is what the article generator needs.
ALTER TABLE "business_sources"
  ADD COLUMN IF NOT EXISTS "sitemap_urls" jsonb NOT NULL DEFAULT '[]'::jsonb;
