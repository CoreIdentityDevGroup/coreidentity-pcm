BEGIN;
SELECT pg_advisory_xact_lock(72626001);
-- Subject is set only from a verified IdP token by the server, transaction-locally.
-- Tenant memberships and transaction grants remain administrator-owned.
ALTER TABLE institutional.records ENABLE ROW LEVEL SECURITY;
ALTER TABLE institutional.records FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS record_scope ON institutional.records;
CREATE POLICY record_scope ON institutional.records USING (
 EXISTS(SELECT 1 FROM institutional.memberships m WHERE m.subject=current_setting('institutional.subject',true) AND m.tenant_id=records.tenant_id AND m.active
 AND (m.role IN ('compliance','legal','admin','auditor') OR EXISTS(SELECT 1 FROM institutional.transaction_access a WHERE a.asset_id=records.asset_id AND a.subject=m.subject AND a.active)))
) WITH CHECK (
 EXISTS(SELECT 1 FROM institutional.memberships m WHERE m.subject=current_setting('institutional.subject',true) AND m.tenant_id=records.tenant_id AND m.active AND m.role IN ('compliance','legal','admin','intermediary'))
);
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['documents','reviews','partners','record_versions','manifests'] LOOP
  EXECUTE format('ALTER TABLE institutional.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE institutional.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('DROP POLICY IF EXISTS transaction_scope ON institutional.%I',t);
  EXECUTE format('CREATE POLICY transaction_scope ON institutional.%I USING (EXISTS(SELECT 1 FROM institutional.records r WHERE r.asset_id=%I.asset_id)) WITH CHECK(EXISTS(SELECT 1 FROM institutional.records r WHERE r.asset_id=%I.asset_id))',t,t,t);
 END LOOP;
END $$;
-- PII bytes are separately authorized by vault routes. PII metadata is also restricted here.
DROP POLICY IF EXISTS pii_scope ON institutional.documents;
CREATE POLICY pii_scope ON institutional.documents AS RESTRICTIVE USING (
 category NOT IN ('kyc','kyb','pof') OR EXISTS(SELECT 1 FROM institutional.records r JOIN institutional.memberships m ON m.tenant_id=r.tenant_id WHERE r.asset_id=documents.asset_id AND m.subject=current_setting('institutional.subject',true) AND m.active AND m.role IN ('compliance','legal'))
);
ALTER TABLE institutional.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE institutional.events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_event_scope ON institutional.events;
CREATE POLICY tenant_event_scope ON institutional.events USING (
 EXISTS(SELECT 1 FROM institutional.memberships m WHERE m.tenant_id=events.tenant_id AND m.subject=current_setting('institutional.subject',true) AND m.active)
) WITH CHECK(actor=current_setting('institutional.subject',true) AND EXISTS(SELECT 1 FROM institutional.memberships m WHERE m.tenant_id=events.tenant_id AND m.subject=current_setting('institutional.subject',true) AND m.active));
COMMIT;
