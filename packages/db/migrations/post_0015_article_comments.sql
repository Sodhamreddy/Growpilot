CREATE TABLE IF NOT EXISTS article_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  article_id uuid NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  author_id uuid REFERENCES users(id) ON DELETE SET NULL,
  author_name text NOT NULL,
  article_version integer NOT NULL CHECK (article_version > 0),
  quote text NOT NULL CHECK (char_length(quote) BETWEEN 1 AND 3000),
  prefix text NOT NULL DEFAULT '' CHECK (char_length(prefix) <= 64),
  suffix text NOT NULL DEFAULT '' CHECK (char_length(suffix) <= 64),
  start_offset integer NOT NULL CHECK (start_offset >= 0),
  end_offset integer NOT NULL CHECK (end_offset > start_offset),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS article_comment_ws_article_idx ON article_comments(workspace_id, article_id, created_at);

CREATE TABLE IF NOT EXISTS article_comment_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  article_id uuid NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  comment_id uuid NOT NULL REFERENCES article_comments(id) ON DELETE CASCADE,
  author_id uuid REFERENCES users(id) ON DELETE SET NULL,
  author_name text NOT NULL,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS article_comment_reply_ws_article_idx ON article_comment_replies(workspace_id, article_id, created_at);
