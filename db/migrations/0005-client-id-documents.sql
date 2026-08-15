-- SDN sanctions screening design (docs/SDN-Sanctions-Screening-Design.md),
-- intake changes section.
--
-- New table for structured ID-document capture. OFAC's SDN idList gives
-- real passport/national-ID numbers to compare against (confirmed live in
-- the ingested schema) -- there was previously no structured way to
-- capture a client's own ID number at all, only unstructured KYC document
-- *files* (pcm_kyc_documents, metadata about an uploaded file, not
-- extracted structured fields). This table carries both: the structured
-- fields a future matching tier could compare directly, and file-vault
-- metadata mirroring pcm_kyc_documents' existing pattern exactly (same
-- gcs_bucket/gcs_object_path signed-URL upload convention, same
-- vault_status lifecycle) so it plugs into the existing document-handling
-- conventions rather than inventing a new one.
--
-- Not currently read by any matching tier (exact/near-exact this pass are
-- name-string tiers) -- this is intake-side capture so the data exists
-- when a future tier needs it, per the same "schema changes are nearly
-- free with one test client" reasoning as migration 0004.

CREATE TABLE IF NOT EXISTS pcm_client_id_documents (
  id_doc_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        uuid NOT NULL REFERENCES pcm_clients(client_id) ON DELETE RESTRICT,
  doc_type         text NOT NULL,   -- 'passport' | 'national_id' | 'drivers_license'
  id_number        text NOT NULL,
  issuing_country  text NOT NULL,
  expiry_date      date,
  gcs_bucket       text,
  gcs_object_path  text,
  file_name        text,
  content_type     text,
  vault_status     pcm_vault_status NOT NULL DEFAULT 'active',
  uploaded_at      timestamptz NOT NULL DEFAULT now(),
  uploaded_by      text NOT NULL,
  deleted_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT id_doc_gcs_path_unique UNIQUE (gcs_bucket, gcs_object_path)
);

CREATE INDEX IF NOT EXISTS idx_pcm_client_id_docs_client ON pcm_client_id_documents (client_id);
CREATE INDEX IF NOT EXISTS idx_pcm_client_id_docs_vault_status ON pcm_client_id_documents (vault_status);
