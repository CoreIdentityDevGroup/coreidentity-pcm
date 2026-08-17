// Phase 6.1 (SCRUB): fixture helpers for the negative-test suite. Every
// helper writes directly to the isolated local test database (see
// tests/env.setup.js) using the real schema (dumped from live
// production, zero production data ever touched).
'use strict';

const db = require('../api/services/db');

async function createClient(overrides = {}) {
  const result = await db.clients.query(
    `INSERT INTO pcm_clients (full_name, email, country_of_origin, pipeline_stage)
     VALUES ($1, $2, $3, $4) RETURNING client_id`,
    [
      overrides.full_name || 'Test Client',
      overrides.email || `test-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`,
      overrides.country_of_origin || 'United States',
      overrides.pipeline_stage || 'intake'
    ]
  );
  return result.rows[0].client_id;
}

async function createAsset(client_id, overrides = {}) {
  const pipeline_reference = overrides.pipeline_reference || `TEST-REF-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const result = await db.assets.query(
    `INSERT INTO pcm_assets (client_id, asset_type, declared_value, pipeline_stage, pipeline_reference)
     VALUES ($1, $2, $3, $4, $5) RETURNING asset_id`,
    [
      client_id,
      overrides.asset_type || 'real_estate',
      overrides.declared_value || 1000000,
      overrides.pipeline_stage || 'intake',
      pipeline_reference
    ]
  );
  return { asset_id: result.rows[0].asset_id, pipeline_reference };
}

async function addKycDocument(client_id) {
  await db.clients.query(
    `INSERT INTO pcm_kyc_documents
       (client_id, doc_type, gcs_bucket, gcs_object_path, file_name, submission_date, uploaded_by)
     VALUES ($1, 'passport', 'test-bucket', $2, 'passport.pdf', CURRENT_DATE, 'test-fixture')`,
    [client_id, `kyc/${client_id}/${Date.now()}.pdf`]
  );
}

async function addPofRecord(client_id) {
  const result = await db.clients.query(
    `INSERT INTO pcm_pof_records
       (client_id, declared_amount, issuing_bank, gcs_bucket, gcs_object_path, submission_date)
     VALUES ($1, 5000000, 'Test Bank', 'test-bucket', $2, CURRENT_DATE)
     RETURNING pof_id`,
    [client_id, `pof/${client_id}/${Date.now()}.pdf`]
  );
  return result.rows[0].pof_id;
}

// Replicates exactly what POST .../ofac/attest-out-of-band/:id/confirm
// produces (CLOSE-GAP-26) -- the only path, along with the manual_review
// dual-control override, that satisfies the kyc_verification gate's OFAC
// check after CLOSE-GAP-27's allowlist rewrite. Writing the fixture
// directly rather than calling the API mirrors the DB state a real
// confirmed attestation leaves behind.
async function confirmOfacAttestation(client_id) {
  const result = await db.clients.query(
    `INSERT INTO pcm_ofac_results
       (client_id, provider, status, raw_response_summary, reviewed_by, reviewed_at, review_outcome)
     VALUES ($1, 'OUT_OF_BAND_ATTESTATION', 'attested_out_of_band', 'fixture', 'fixture-principal-1', NOW(), 'ATTESTATION_CONFIRMED')
     RETURNING result_id`,
    [client_id]
  );
  await db.clients.query(
    `UPDATE pcm_clients SET ofac_status = 'attested_out_of_band', ofac_provider = 'OUT_OF_BAND_ATTESTATION', ofac_reference_id = $1
     WHERE client_id = $2`,
    [result.rows[0].result_id, client_id]
  );
}

// Replicates exactly what POST .../legal-attestation + PATCH
// .../legal-attestation/:id/countersign produces (2026-08-17
// access-control redesign) -- the only path that satisfies the
// kyc_verification gate's legal-review check. Writing the fixture
// directly rather than calling the API mirrors the DB state a real
// confirmed attestation leaves behind, same convention as
// confirmOfacAttestation above.
async function confirmLegalAttestation(client_id) {
  await db.clients.query(
    `INSERT INTO pcm_legal_attestations
       (client_id, counsel_name, review_date, reference, entered_by, status, countersigned_by, countersigned_at)
     VALUES ($1, 'Fixture Counsel', CURRENT_DATE, 'fixture-reference', 'fixture-principal-1', 'confirmed', 'fixture-principal-2', NOW())`,
    [client_id]
  );
}

async function addValuation(asset_id, overrides = {}) {
  await db.assets.query(
    `INSERT INTO pcm_valuations
       (asset_id, appraised_value, appraiser_name, appraisal_date, submission_date,
        date_validation_status, gcs_bucket, gcs_object_path)
     VALUES ($1, $2, 'Test Appraiser', CURRENT_DATE, CURRENT_DATE, $3, 'test-bucket', $4)`,
    [
      asset_id,
      overrides.appraised_value || 1000000,
      overrides.date_validation_status || 'passed',
      `valuations/${asset_id}/${Date.now()}.pdf`
    ]
  );
}

async function addAssetDocument(asset_id) {
  await db.assets.query(
    `INSERT INTO pcm_asset_documents
       (asset_id, doc_type, file_name, submission_date, gcs_bucket, gcs_object_path, uploaded_by)
     VALUES ($1, 'title_deed', 'title.pdf', CURRENT_DATE, 'test-bucket', $2, 'test-fixture')`,
    [asset_id, `assets/${asset_id}/${Date.now()}.pdf`]
  );
}

async function setInstrumentIntegrityVerified(asset_id) {
  await db.assets.query(
    `UPDATE pcm_assets SET instrument_integrity_status = 'verified' WHERE asset_id = $1`,
    [asset_id]
  );
}

async function setBankAssignment(asset_id, bank = 'Test Bank NA') {
  await db.assets.query(
    `UPDATE pcm_assets SET bank_assignment = $1, bank_assignment_date = NOW() WHERE asset_id = $2`,
    [bank, asset_id]
  );
}

async function addExecutedAgreement(asset_id, client_id, pipeline_reference, agreement_type) {
  await db.forms.query(
    `INSERT INTO pcm_agreements
       (asset_id, client_id, agreement_type, jurisdiction_type, pipeline_stage_required,
        status, gcs_bucket, gcs_object_path, file_name, pipeline_reference)
     VALUES ($1, $2, $3, 'us', 'collateralization', 'fully_executed', 'test-bucket', $4, 'agreement.pdf', $5)`,
    [asset_id, client_id, agreement_type, `agreements/${asset_id}/${agreement_type}-${Date.now()}.pdf`, pipeline_reference]
  );
}

async function mintClassificationToken(asset_id, client_id) {
  await db.assets.query(
    `INSERT INTO pcm_classification_tokens
       (asset_id, client_id, asset_type, verified_value, verification_date, issuing_authority,
        pipeline_reference, token_purpose, transferable, signature_algorithm, signature, signing_agent_id)
     VALUES ($1, $2, 'real_estate', 1000000, CURRENT_DATE, 'Test Appraiser', 'fixture-ref',
             'identification_and_verification_only', false, 'TEST-STUB', 'test-signature', 'test-fixture')
     RETURNING token_id`,
    [asset_id, client_id]
  );
  await db.assets.query(
    `UPDATE pcm_assets SET token_id = (SELECT token_id FROM pcm_classification_tokens WHERE asset_id = $1 LIMIT 1)
     WHERE asset_id = $1`,
    [asset_id]
  );
}

async function createStaff(overrides = {}) {
  const email = overrides.email || `test-staff-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  const result = await db.clients.query(
    `INSERT INTO pcm_staff (email, name, role, password_hash, active)
     VALUES ($1, $2, $3, crypt($4, gen_salt('bf', 4)), $5)
     RETURNING staff_id, email`,
    [
      email,
      overrides.name || 'Test Staff',
      overrides.role || 'intake_officer',
      overrides.password || 'original-password-123',
      overrides.active !== undefined ? overrides.active : true
    ]
  );
  return result.rows[0];
}

module.exports = {
  createClient, createAsset, addKycDocument, addPofRecord, confirmOfacAttestation,
  confirmLegalAttestation, addValuation, addAssetDocument, setInstrumentIntegrityVerified,
  setBankAssignment, addExecutedAgreement, mintClassificationToken, createStaff
};
