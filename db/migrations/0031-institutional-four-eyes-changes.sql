BEGIN;
SELECT pg_advisory_xact_lock(72626001);
CREATE TABLE IF NOT EXISTS institutional.change_proposals(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),asset_id uuid NOT NULL REFERENCES institutional.records(asset_id),revision integer NOT NULL,
 payload jsonb NOT NULL,proposed_by text NOT NULL,approved_by text,outcome text NOT NULL DEFAULT 'pending' CHECK(outcome IN ('pending','approved','rejected')),
 created_at timestamptz NOT NULL DEFAULT now(),decided_at timestamptz,
 CHECK(outcome='pending' OR (approved_by IS NOT NULL AND approved_by<>proposed_by AND decided_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS one_pending_change ON institutional.change_proposals(asset_id)WHERE outcome='pending';
GRANT SELECT,INSERT,UPDATE ON institutional.change_proposals TO pcm_app;
ALTER TABLE institutional.change_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE institutional.change_proposals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS transaction_scope ON institutional.change_proposals;
CREATE POLICY transaction_scope ON institutional.change_proposals USING(EXISTS(SELECT 1 FROM institutional.records r WHERE r.asset_id=change_proposals.asset_id))WITH CHECK(EXISTS(SELECT 1 FROM institutional.records r WHERE r.asset_id=change_proposals.asset_id));
CREATE OR REPLACE FUNCTION institutional.guard_decision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.outcome<>'pending' THEN RAISE EXCEPTION 'Final evidence decisions are immutable';END IF;
 IF NEW.proposed_by<>OLD.proposed_by OR NEW.asset_id<>OLD.asset_id OR NEW.revision<>OLD.revision THEN RAISE EXCEPTION 'Decision identity is immutable';END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['reviews','partners','change_proposals']LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='guard_decision_'||t AND tgrelid=('institutional.'||t)::regclass)THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON institutional.%I FOR EACH ROW EXECUTE FUNCTION institutional.guard_decision()','guard_decision_'||t,t);
  END IF;
 END LOOP;
END $$;
COMMIT;
