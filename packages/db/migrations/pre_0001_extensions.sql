-- Runs before the generated schema migration.
-- pgvector backs the knowledge base retrieval layer (spec §4, §19).
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
