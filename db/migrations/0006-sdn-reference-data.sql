-- SDN sanctions screening design (docs/SDN-Sanctions-Screening-Design.md),
-- pieces 1 (ingestion) and 3 (matching).
--
-- Storage for OFAC's actual SDN list, ingested from
-- https://sanctionslistservice.ofac.treas.gov/api/download/sdn.xml
-- (verified live 2026-08-15 -- see design doc for the endpoint
-- verification and why basic XML was chosen over CSV/Advanced XML).
--
-- This is public U.S. Treasury reference data, not client PII -- lives in
-- the same pcm_clients database as the rest of OFAC screening machinery
-- (ofac-screening agent already runs against this pool) rather than a new
-- database, but namespaced pcm_sdn_* to stay distinguishable from
-- operational pcm_* client tables.
--
-- pcm_sdn_list_versions: one row per ingested publication. publish_date
-- comes from the file's own <Publish_Date> field, NOT retrieved_at --
-- these are different facts (the freshness gate in the design doc is
-- explicit about measuring off publish_date, since retrieved_at only
-- proves we succeeded at fetching, not that the list itself is current).
-- Every fetch attempt is recorded, success or failure, so a silently
-- broken ingestion job is visible rather than just going quiet.
--
-- pcm_sdn_entries: one row per sdnEntry (Individual/Entity/Vessel/
-- Aircraft). name_normalized is NFKD-folded/case-folded/punctuation-
-- stripped for the exact tier; name_canonical additionally runs the
-- transliteration-equivalence table for the near-exact tier. Both
-- precomputed at ingest time so matching stays an indexed lookup, not a
-- runtime transform -- see design doc's explicit choice to keep near-exact
-- deterministic rather than score-based.
--
-- pcm_sdn_aliases: one row per akaList entry per SDN entry. `category`
-- ('strong'|'weak') is OFAC's own reliability signal on the alias,
-- carried through unmodified -- not something this system invented.

CREATE TABLE IF NOT EXISTS pcm_sdn_list_versions (
  version_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  publish_date    date NOT NULL,
  record_count    integer,
  retrieved_at    timestamptz NOT NULL DEFAULT now(),
  fetch_status    text NOT NULL DEFAULT 'success' CHECK (fetch_status IN ('success','failed')),
  fetch_error     text,
  source_url      text NOT NULL,
  file_sha256     text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pcm_sdn_versions_publish_date ON pcm_sdn_list_versions (publish_date DESC);
CREATE INDEX IF NOT EXISTS idx_pcm_sdn_versions_retrieved_at ON pcm_sdn_list_versions (retrieved_at DESC);

CREATE TABLE IF NOT EXISTS pcm_sdn_entries (
  entry_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id          uuid NOT NULL REFERENCES pcm_sdn_list_versions(version_id) ON DELETE CASCADE,
  sdn_uid              integer NOT NULL,  -- OFAC's own <uid>, stable across publications
  sdn_type             text NOT NULL,      -- Individual | Entity | Vessel | Aircraft
  first_name           text,
  last_name            text NOT NULL,
  program_list         jsonb,
  dob_list             jsonb,
  id_list              jsonb,
  address_list         jsonb,
  name_normalized      text NOT NULL,
  name_canonical       text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pcm_sdn_entries_version ON pcm_sdn_entries (version_id);
CREATE INDEX IF NOT EXISTS idx_pcm_sdn_entries_normalized ON pcm_sdn_entries (version_id, name_normalized);
CREATE INDEX IF NOT EXISTS idx_pcm_sdn_entries_canonical ON pcm_sdn_entries (version_id, name_canonical);
CREATE INDEX IF NOT EXISTS idx_pcm_sdn_entries_uid ON pcm_sdn_entries (version_id, sdn_uid);

CREATE TABLE IF NOT EXISTS pcm_sdn_aliases (
  alias_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id         uuid NOT NULL REFERENCES pcm_sdn_entries(entry_id) ON DELETE CASCADE,
  version_id       uuid NOT NULL REFERENCES pcm_sdn_list_versions(version_id) ON DELETE CASCADE,
  alias_type       text,             -- OFAC's <type>, e.g. "a.k.a."
  category         text,             -- OFAC's own reliability signal: 'strong' | 'weak'
  first_name       text,
  last_name        text NOT NULL,
  name_normalized  text NOT NULL,
  name_canonical   text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pcm_sdn_aliases_version ON pcm_sdn_aliases (version_id);
CREATE INDEX IF NOT EXISTS idx_pcm_sdn_aliases_normalized ON pcm_sdn_aliases (version_id, name_normalized);
CREATE INDEX IF NOT EXISTS idx_pcm_sdn_aliases_canonical ON pcm_sdn_aliases (version_id, name_canonical);
CREATE INDEX IF NOT EXISTS idx_pcm_sdn_aliases_entry ON pcm_sdn_aliases (entry_id);
