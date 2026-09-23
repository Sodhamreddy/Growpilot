-- Which Facebook Page each client's insights come from.
--
-- One Meta connection can administer pages for many unrelated businesses, so
-- the connection alone cannot say whose numbers are whose. Nullable because
-- "not chosen yet" has to be distinguishable from a choice: the sync skips a
-- client with no page rather than defaulting to the first one and attributing
-- another business's audience to it.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS meta_page_id text;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS meta_page_name text;
