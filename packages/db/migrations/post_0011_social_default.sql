-- New enum values must be committed before being used by a default.
ALTER TABLE social_topics ALTER COLUMN status SET DEFAULT 'idea';

UPDATE social_topics SET status = CASE WHEN month_id IS NULL THEN 'idea'::social_topic_status ELSE 'scheduled'::social_topic_status END WHERE status::text IN ('planned','slated');
