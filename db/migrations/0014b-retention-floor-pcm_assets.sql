-- Run against the pcm_assets database. Pairs with
-- 0014a-retention-floor-pcm_clients.sql -- see that file's header for
-- the full design rationale (floor semantics, no-existing-deletion-path
-- context, GCS/soft-delete/test-archive scope notes). This file only
-- covers pcm_assets -- the KYC/POF/OFAC/attestation tables in 0014a all
-- live in the pcm_clients database.
--
-- Function is redefined here rather than shared across databases because
-- Postgres functions, like tables, are database-local -- there is no
-- cross-database function reference any more than there's a
-- cross-database foreign key (same constraint noted in 0013a/0013b).
CREATE OR REPLACE FUNCTION enforce_one_year_retention() RETURNS trigger AS $$
DECLARE
  age_column text := TG_ARGV[0];
  record_created timestamptz;
BEGIN
  EXECUTE format('SELECT ($1).%I', age_column) INTO record_created USING OLD;
  IF record_created > now() - interval '1 year' THEN
    RAISE EXCEPTION 'Retention floor: % row is % old (created %), below the 1-year regulatory minimum -- deletion blocked',
      TG_TABLE_NAME, age(now(), record_created), record_created
      USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_retention_floor_pcm_assets
  BEFORE DELETE ON pcm_assets
  FOR EACH ROW EXECUTE FUNCTION enforce_one_year_retention('created_at');
