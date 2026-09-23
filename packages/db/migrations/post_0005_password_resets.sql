-- Password reset tokens.
--
-- Hashed, never stored raw — a reset token is a temporary credential and a
-- database dump must not be enough to take over accounts. `used_at` marks a
-- spent token instead of deleting the row, so "already used" stays
-- distinguishable from "never existed".
CREATE TABLE IF NOT EXISTS "password_resets" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"      uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "token_hash"   text NOT NULL,
  "expires_at"   timestamptz NOT NULL,
  "used_at"      timestamptz,
  "requested_ip" text,
  "created_at"   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "pwreset_token_uq" ON "password_resets" ("token_hash");
CREATE INDEX IF NOT EXISTS "pwreset_user_idx" ON "password_resets" ("user_id");
