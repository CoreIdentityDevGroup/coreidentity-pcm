-- Run against the pcm_assets database. Pairs with
-- 0013a-legal-attestation-assignment-pcm_clients.sql -- see that file's
-- header for the full design rationale.
--
-- Live ownership pointer -- separate from pcm_legal_attestations'
-- historical record on purpose. The attestation row (pcm_clients
-- database) is immutable audit trail; these columns are the current,
-- queryable "who owns this asset right now" that
-- api/services/pipeline.js's checkRoleAuthority reads on every
-- stage-authority check. Nullable: most assets have no assigned handler
-- until legal review happens.
--
-- assigned_handler_role allows 'administrator' too, matching 0013a's
-- assigned_role -- an Administrator may be the assigned handler
-- (confirmed explicitly; with exactly two staff accounts today, both
-- Administrator, this keeps the feature usable). Note this column isn't
-- actually read for authorization logic -- checkRoleAuthority's
-- owner-based check compares assigned_handler_staff_id to the caller's
-- staff_id only, not this role value, since an assigned Administrator
-- already passes every gate via the isAdministrator check that runs
-- first. This column exists for display/audit legibility, matching
-- pcm_legal_attestations.assigned_role, not because the gate logic
-- consults it.
--
-- assigned_handler_staff_id is a plain uuid, NOT a foreign key -- pcm_assets
-- lives in the pcm_assets database, pcm_staff lives in pcm_clients.
-- Same cross-database reasoning as 0013a's asset_id.
ALTER TABLE pcm_assets
  ADD COLUMN assigned_handler_role text
    CHECK (assigned_handler_role IS NULL OR assigned_handler_role = ANY (ARRAY['administrator', 'program_manager', 'intake_officer'])),
  ADD COLUMN assigned_handler_staff_id uuid;

CREATE INDEX IF NOT EXISTS idx_pcm_assets_assigned_handler
  ON pcm_assets (assigned_handler_staff_id) WHERE assigned_handler_staff_id IS NOT NULL;

-- No new GRANT needed -- pcm_app already holds table-wide UPDATE on
-- pcm_assets (confirmed live), unlike pcm_legal_attestations/
-- pcm_password_reset_tokens which needed explicit grants as new tables.
