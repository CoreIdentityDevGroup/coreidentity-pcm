-- Run against the pcm_clients database. Pairs with
-- 0013b-legal-attestation-assignment-pcm_assets.sql, which must run
-- against the pcm_assets database -- these two files are one logical
-- change split across the two physical databases pcm_legal_attestations
-- and pcm_assets live in (see api/services/db.js's 4 distinct Pools;
-- Postgres has no cross-database foreign keys or transactions, so this
-- can't be one file or one transaction).
--
-- Corrected legal-review flow (supersedes the entry/countersign role
-- assumptions in 0011, which is already live in prod as an empty,
-- unread table -- see CLAIMS-INVENTORY addendum documenting this
-- correction). Legal decides WHO handles the package (by asset type and
-- expertise), not just THAT it was reviewed -- the attestation now
-- records that assignment, and package ownership becomes tracked
-- directly on pcm_assets (0013b) so subsequent stage gates can check it
-- without joining through attestation history every time.
--
-- Asset-scoped, not client-scoped: a client can hold multiple assets of
-- different types, each potentially routed to a different handler.
-- pcm_legal_attestations gains asset_id; the kyc_verification gate's
-- lookup narrows from client_id alone to (client_id, asset_id).
--
-- asset_id is a plain uuid, NOT a foreign key: pcm_legal_attestations
-- lives in the pcm_clients database, pcm_assets is a physically separate
-- database -- Postgres has no cross-database foreign keys. Same reason
-- pcm_assets.client_id already has no FK to pcm_clients (confirmed in
-- the live schema) -- this matches that existing, established pattern,
-- not a new gap. Referential integrity for asset_id is
-- application-enforced only (routes/assets.js's ownAsset lookup pattern
-- validates the asset exists before referencing it).
ALTER TABLE pcm_legal_attestations
  ADD COLUMN asset_id uuid;

-- assigned_staff_id -> pcm_staff IS a same-database reference
-- (pcm_legal_attestations and pcm_staff both live in pcm_clients) --
-- a real FK, unlike asset_id above.
--
-- assigned_role allows 'administrator' too, not just program_manager/
-- intake_officer -- confirmed explicitly: an Administrator may submit
-- the entry route (superset rule), and with exactly two staff accounts
-- today (both Administrator), rejecting that would make this feature
-- unusable until non-admin accounts exist. An Administrator personally
-- handling a package is a normal scenario at this company's current
-- size, not a design flaw to guard against.
ALTER TABLE pcm_legal_attestations
  ADD COLUMN assigned_role text
    CHECK (assigned_role = ANY (ARRAY['administrator', 'program_manager', 'intake_officer'])),
  ADD COLUMN assigned_staff_id uuid REFERENCES pcm_staff(staff_id);

-- NOT NULL added as a separate step after the columns exist -- table is
-- empty in prod (confirmed live before this migration), so there's no
-- backfill concern, but writing it this way is still the safer pattern
-- (matches this file's own convention of not assuming empty tables stay
-- empty by the time a migration runs).
ALTER TABLE pcm_legal_attestations ALTER COLUMN asset_id SET NOT NULL;
ALTER TABLE pcm_legal_attestations ALTER COLUMN assigned_role SET NOT NULL;
ALTER TABLE pcm_legal_attestations ALTER COLUMN assigned_staff_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pcm_legal_attestations_asset
  ON pcm_legal_attestations (asset_id);
