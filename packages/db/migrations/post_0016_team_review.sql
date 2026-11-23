-- Team review: review teams, teammate invites and per-level sign-offs.
-- New tables only, so the app keeps working unchanged until a workspace switches team review on.

CREATE TABLE IF NOT EXISTS workspace_team_members (
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  team text NOT NULL CHECK (team IN ('content', 'manager')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id, team),
  FOREIGN KEY (workspace_id, user_id) REFERENCES workspace_members(workspace_id, user_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS workspace_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email text NOT NULL CHECK (char_length(email) BETWEEN 3 AND 320),
  email_normalized text NOT NULL,
  role member_role NOT NULL DEFAULT 'editor' CHECK (role <> 'owner'),
  teams jsonb NOT NULL DEFAULT '[]'::jsonb,
  token_hash text NOT NULL,
  invited_by uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS workspace_invites_token_uq ON workspace_invites(token_hash);
CREATE INDEX IF NOT EXISTS workspace_invites_ws_email_idx ON workspace_invites(workspace_id, email_normalized);

CREATE TABLE IF NOT EXISTS article_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  article_id uuid NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  article_version integer NOT NULL CHECK (article_version > 0),
  step text NOT NULL CHECK (step IN ('content', 'manager')),
  decision text NOT NULL CHECK (decision IN ('approved', 'changes_requested')),
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  note text CHECK (note IS NULL OR char_length(note) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS article_reviews_article_idx ON article_reviews(workspace_id, article_id, article_version, created_at);
