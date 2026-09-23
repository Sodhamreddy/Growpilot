-- Brand colours detected during the crawl.
--
-- Detection needs the raw HTML, which only exists inside the crawler: the
-- stored `source_pages.text` has already had markup stripped, so colour can
-- never be recovered from it. The crawl writes the merged site palette here.
ALTER TABLE "business_sources"
  ADD COLUMN IF NOT EXISTS "brand_colors" jsonb NOT NULL DEFAULT '[]'::jsonb;
