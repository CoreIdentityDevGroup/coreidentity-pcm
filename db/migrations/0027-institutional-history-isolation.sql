BEGIN;
SELECT pg_advisory_xact_lock(72626001);
CREATE TABLE IF NOT EXISTS institutional.transaction_access(
 asset_id uuid NOT NULL REFERENCES institutional.records(asset_id),subject text NOT NULL,active boolean NOT NULL DEFAULT true,
 PRIMARY KEY(asset_id,subject)
);
GRANT SELECT ON institutional.transaction_access TO pcm_app;
CREATE TABLE IF NOT EXISTS institutional.record_versions(
 sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,asset_id uuid NOT NULL,revision integer NOT NULL,payload jsonb NOT NULL,recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION institutional.snapshot_record() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO institutional.record_versions(asset_id,revision,payload) VALUES(NEW.asset_id,NEW.revision,to_jsonb(NEW));RETURN NEW;
END $$;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='snapshot_record' AND tgrelid='institutional.records'::regclass) THEN
 CREATE TRIGGER snapshot_record AFTER INSERT OR UPDATE ON institutional.records FOR EACH ROW EXECUTE FUNCTION institutional.snapshot_record();
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='immutable_record_versions' AND tgrelid='institutional.record_versions'::regclass) THEN
 CREATE TRIGGER immutable_record_versions BEFORE UPDATE OR DELETE OR TRUNCATE ON institutional.record_versions FOR EACH STATEMENT EXECUTE FUNCTION institutional.deny_mutation();
 END IF;
END $$;
GRANT INSERT,SELECT ON institutional.record_versions TO pcm_app;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA institutional TO pcm_app;
-- Baseline imported records also receive a snapshot; no history is rewritten.
INSERT INTO institutional.record_versions(asset_id,revision,payload)
SELECT r.asset_id,r.revision,to_jsonb(r) FROM institutional.records r
WHERE NOT EXISTS(SELECT 1 FROM institutional.record_versions v WHERE v.asset_id=r.asset_id);
CREATE OR REPLACE FUNCTION institutional.guard_legacy_asset() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM institutional.records WHERE asset_id=OLD.asset_id) THEN
 RAISE EXCEPTION 'Institutional asset: legacy mutation prohibited'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;RETURN NEW;
END $$;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='institutional_legacy_guard' AND tgrelid='public.pcm_assets'::regclass) THEN
 CREATE TRIGGER institutional_legacy_guard BEFORE UPDATE OR DELETE ON public.pcm_assets FOR EACH ROW EXECUTE FUNCTION institutional.guard_legacy_asset();
 END IF;
END $$;
COMMIT;
