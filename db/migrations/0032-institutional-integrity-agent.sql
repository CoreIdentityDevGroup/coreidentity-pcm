BEGIN;
SELECT pg_advisory_xact_lock(72626001);
CREATE TABLE IF NOT EXISTS institutional.integrity_screenings(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),asset_id uuid NOT NULL REFERENCES institutional.records(asset_id),revision integer NOT NULL,
 record_hash text NOT NULL,engine_hash text NOT NULL,result jsonb NOT NULL,created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(asset_id,revision),CHECK(result->>'status' IN ('blocked','pending_human_verification'))
);
GRANT SELECT,INSERT ON institutional.integrity_screenings TO pcm_app;
ALTER TABLE institutional.integrity_screenings ENABLE ROW LEVEL SECURITY;
ALTER TABLE institutional.integrity_screenings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS transaction_scope ON institutional.integrity_screenings;
CREATE POLICY transaction_scope ON institutional.integrity_screenings USING(EXISTS(SELECT 1 FROM institutional.records r WHERE r.asset_id=integrity_screenings.asset_id)) WITH CHECK(EXISTS(SELECT 1 FROM institutional.records r WHERE r.asset_id=integrity_screenings.asset_id));
DROP TRIGGER IF EXISTS immutable_integrity_screenings ON institutional.integrity_screenings;
CREATE TRIGGER immutable_integrity_screenings BEFORE UPDATE OR DELETE OR TRUNCATE ON institutional.integrity_screenings FOR EACH STATEMENT EXECUTE FUNCTION institutional.deny_mutation();
ALTER TABLE institutional.reviews ADD COLUMN IF NOT EXISTS integrity_attestation jsonb;
-- Evidence identity/content must not change during an approval, for any review type.
CREATE OR REPLACE FUNCTION institutional.guard_integrity_review() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='UPDATE' AND (to_jsonb(NEW)-ARRAY['outcome','approved_by','reviewed_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['outcome','approved_by','reviewed_at']) THEN RAISE EXCEPTION 'Review evidence is immutable'; END IF;
 IF NEW.check_name='instrument_integrity' AND (
  NEW.integrity_attestation IS NULL OR
  COALESCE(NEW.integrity_attestation->>'independent_channel','')<>'true' OR
  length(COALESCE(NEW.integrity_attestation->>'source',''))<10 OR
  length(COALESCE(NEW.integrity_attestation->>'note',''))<20 OR
  NOT EXISTS(SELECT 1 FROM institutional.integrity_screenings s WHERE s.id::text=NEW.integrity_attestation->>'screening_id' AND s.asset_id=NEW.asset_id AND s.revision=NEW.revision AND s.result->>'status'='pending_human_verification')
 ) THEN RAISE EXCEPTION 'Current nonblocked screening and independent channel evidence required'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS guard_integrity_review ON institutional.reviews;
CREATE TRIGGER guard_integrity_review BEFORE INSERT OR UPDATE ON institutional.reviews FOR EACH ROW EXECUTE FUNCTION institutional.guard_integrity_review();
COMMIT;
