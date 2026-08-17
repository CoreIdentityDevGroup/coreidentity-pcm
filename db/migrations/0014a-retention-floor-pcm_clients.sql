-- One-year retention FLOOR (regulatory minimum -- do not delete before,
-- not a purge-after requirement) on legal attestations and everything
-- they attest to. Run against the pcm_clients database. Pairs with
-- 0014b-retention-floor-pcm_assets.sql (pcm_assets database) -- one
-- logical policy split across the two physical databases these tables
-- live in, same reason 0013a/0013b were split.
--
-- SCOPE: an attestation retained past the records it attests to protects
-- nothing, so the floor covers pcm_legal_attestations AND everything the
-- kyc_verification gate already depends on: pcm_clients, KYC documents,
-- POF records, OFAC results (pcm_assets covered separately in 0014b).
--
-- PCM HAS NO DELETION PATH FOR THESE RECORDS TODAY -- confirmed by
-- grepping the entire application for `DELETE FROM`: zero hits. This
-- migration is therefore NOT retrofitting a guard onto existing
-- behavior; it is preventing a FUTURE deletion path from violating the
-- floor before one is ever written. Enforced at the database level (a
-- trigger), not the application level, deliberately: an app-layer check
-- only protects whichever route remembers to call it; a trigger protects
-- against any DELETE regardless of how it's attempted (a future route
-- that forgets the check, direct psql access, a maintenance script).
--
-- OUT OF SCOPE, noted rather than silently ignored: this protects the
-- Postgres rows. It does not and cannot protect the underlying GCS
-- objects (KYC/POF documents' actual files) from deletion via a direct
-- GCS API call bypassing the app entirely -- that would need its own,
-- separate enforcement (GCS bucket lifecycle/retention policy or object
-- lock), not something a Postgres trigger can reach.
--
-- SOFT DELETE IS OUT OF SCOPE, deliberately: pcm_clients already has a
-- deleted_at column, set via UPDATE (see routes/clients.js's DELETE
-- route), not a real DELETE -- the row and its data remain fully present
-- and recoverable. That's a visibility/business-state change, not data
-- loss, so it isn't what a retention floor needs to guard against. This
-- migration only blocks actual row deletion (DELETE FROM), not that
-- UPDATE. If a future requirement needs the floor to also block
-- reversing deleted_at to null past some point, or the reverse, that's a
-- distinct policy question, not addressed here.
--
-- TEST-DATA ARCHIVE INTERACTION (REMAINING-WORK-QUEUE.md 5.4, spec
-- written/unexecuted): that archive is for synthetic/test-provenance
-- contamination, a different mechanism from this floor entirely. Real
-- attestation rows (and the real records they reference) are explicitly
-- OUT OF SCOPE for that archive -- whoever builds it must exclude real
-- records by an explicit test-provenance marker, not by inferring "old"
-- means "test." A record protected by this floor that got swept into
-- that archive by an "old rows" heuristic would violate the floor this
-- migration exists to enforce.
CREATE OR REPLACE FUNCTION enforce_one_year_retention() RETURNS trigger AS $$
DECLARE
  age_column text := TG_ARGV[0];
  record_created timestamptz;
BEGIN
  EXECUTE format('SELECT ($1).%I', age_column) INTO record_created USING OLD;
  IF record_created > now() - interval '1 year' THEN
    RAISE EXCEPTION 'Retention floor: % row is % old (created %), below the 1-year regulatory minimum -- deletion blocked',
      TG_TABLE_NAME, age(now(), record_created), record_created
      USING ERRCODE = '23514'; -- check_violation -- same class an app would get from a failed CHECK constraint
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_retention_floor_pcm_clients
  BEFORE DELETE ON pcm_clients
  FOR EACH ROW EXECUTE FUNCTION enforce_one_year_retention('created_at');

CREATE TRIGGER trg_retention_floor_pcm_kyc_documents
  BEFORE DELETE ON pcm_kyc_documents
  FOR EACH ROW EXECUTE FUNCTION enforce_one_year_retention('created_at');

CREATE TRIGGER trg_retention_floor_pcm_pof_records
  BEFORE DELETE ON pcm_pof_records
  FOR EACH ROW EXECUTE FUNCTION enforce_one_year_retention('created_at');

CREATE TRIGGER trg_retention_floor_pcm_ofac_results
  BEFORE DELETE ON pcm_ofac_results
  FOR EACH ROW EXECUTE FUNCTION enforce_one_year_retention('created_at');

-- entered_at, not created_at -- pcm_legal_attestations' own creation
-- timestamp column (see db/migrations/0011).
CREATE TRIGGER trg_retention_floor_pcm_legal_attestations
  BEFORE DELETE ON pcm_legal_attestations
  FOR EACH ROW EXECUTE FUNCTION enforce_one_year_retention('entered_at');
