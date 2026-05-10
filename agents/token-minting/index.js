'use strict';

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
