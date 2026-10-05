-- GMB reviews: which Google listing is each client's, and the reviews read from it.
--
-- Written to be safe to run on a database whose migration history is behind its
-- tables: every statement checks before it creates.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS google_listing jsonb;

CREATE TABLE IF NOT EXISTS gmb_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  source text NOT NULL,
  external_id text NOT NULL,
  author_name text NOT NULL DEFAULT '',
  author_photo_url text,
  author_url text,
  rating integer NOT NULL,
  comment text,
  language_code text,
  review_url text,
  published_at timestamptz NOT NULL,
  edited_at timestamptz,
  google_reply jsonb,
  draft jsonb,
  synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS gmb_review_ext_uq ON gmb_reviews (business_id, source, external_id);
CREATE INDEX IF NOT EXISTS gmb_review_biz_idx ON gmb_reviews (workspace_id, business_id, published_at);
