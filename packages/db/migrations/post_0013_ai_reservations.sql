CREATE TABLE IF NOT EXISTS ai_reservations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 cost_micros bigint NOT NULL CHECK(cost_micros >= 0),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_reservation_workspace_idx ON ai_reservations(workspace_id, created_at);
