-- Persist the per-keyword relevance judgement.
--
-- Without a keyword data provider, opportunity_score is null for every term,
-- and the content planner was substituting a constant for it — which handed
-- the entire ranking to the intent label and let low-value long-tail terms
-- outrank a business's core commercial terms. Relevance is derived from the
-- business's own pages and is always available, so it is the fallback ranking.
ALTER TABLE "keywords" ADD COLUMN IF NOT EXISTS "relevance" real;
