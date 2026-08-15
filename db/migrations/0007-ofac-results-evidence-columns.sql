-- SDN sanctions screening design (docs/SDN-Sanctions-Screening-Design.md),
-- piece 5 (evidence).
--
-- "A clear result must be reconstructible later" -- given a result_id,
-- must be able to reconstruct the exact list version used, what was
-- compared, and which tier fired, without re-fetching OFAC or trusting a
-- log line. Additive columns on the existing pcm_ofac_results table
-- (unchanged for every row written before this migration -- all nullable).
--
-- match_score is unused until the fuzzy tier ships (explicitly deferred,
-- see design doc) -- added now so that fast-follow is an application
-- change, not another migration.

ALTER TABLE pcm_ofac_results ADD COLUMN IF NOT EXISTS list_version_id uuid REFERENCES pcm_sdn_list_versions(version_id);
ALTER TABLE pcm_ofac_results ADD COLUMN IF NOT EXISTS match_method text CHECK (match_method IS NULL OR match_method IN ('exact','near_exact','fuzzy'));
ALTER TABLE pcm_ofac_results ADD COLUMN IF NOT EXISTS match_score numeric;
ALTER TABLE pcm_ofac_results ADD COLUMN IF NOT EXISTS compared_fields jsonb;

CREATE INDEX IF NOT EXISTS idx_pcm_ofac_results_list_version ON pcm_ofac_results (list_version_id);
