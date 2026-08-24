-- Asset-level package-handler assignment. Run against the pcm_assets
-- database.
--
-- CORRECTED 2026-08-24: this migration originally shipped as
-- "0013b-legal-attestation-assignment-pcm_assets.sql", paired with a
-- 0013a that added the same columns' cross-database counterpart to
-- pcm_legal_attestations. Legal attestation was removed entirely in this
-- session (CoreG reviews its own documentation -- there is no external
-- counsel review to record; see the addendum documenting this
-- correction) -- 0013a is deleted, not superseded, since neither file was
-- ever deployed. These columns survive on their own merits: which
-- Intake Officer or Program Manager is carrying a given package is a
-- real, independently useful piece of state, not a byproduct of the
-- legal-review mechanic that used to write it. The write path is now
-- POST /assets/:id/assign (api/routes/assets.js) -- self-referential,
-- same constraint the old legal-attestation entry route had:
-- assigned_handler_role/assigned_handler_staff_id come from req.user,
-- never the request body, so a caller cannot claim an assignment on
-- someone else's behalf.
--
-- Live ownership pointer, queryable -- api/services/pipeline.js's
-- checkRoleAuthority reads it on every stage-authority check to grant
-- the assigned handler access regardless of that stage's own gate_roles
-- (additive, not exclusive -- see checkRoleAuthority's header comment).
-- Nullable: most assets have no assigned handler until someone claims
-- the package.
--
-- assigned_handler_staff_id is a plain uuid, NOT a foreign key -- pcm_assets
-- lives in the pcm_assets database, pcm_staff lives in pcm_clients.
-- Postgres has no cross-database foreign keys.
ALTER TABLE pcm_assets
  ADD COLUMN assigned_handler_role text
    CHECK (assigned_handler_role IS NULL OR assigned_handler_role = ANY (ARRAY['facilitator', 'program_manager', 'intake_officer'])),
  ADD COLUMN assigned_handler_staff_id uuid;

CREATE INDEX IF NOT EXISTS idx_pcm_assets_assigned_handler
  ON pcm_assets (assigned_handler_staff_id) WHERE assigned_handler_staff_id IS NOT NULL;

-- No new GRANT needed -- pcm_app already holds table-wide UPDATE on
-- pcm_assets (confirmed live).
