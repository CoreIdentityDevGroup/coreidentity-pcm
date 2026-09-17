BEGIN;
SELECT pg_advisory_xact_lock(72626001);
-- Non-sensitive append-only marker: legacy writers cannot evade the guard by omitting tenant context.
CREATE TABLE IF NOT EXISTS institutional.legacy_locks(asset_id uuid PRIMARY KEY);
GRANT SELECT,INSERT ON institutional.legacy_locks TO pcm_app;
INSERT INTO institutional.legacy_locks(asset_id)SELECT asset_id FROM institutional.records ON CONFLICT DO NOTHING;
CREATE OR REPLACE FUNCTION institutional.snapshot_record() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO institutional.legacy_locks(asset_id)VALUES(NEW.asset_id)ON CONFLICT DO NOTHING;
 INSERT INTO institutional.record_versions(asset_id,revision,payload)VALUES(NEW.asset_id,NEW.revision,to_jsonb(NEW));RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION institutional.guard_legacy_asset() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM institutional.legacy_locks WHERE asset_id=OLD.asset_id) THEN RAISE EXCEPTION 'Institutional asset: legacy mutation prohibited';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION institutional.guard_schema_version() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.family<>OLD.family OR NEW.version<>OLD.version OR NEW.specification<>OLD.specification OR NEW.proposed_by<>OLD.proposed_by THEN
 RAISE EXCEPTION 'Create a new schema version; existing specification is immutable'; END IF;RETURN NEW;
END $$;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='immutable_legacy_locks' AND tgrelid='institutional.legacy_locks'::regclass)THEN
 CREATE TRIGGER immutable_legacy_locks BEFORE UPDATE OR DELETE OR TRUNCATE ON institutional.legacy_locks FOR EACH STATEMENT EXECUTE FUNCTION institutional.deny_mutation();END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='guard_schema_version' AND tgrelid='institutional.schemas'::regclass)THEN
 CREATE TRIGGER guard_schema_version BEFORE UPDATE ON institutional.schemas FOR EACH ROW EXECUTE FUNCTION institutional.guard_schema_version();END IF;
END $$;
COMMIT;
