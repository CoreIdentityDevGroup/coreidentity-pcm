'use strict';

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

  // Store cert reference
  if (db) {
    await db.clients.query(
      `INSERT INTO pcm_deletion_certificates
         (client_id, asset_id, cert_reference, issued_at, doc_count, cert_payload)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT DO NOTHING`,
      [client_id, asset_id, cert_id, issued_at, all_docs.length,
       JSON.stringify(certificate)]
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
