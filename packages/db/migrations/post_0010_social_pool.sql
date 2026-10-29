-- Preserve existing monthly topics while adopting the category pool.
ALTER TYPE social_topic_status ADD VALUE IF NOT EXISTS 'idea';
ALTER TYPE social_topic_status ADD VALUE IF NOT EXISTS 'scheduled';
CREATE TABLE IF NOT EXISTS social_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  position integer NOT NULL DEFAULT 0,
  target_count integer NOT NULL DEFAULT 16,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS social_cat_biz_name_uq ON social_categories(business_id, name);
CREATE INDEX IF NOT EXISTS social_cat_ws_idx ON social_categories(workspace_id);
ALTER TABLE social_topics ADD COLUMN IF NOT EXISTS category_id uuid REFERENCES social_categories(id) ON DELETE CASCADE;
ALTER TABLE social_topics ADD COLUMN IF NOT EXISTS hook text;
ALTER TABLE social_topics ADD COLUMN IF NOT EXISTS recommended boolean NOT NULL DEFAULT false;
ALTER TABLE social_topics ADD COLUMN IF NOT EXISTS recommended_why text;
INSERT INTO social_categories (workspace_id, business_id, name)
SELECT DISTINCT m.workspace_id, m.business_id, 'Existing topics'
FROM social_months m JOIN social_topics t ON t.month_id = m.id
WHERE t.category_id IS NULL ON CONFLICT DO NOTHING;
UPDATE social_topics t SET category_id = c.id
FROM social_months m JOIN social_categories c ON c.business_id = m.business_id AND c.name = 'Existing topics'
WHERE t.month_id = m.id AND t.category_id IS NULL;
-- The legacy brief is retained for compatibility, but no longer required.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='social_topics' AND column_name='brief') THEN
    UPDATE social_topics SET hook = COALESCE(hook, brief, title);
    ALTER TABLE social_topics ALTER COLUMN brief DROP NOT NULL;
  END IF;
END $$;
UPDATE social_topics SET hook = title WHERE hook IS NULL;
UPDATE social_topics SET image_idea = '' WHERE image_idea IS NULL;
ALTER TABLE social_topics ALTER COLUMN hook SET NOT NULL;
ALTER TABLE social_topics ALTER COLUMN category_id SET NOT NULL;
ALTER TABLE social_topics ALTER COLUMN month_id DROP NOT NULL;
ALTER TABLE social_topics ALTER COLUMN image_idea SET DEFAULT '';
ALTER TABLE social_topics ALTER COLUMN image_idea SET NOT NULL;
ALTER TABLE social_topics DROP CONSTRAINT IF EXISTS social_topics_month_id_social_months_id_fk;
ALTER TABLE social_topics ADD CONSTRAINT social_topics_month_id_social_months_id_fk FOREIGN KEY(month_id) REFERENCES social_months(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS social_topic_cat_idx ON social_topics(category_id, status);
