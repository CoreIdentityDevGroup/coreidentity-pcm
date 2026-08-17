-- Password reset (self-service "forgot password" + admin-triggered reset).
-- Design doc: this migration matches the reported design -- see the
-- password-reset design report in this session's history for the full
-- reasoning; summarized here for anyone reading only the schema later.
--
-- Single mechanism, two entry points (self-service vs admin-triggered),
-- distinguished only by initiated_by being null vs an admin identity --
-- see api/services/passwordReset.js.
--
-- token_hash, never the raw token: the raw token exists only in memory
-- during generation and in the email sent to the user. If this table were
-- ever exposed (backup leak, read-replica misconfiguration, etc.), a
-- sha256 hash is useless to an attacker without the original 256-bit
-- random value; storing the raw token would let anyone with DB read
-- access complete any outstanding reset.
--
-- Single-use via used_at (not row deletion): keeping the row after use is
-- deliberate -- it's queryable state, not the audit trail (that's
-- pcm_agent_activity, written separately by the application code, not by
-- this table). A completed/expired row still answers "was this token ever
-- valid" without needing to correlate against a separate log.
CREATE TABLE IF NOT EXISTS pcm_password_reset_tokens (
  token_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id     uuid NOT NULL REFERENCES pcm_staff(staff_id) ON DELETE CASCADE,
  token_hash   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  -- null = self-service (user requested their own reset).
  -- non-null = admin-triggered; holds the initiating admin's email.
  initiated_by text
);

-- Every token lookup at reset-completion time is by hash, never staff_id --
-- this must be fast and must not leak existence via a slow sequential scan.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pcm_password_reset_tokens_hash
  ON pcm_password_reset_tokens (token_hash);

-- "Invalidate prior unused tokens for this staff_id" (both on a new
-- request and on successful use) needs this to not be a sequential scan.
CREATE INDEX IF NOT EXISTS idx_pcm_password_reset_tokens_staff_active
  ON pcm_password_reset_tokens (staff_id) WHERE used_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON pcm_password_reset_tokens TO pcm_app;
