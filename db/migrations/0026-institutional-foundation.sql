-- Assets database only. Administrator migration role; application must not own tables.
-- Additive and idempotent. No existing records automatically become approved.
BEGIN;
SELECT pg_advisory_xact_lock(72626001);
CREATE SCHEMA IF NOT EXISTS institutional;
CREATE TABLE IF NOT EXISTS institutional.memberships (
 subject text NOT NULL, tenant_id uuid NOT NULL, role text NOT NULL CHECK(role IN ('client','intermediary','compliance','verifier','legal','admin','auditor')),
 active boolean NOT NULL DEFAULT true, PRIMARY KEY(subject,tenant_id)
);
CREATE TABLE IF NOT EXISTS institutional.schemas (
 family text NOT NULL, version integer NOT NULL CHECK(version>0), specification jsonb NOT NULL,
 active boolean NOT NULL DEFAULT false, proposed_by text NOT NULL, approved_by text,
 CHECK(NOT active OR (approved_by IS NOT NULL AND approved_by<>proposed_by)), PRIMARY KEY(family,version)
);
CREATE TABLE IF NOT EXISTS institutional.records (
 asset_id uuid PRIMARY KEY REFERENCES public.pcm_assets(asset_id), tenant_id uuid NOT NULL,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0), schema_version integer NOT NULL, asset_family text NOT NULL,
 payload jsonb NOT NULL, stage text NOT NULL DEFAULT 'intake', legal_hold boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(asset_family,schema_version) REFERENCES institutional.schemas(family,version),
 CHECK(stage IN ('intake','kyc_verification','collateralization','appraisal_review','monetization','securitization','tokenization','completed'))
);
CREATE TABLE IF NOT EXISTS institutional.reviews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), asset_id uuid NOT NULL REFERENCES institutional.records(asset_id),
 revision integer NOT NULL, check_name text NOT NULL, proposed_by text NOT NULL, approved_by text,
 outcome text NOT NULL CHECK(outcome IN ('pending','approved','rejected')), evidence_document_id uuid NOT NULL,
 reviewed_at timestamptz, expires_at timestamptz NOT NULL,
 CHECK(outcome<>'approved' OR (approved_by IS NOT NULL AND approved_by<>proposed_by AND reviewed_at IS NOT NULL)),
 UNIQUE(asset_id,revision,check_name)
);
CREATE TABLE IF NOT EXISTS institutional.partners (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), asset_id uuid NOT NULL REFERENCES institutional.records(asset_id),
 revision integer NOT NULL, payload jsonb NOT NULL, proposed_by text NOT NULL, approved_by text,
 outcome text NOT NULL DEFAULT 'pending' CHECK(outcome IN ('pending','approved','rejected')),
 evidence_document_id uuid NOT NULL, reviewed_at timestamptz, expires_at timestamptz NOT NULL,
 CHECK(outcome<>'approved' OR (approved_by IS NOT NULL AND approved_by<>proposed_by AND reviewed_at IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS institutional.documents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), asset_id uuid NOT NULL REFERENCES institutional.records(asset_id),
 document_key text NOT NULL, version integer NOT NULL CHECK(version>0), category text NOT NULL,
 storage_path text NOT NULL UNIQUE, storage_generation text NOT NULL, sha256 text NOT NULL CHECK(length(sha256)=64),
 mime_type text NOT NULL, size_bytes integer NOT NULL CHECK(size_bytes>0 AND size_bytes<=20971520),
 scan_provider text NOT NULL, scan_reference text NOT NULL, scan_status text NOT NULL CHECK(scan_status='clean'),
 uploaded_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(asset_id,document_key,version)
);
CREATE TABLE IF NOT EXISTS institutional.events (
 sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL, asset_id uuid,
 actor text NOT NULL, action text NOT NULL, payload jsonb NOT NULL, previous_hash text NOT NULL, event_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS institutional.manifests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), asset_id uuid NOT NULL REFERENCES institutional.records(asset_id),
 revision integer NOT NULL, payload jsonb NOT NULL, sha256 text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION institutional.deny_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Append-only evidence cannot be modified or removed'; END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['documents','events','manifests'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='immutable_'||t AND tgrelid=('institutional.'||t)::regclass) THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE OR TRUNCATE ON institutional.%I FOR EACH STATEMENT EXECUTE FUNCTION institutional.deny_mutation()', 'immutable_'||t,t);
  END IF;
 END LOOP;
END $$;
-- Runtime membership provisioning and schema activation belong to a separate administrator.
REVOKE ALL ON SCHEMA institutional FROM PUBLIC;
GRANT USAGE ON SCHEMA institutional TO pcm_app;
GRANT SELECT ON institutional.memberships, institutional.schemas TO pcm_app;
GRANT SELECT, INSERT, UPDATE ON institutional.records, institutional.reviews, institutional.partners TO pcm_app;
GRANT SELECT, INSERT ON institutional.documents, institutional.events, institutional.manifests TO pcm_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA institutional TO pcm_app;
-- Administrative owner must be independent of runtime role.
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='institutional' AND tableowner='pcm_app') THEN
  RAISE EXCEPTION 'Run migration with independent administrator, not pcm_app';
 END IF;
END $$;
COMMIT;
