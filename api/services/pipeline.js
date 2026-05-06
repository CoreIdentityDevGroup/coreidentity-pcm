'use strict';

const db = require('./db');

// ─── PIPELINE STAGE DEFINITIONS ───────────────────────────────────────────────
const STAGES = {
  intake:           { order: 1, gate_role: 'intake_officer',    label: 'Intake and Document Receipt' },
  kyc_verification: { order: 2, gate_role: 'intake_officer',    label: 'KYC / CIS / POF Verification' },
  appraisal_review: { order: 3, gate_role: 'program_manager',   label: 'Appraisal / Valuation Review' },
  bank_assignment:  { order: 4, gate_role: 'trade_group_owner', label: 'Trader Bank Assignment' },
  collateralization:{ order: 5, gate_role: 'trade_group_owner', label: 'Collateralization' },
  monetization:     { order: 6, gate_role: 'program_manager',   label: 'Monetization' },
  securitization:   { order: 7, gate_role: 'program_manager',   label: 'Securitization' },
  tokenization:     { order: 8, gate_role: 'system',            label: 'Tokenization' },
  completed:        { order: 9, gate_role: 'system',            label: 'Completed' },
  rejected:         { order: 0, gate_role: 'trade_group_owner', label: 'Rejected' },
  on_hold:          { order: 0, gate_role: 'program_manager',   label: 'On Hold' }
};

// ─── GATE REQUIREMENTS PER STAGE ──────────────────────────────────────────────
const GATE_REQUIREMENTS = {
  kyc_verification: async (asset_id, client_id) => {
    const kyc = await db.clients.query(
      `SELECT COUNT(*) FROM pcm_kyc_documents
       WHERE client_id = $1 AND vault_status = 'active'`, [client_id]
    );
    const pof = await db.clients.query(
      `SELECT COUNT(*) FROM pcm_pof_records
       WHERE client_id = $1 AND vault_status = 'active'`, [client_id]
    );
    const ofac = await db.clients.query(
      `SELECT ofac_status FROM pcm_clients WHERE client_id = $1`, [client_id]
    );
    const errors = [];
    if (parseInt(kyc.rows[0].count) === 0) errors.push('No KYC documents on file');
    if (parseInt(pof.rows[0].count) === 0) errors.push('No Proof of Funds on file');
    if (ofac.rows[0]?.ofac_status === 'pending') errors.push('OFAC screening not completed');
    if (ofac.rows[0]?.ofac_status === 'flagged')  errors.push('OFAC screening flagged — requires manual review');
    return errors;
  },

  appraisal_review: async (asset_id, client_id) => {
    const val = await db.assets.query(
      `SELECT COUNT(*), MAX(date_validation_status) as val_status
       FROM pcm_valuations WHERE asset_id = $1`, [asset_id]
    );
    const docs = await db.assets.query(
      `SELECT COUNT(*) FROM pcm_asset_documents
       WHERE asset_id = $1 AND vault_status = 'active'`, [asset_id]
    );
    const errors = [];
    if (parseInt(val.rows[0].count) === 0) errors.push('No valuation or appraisal submitted');
    if (val.rows[0].val_status === 'failed') errors.push('Same-date validation failed — document dates do not match');
    if (parseInt(docs.rows[0].count) === 0) errors.push('No supporting documents on file');
    return errors;
  },

  bank_assignment: async (asset_id, client_id) => {
    const val = await db.assets.query(
      `SELECT date_validation_status FROM pcm_valuations
       WHERE asset_id = $1 ORDER BY created_at DESC LIMIT 1`, [asset_id]
    );
    const errors = [];
    if (!val.rows.length) errors.push('No valuation on file');
    if (val.rows[0]?.date_validation_status !== 'passed') errors.push('Valuation date validation not passed');
    return errors;
  },

  collateralization: async (asset_id, client_id) => {
    const asset = await db.assets.query(
      `SELECT bank_assignment FROM pcm_assets WHERE asset_id = $1`, [asset_id]
    );
    const mfa = await db.forms.query(
      `SELECT COUNT(*) FROM pcm_agreements
       WHERE asset_id = $1 AND agreement_type = 'master_fee_agreement'
       AND status = 'fully_executed'`, [asset_id]
    );
    const imfpa = await db.forms.query(
      `SELECT COUNT(*) FROM pcm_agreements
       WHERE asset_id = $1
       AND agreement_type = 'irrevocable_master_fee_protection_agreement'
       AND status = 'fully_executed'`, [asset_id]
    );
    const errors = [];
    if (!asset.rows[0]?.bank_assignment) errors.push('No trader bank assigned');
    if (parseInt(mfa.rows[0].count) === 0) errors.push('Master Fee Agreement not fully executed');
    if (parseInt(imfpa.rows[0].count) === 0) errors.push('IMFPA not fully executed');
    return errors;
  },

  monetization: async (asset_id, client_id) => {
    const pgl = await db.forms.query(
      `SELECT COUNT(*) FROM pcm_agreements
       WHERE asset_id = $1 AND agreement_type = 'payment_guarantee_letter'
       AND status = 'fully_executed'`, [asset_id]
    );
    const errors = [];
    if (parseInt(pgl.rows[0].count) === 0) errors.push('Payment Guarantee Letter not fully executed');
    return errors;
  },

  securitization: async (asset_id, client_id) => {
    const icc = await db.forms.query(
      `SELECT COUNT(*) FROM pcm_agreements
       WHERE asset_id = $1 AND agreement_type = 'icc_agreement'
       AND status = 'fully_executed'`, [asset_id]
    );
    const errors = [];
    if (parseInt(icc.rows[0].count) === 0) errors.push('ICC Agreement not fully executed');
    return errors;
  }
};

// ─── VALIDATE GATE ────────────────────────────────────────────────────────────
async function validateGate(to_stage, asset_id, client_id) {
  const checker = GATE_REQUIREMENTS[to_stage];
  if (!checker) return [];
  return await checker(asset_id, client_id);
}

// ─── CHECK ROLE AUTHORITY ─────────────────────────────────────────────────────
function checkRoleAuthority(to_stage, user_role) {
  const stage = STAGES[to_stage];
  if (!stage) return { authorized: false, reason: `Unknown stage: ${to_stage}` };
  if (stage.gate_role === 'system') return { authorized: true };

  const hierarchy = { trade_group_owner: 3, program_manager: 2, intake_officer: 1, system: 0 };
  const required  = hierarchy[stage.gate_role] || 0;
  const current   = hierarchy[user_role] || 0;

  if (current < required) {
    return {
      authorized: false,
      reason: `Stage '${to_stage}' requires role '${stage.gate_role}' or higher. Current role: '${user_role}'`
    };
  }
  return { authorized: true };
}

// ─── ADVANCE PIPELINE ─────────────────────────────────────────────────────────
async function advancePipeline({ asset_id, client_id, to_stage, user, notes }) {
  // 1. Role authority check
  const auth = checkRoleAuthority(to_stage, user.role);
  if (!auth.authorized) {
    return { success: false, code: 403, error: auth.reason };
  }

  // 2. Gate requirements check
  const gateErrors = await validateGate(to_stage, asset_id, client_id);
  if (gateErrors.length > 0) {
    return { success: false, code: 422, error: 'Gate requirements not met', gate_errors: gateErrors };
  }

  // 3. Get current stages
  const asset = await db.assets.query(
    `SELECT pipeline_stage FROM pcm_assets WHERE asset_id = $1`, [asset_id]
  );
  const client = await db.clients.query(
    `SELECT pipeline_stage FROM pcm_clients WHERE client_id = $1 AND deleted_at IS NULL`, [client_id]
  );

  if (!asset.rows.length) return { success: false, code: 404, error: 'Asset not found' };
  if (!client.rows.length) return { success: false, code: 404, error: 'Client not found' };

  const from_stage = asset.rows[0].pipeline_stage;

  // 4. Advance both asset and client
  const [updated_asset] = await Promise.all([
    db.assets.query(
      `UPDATE pcm_assets SET pipeline_stage = $1 WHERE asset_id = $2 RETURNING *`,
      [to_stage, asset_id]
    ),
    db.clients.query(
      `UPDATE pcm_clients SET pipeline_stage = $1 WHERE client_id = $2`,
      [to_stage, client_id]
    )
  ]);

  // 5. Write audit records to both databases
  await Promise.all([
    db.assets.query(
      `INSERT INTO pcm_pipeline_history
        (asset_id, client_id, from_stage, to_stage, transitioned_by, transition_role, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [asset_id, client_id, from_stage, to_stage, user.sub || 'system', user.role, notes]
    ),
    db.clients.query(
      `INSERT INTO pcm_client_pipeline_audit
        (client_id, from_stage, to_stage, transitioned_by, transition_role, notes)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [client_id, from_stage, to_stage, user.sub || 'system', user.role, notes]
    )
  ]);

  // 6. Auto-trigger tokenization at stage 8
  if (to_stage === 'tokenization') {
    await triggerTokenization(asset_id, client_id, updated_asset.rows[0]);
  }

  return {
    success: true,
    asset: updated_asset.rows[0],
    transition: { from: from_stage, to: to_stage },
    stage_label: STAGES[to_stage]?.label
  };
}

// ─── TOKENIZATION TRIGGER ─────────────────────────────────────────────────────
async function triggerTokenization(asset_id, client_id, asset) {
  const valuation = await db.assets.query(
    `SELECT * FROM pcm_valuations WHERE asset_id = $1
     AND date_validation_status = 'passed'
     ORDER BY created_at DESC LIMIT 1`, [asset_id]
  );

  if (!valuation.rows.length) return;

  const val = valuation.rows[0];
  const crypto = require('crypto');
  const payload = JSON.stringify({
    asset_id, asset_type: asset.asset_type,
    verified_value: val.appraised_value,
    verification_date: val.appraisal_date,
    issuing_authority: val.appraiser_name,
    pipeline_reference: asset.pipeline_reference,
    minted_at: new Date().toISOString()
  });

  const signature = crypto
    .createHash('sha256')
    .update(payload)
    .digest('hex');

  await db.assets.query(
    `INSERT INTO pcm_classification_tokens
      (asset_id, client_id, asset_type, verified_value, currency,
       verification_date, issuing_authority, pipeline_reference,
       token_purpose, transferable, signature_algorithm, signature, signing_agent_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,false,$10,$11,$12)
     ON CONFLICT DO NOTHING`,
    [asset_id, client_id, asset.asset_type, val.appraised_value,
     val.currency || 'USD', val.appraisal_date, val.appraiser_name,
     asset.pipeline_reference, 'identification_and_verification_only',
     'ML-DSA-65-STUB', signature, 'token-minting-agent']
  );

  await db.assets.query(
    `UPDATE pcm_assets SET token_id =
      (SELECT token_id FROM pcm_classification_tokens WHERE asset_id = $1 LIMIT 1)
     WHERE asset_id = $1`, [asset_id]
  );
}

// ─── GET PIPELINE STATUS ──────────────────────────────────────────────────────
async function getPipelineStatus(asset_id, client_id) {
  const [asset, client, history, forms] = await Promise.all([
    db.assets.query(`SELECT * FROM pcm_assets WHERE asset_id = $1`, [asset_id]),
    db.clients.query(`SELECT * FROM pcm_clients WHERE client_id = $1 AND deleted_at IS NULL`, [client_id]),
    db.assets.query(`SELECT * FROM pcm_pipeline_history WHERE asset_id = $1 ORDER BY created_at`, [asset_id]),
    db.forms.query(`SELECT agreement_type, status FROM pcm_agreements WHERE asset_id = $1`, [asset_id])
  ]);

  if (!asset.rows.length) return null;

  const current_stage = asset.rows[0].pipeline_stage;
  const stage_info    = STAGES[current_stage];

  // Calculate next stage
  const stage_order   = Object.entries(STAGES)
    .filter(([, v]) => v.order > 0)
    .sort(([, a], [, b]) => a.order - b.order);
  const current_idx   = stage_order.findIndex(([k]) => k === current_stage);
  const next_stage    = current_idx >= 0 && current_idx < stage_order.length - 1
    ? stage_order[current_idx + 1][0] : null;

  // Pre-check next gate requirements
  let next_gate_status = null;
  if (next_stage) {
    const errors = await validateGate(next_stage, asset_id, client_id);
    next_gate_status = { stage: next_stage, ready: errors.length === 0, blockers: errors };
  }

  return {
    asset_id,
    client_id,
    pipeline_reference: asset.rows[0].pipeline_reference,
    current_stage,
    stage_label:  stage_info?.label,
    gate_role:    stage_info?.gate_role,
    next_stage,
    next_gate_status,
    history:      history.rows,
    agreements:   forms.rows,
    asset:        asset.rows[0],
    client:       client.rows[0]
  };
}

module.exports = { advancePipeline, getPipelineStatus, validateGate, STAGES };
