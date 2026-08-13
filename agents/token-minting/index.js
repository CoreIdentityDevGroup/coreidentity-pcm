'use strict';

// CLOSE-GAP-23 (Phase 3.3): SUPERSEDED / DEAD. This module has no reachable
// call site (was only invoked via api/routes/assets.js's
// _unwiredStageAdvanceTriggers(), which had zero callers and has now had
// this branch removed entirely). Even if wired, it would not satisfy the
// completed-stage gate: it writes to pcm_asset_documents, never
// pcm_classification_tokens or pcm_assets.token_id. Canonical tokenization
// is api/services/pipeline.js's triggerTokenization(), wired into
// advancePipeline(). Kept in the tree for reference only -- do not wire
// this module up without first replacing its DB writes to match the real
// pcm_classification_tokens schema.

async function execute(context) {
  const { asset_id, client_id, pipeline_reference, appraised_value, 
          currency, bank_assignment, db } = context;

  const token_id = `TKN-${pipeline_reference}-${Date.now()}`;

  const token_payload = {
    token_id,
    asset_id,
    client_id,
    pipeline_reference,
    appraised_value:  parseFloat(appraised_value),
    currency,
    bank_assignment,
    minted_at:        new Date().toISOString(),
    standard:         'CoreIdentity-TKN-v1',
    governance:       'AIS-governed',
    signing_algorithm:'ML-DSA-65'
  };

  // Log token minting event
  if (db) {
    await db.assets.query(
      `INSERT INTO pcm_asset_documents 
         (asset_id, doc_type, file_name, submission_date, 
          gcs_bucket, gcs_object_path, uploaded_by)
       VALUES ($1, $2, $3, CURRENT_DATE, $4, $5, $6)`,
      [
        asset_id,
        'governance_token',
        `${token_id}.json`,
        'system',
        `tokens/${client_id}/${token_id}.json`,
        'token-minting-agent'
      ]
    );
  }

  return {
    status:        'minted',
    token_id,
    token_payload,
    action:        'COMPLETE_PIPELINE',
    message:       `Governance token minted: ${token_id}`
  };
}

module.exports = { execute };
