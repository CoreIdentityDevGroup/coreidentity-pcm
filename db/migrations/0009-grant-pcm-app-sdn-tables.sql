-- Follow-up to 0005/0006, caught before first real ingestion run: the four
-- new tables (created while connected as pcm_admin to apply the earlier
-- migrations) had zero grants to pcm_app -- confirmed live via
-- information_schema.role_table_grants before writing this, not assumed.
-- Without this, the runtime app (ofac-screening agent, the intake route,
-- and the ingestion script when it runs as the app role in CI) would get
-- permission-denied on every query against these tables.
--
-- Granted narrowly -- INSERT + SELECT only, matching Phase 3.5's
-- established discipline for this codebase (pcm_agent_activity: pcm_app
-- gets exactly what application code paths use, not blanket privileges).
-- None of these tables are ever UPDATEd or DELETEd by any code path in
-- this pass (SDN reference tables are append-only versioned snapshots;
-- pcm_client_id_documents has no PATCH/DELETE route, mirroring
-- pcm_kyc_documents which also exposes only POST+GET).

GRANT INSERT, SELECT ON pcm_sdn_list_versions TO pcm_app;
GRANT INSERT, SELECT ON pcm_sdn_entries TO pcm_app;
GRANT INSERT, SELECT ON pcm_sdn_aliases TO pcm_app;
GRANT INSERT, SELECT ON pcm_client_id_documents TO pcm_app;
