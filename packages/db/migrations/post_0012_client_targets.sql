ALTER TABLE workspace_members ADD COLUMN IF NOT EXISTS selected_business_id uuid REFERENCES businesses(id) ON DELETE SET NULL;
UPDATE workspace_members m SET selected_business_id = b.id
FROM workspaces w JOIN businesses b ON b.workspace_id = w.id AND b.id::text = w.settings->'onboarding'->>'businessId'
WHERE m.workspace_id = w.id AND m.selected_business_id IS NULL;
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS scope_key text NOT NULL DEFAULT 'workspace';
DROP INDEX IF EXISTS integration_ws_provider_uq;
CREATE UNIQUE INDEX integration_ws_provider_uq ON integrations(workspace_id, provider, scope_key);
ALTER TABLE publish_jobs ADD COLUMN IF NOT EXISTS integration_id uuid REFERENCES integrations(id) ON DELETE SET NULL;
ALTER TABLE publish_jobs ADD COLUMN IF NOT EXISTS article_version integer;
-- Preserve legacy connections, but require explicit reconnection to each client.
-- Existing queued work cannot be assigned a destination safely by inference.
UPDATE publish_jobs SET status='failed', last_error='Reconnect WordPress for this client and request a new publish.' WHERE provider='wordpress' AND status='queued' AND integration_id IS NULL;
