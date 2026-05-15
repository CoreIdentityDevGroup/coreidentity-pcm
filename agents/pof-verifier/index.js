'use strict';

async function execute(context) {
  const { client_id, asset_id, db } = context;

  // Get latest POF for client
  const pof_result = await db.clients.query(
    `SELECT * FROM pcm_pof_records 
     WHERE client_id = $1 AND vault_status = 'active'
     ORDER BY submission_date DESC LIMIT 1`,
    [client_id]
  );

  if (!pof_result.rows.length) {
    return {
      status: 'no_pof',
      action: 'REQUEST_POF',
      message: 'No active POF on file'
    };
  }

  const pof = pof_result.rows[0];

  // Get asset declared value
  const asset_result = await db.assets.query(
    'SELECT declared_value, currency FROM pcm_assets WHERE asset_id = $1',
    [asset_id]
  );

  if (!asset_result.rows.length) {
    return { status: 'error', message: 'Asset not found' };
  }

  const asset = asset_result.rows[0];
  const pof_amount    = parseFloat(pof.declared_amount);
  const asset_value   = parseFloat(asset.declared_value);
  const coverage_ratio = pof_amount / asset_value;

  const sufficient = coverage_ratio >= 1.0;
  const marginal   = coverage_ratio >= 0.8 && coverage_ratio < 1.0;

  return {
    status:          sufficient ? 'verified' : marginal ? 'marginal' : 'insufficient',
    pof_amount,
    asset_value,
    coverage_ratio:  parseFloat(coverage_ratio.toFixed(4)),
    issuing_bank:    pof.issuing_bank,
    action:          sufficient ? 'APPROVE' : marginal ? 'FLAG_FOR_REVIEW' : 'REJECT',
    message:         sufficient
      ? `POF verified — coverage ${(coverage_ratio * 100).toFixed(1)}%`
      : `POF insufficient — coverage ${(coverage_ratio * 100).toFixed(1)}% (minimum 100%)`
  };
}

module.exports = { execute };
