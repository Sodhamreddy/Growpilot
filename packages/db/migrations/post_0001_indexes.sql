-- Runs after the generated schema migration.

-- Approximate-nearest-neighbour index for RAG retrieval (spec §4.1).
-- `lists` ≈ sqrt(rows); 100 suits up to ~1M chunks. Re-tune with REINDEX as
-- the corpus grows. Cosine distance matches the normalised embeddings we store.
CREATE INDEX IF NOT EXISTS kchunk_embedding_ivfflat
  ON knowledge_chunks USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- Trigram index for keyword term search in the Keywords module.
CREATE INDEX IF NOT EXISTS kw_term_trgm ON keywords USING gin (term gin_trgm_ops);

-- Partial index: the Home "Attention" panel reads only unfinished publish jobs.
CREATE INDEX IF NOT EXISTS pubjob_pending_idx
  ON publish_jobs (workspace_id, scheduled_for)
  WHERE status IN ('queued', 'running');

-- Partial index: approval queue (spec §10.1 Attention).
CREATE INDEX IF NOT EXISTS article_awaiting_idx
  ON articles (workspace_id, updated_at DESC)
  WHERE status = 'awaiting_approval';
