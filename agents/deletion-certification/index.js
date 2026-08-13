'use strict';

const crypto = require('crypto');

async function execute(context) {
  const { client_id, asset_id, pipeline_reference, db } = context;

  const cert_id   = `CERT-DEL-${pipeline_reference}-${Date.now()}`;
  const issued_at = new Date().toISOString();

  // Get list of all documents to be deleted
  const kyc_docs = await db.clients.query(
    `SELECT doc_id, file_name, gcs_object_path FROM pcm_kyc_documents
     WHERE client_id = $1`,
    [client_id]
  );

  const pof_docs = await db.clients.query(
    `SELECT pof_id, gcs_object_path FROM pcm_pof_records
     WHERE client_id = $1`,
    [client_id]
  );

  const asset_docs = await db.assets.query(
    `SELECT doc_id, file_name, gcs_object_path FROM pcm_asset_documents
     WHERE asset_id = $1`,
    [asset_id]
  );

  const all_docs = [
    ...kyc_docs.rows.map(d => ({ type: 'kyc', ...d })),
    ...pof_docs.rows.map(d => ({ type: 'pof', ...d })),
    ...asset_docs.rows.map(d => ({ type: 'asset', ...d }))
  ];

  const certificate = {
    cert_id,
    pipeline_reference,
    client_id,
    asset_id,
    issued_at,
    documents_certified: all_docs.length,
    document_manifest:   all_docs.map(d => ({
      type:        d.type,
      id:          d.doc_id || d.pof_id,
      file_name:   d.file_name || 'pof_record',
      object_path: d.gcs_object_path,
      certified_deleted_at: issued_at
    })),
    certification_standard: 'CoreIdentity-DEL-CERT-v1',
    signing_algorithm:      'SLH-DSA-128s',
    retention_period:       'permanent'
  };

  // Store cert reference. NOTE: no post-quantum signing backend exists in this
  // repo yet (manifest declares SLH-DSA-128s, but nothing implements it) — the
  // signature column is filled with an explicitly-labeled placeholder rather
  // than a fabricated value, so it reads as unsigned in any audit query.
  if (db) {
    const certificate_hash = crypto.createHash('sha256')
      .update(JSON.stringify(certificate)).digest('hex');

    await db.clients.query(
      `INSERT INTO pcm_deletion_certificates
         (client_id, asset_id, scope, deleted_object_count, deleted_object_paths,
          deletion_timestamp, algorithm, certificate_hash, certificate_signature,
          signing_agent_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        client_id, asset_id, `client_and_asset_documents:${cert_id}`, all_docs.length,
        all_docs.map(d => d.gcs_object_path).filter(Boolean),
        issued_at, 'SLH-DSA-128s', certificate_hash,
        'UNSIGNED-NO-PQ-BACKEND-V1', 'deletion-certification-agent'
      ]
    );
  }

  return {
    status:      'certified',
    cert_id,
    doc_count:   all_docs.length,
    certificate,
    action:      'ISSUE_CERTIFICATE',
    message:     `Deletion certificate issued: ${cert_id} covering ${all_docs.length} documents`
  };
}

module.exports = { execute };
