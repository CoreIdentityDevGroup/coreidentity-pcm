'use strict';
const governance = require('../services/governance');
const express  = require('express');
const { v4: uuid } = require('uuid');
const db       = require('../services/db');
const { authorize } = require('../middleware/authorize');
const router   = express.Router();

// ─── LIST CLIENTS ─────────────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { stage, assigned_to, country, limit = 50, offset = 0 } = req.query;
    let query = `SELECT * FROM pcm_clients WHERE deleted_at IS NULL`;
    const params = [];

    if (stage)       { params.push(stage);       query += ` AND pipeline_stage = $${params.length}`; }
    if (country)     { params.push(country);     query += ` AND country_of_origin = $${params.length}`; }
    if (assigned_to) { params.push(assigned_to); query += ` AND (assigned_trade_group_owner = $${params.length} OR assigned_program_manager = $${params.length} OR assigned_intake_officer = $${params.length})`; }

    params.push(parseInt(limit));
    params.push(parseInt(offset));
    query += ` ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const result = await db.clients.query(query, params);
    res.json({ clients: result.rows, count: result.rowCount });
  } catch (err) { next(err); }
});

// ─── GET CLIENT ───────────────────────────────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const result = await db.clients.query(
      `SELECT * FROM pcm_clients WHERE client_id = $1 AND deleted_at IS NULL`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Client not found' });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// ─── CREATE CLIENT ────────────────────────────────────────────────────────────
router.post('/', authorize('trade_group_owner','program_manager','intake_officer'), async (req, res, next) => {
  try {
    const {
      full_name, email, phone, country_of_origin, jurisdiction,
      referral_source, referral_contact, notes,
      given_name, family_name, date_of_birth
    } = req.body;

    if (!full_name || !email || !country_of_origin) {
      return res.status(400).json({ error: 'full_name, email, and country_of_origin are required' });
    }
    // SDN screening design (docs/SDN-Sanctions-Screening-Design.md):
    // required for all new intake going forward, same enforcement style as
    // the fields above (application-level, not a DB NOT NULL -- see
    // db/migrations/0004's comment on why the DB column stays nullable).
    // DOB is the strongest disambiguator OFAC actually provides
    // structured; screening auto-triggers synchronously right after this
    // route returns, so it has to be collected at the same moment as
    // everything else, not attached later.
    if (!given_name || !family_name || !date_of_birth) {
      return res.status(400).json({ error: 'given_name, family_name, and date_of_birth are required' });
    }

    const result = await db.clients.query(
      `INSERT INTO pcm_clients
        (full_name, email, phone, country_of_origin, jurisdiction,
         referral_source, referral_contact, notes,
         given_name, family_name, date_of_birth)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [full_name, email, phone, country_of_origin, jurisdiction,
       referral_source, referral_contact, notes,
       given_name, family_name, date_of_birth]
    );

    await db.clients.query(
      `INSERT INTO pcm_client_pipeline_audit
        (client_id, from_stage, to_stage, transitioned_by, transition_role)
       VALUES ($1, NULL, 'intake', $2, $3)`,
      [result.rows[0].client_id, req.user.sub || 'system', req.user.role]
    );
    // AUTO-TRIGGER: intake-parser + ofac-screening
    const _orch = require(require('path').join(__dirname, '../../agent-orchestrator'));
    const _newClient = result.rows[0];
    Promise.resolve().then(async () => {
      const r1 = await _orch.runAgent('intake-parser', { client_id: _newClient.client_id, client_data: _newClient, db: require('../services/db'), triggered_by: 'auto' });
      console.log(JSON.stringify({ level: 'info', message: 'intake-parser done', status: r1.status }));
      const r2 = await _orch.runAgent('ofac-screening', {
        client_id: _newClient.client_id, full_name: _newClient.full_name,
        given_name: _newClient.given_name, family_name: _newClient.family_name,
        date_of_birth: _newClient.date_of_birth,
        country_of_origin: _newClient.country_of_origin, db: require('../services/db'), triggered_by: 'auto'
      });
      console.log(JSON.stringify({ level: 'info', message: 'ofac-screening done', status: r2.status }));
    }).catch(err => console.error(JSON.stringify({ level: 'error', message: 'Auto-trigger error', error: err.message })));

    res.status(201).json(result.rows[0]);
  } catch (err) { next(err); }
});

// ─── UPDATE CLIENT ────────────────────────────────────────────────────────────
router.patch('/:id', authorize('trade_group_owner','program_manager','intake_officer'), async (req, res, next) => {
  try {
    const allowed = ['full_name','email','phone','country_of_origin','jurisdiction',
                     'referral_source','referral_contact','notes',
                     'assigned_trade_group_owner','assigned_program_manager','assigned_intake_officer',
                     'bank_assignment','given_name','family_name','date_of_birth'];
    const updates = [];
    const params  = [];

    for (const [key, val] of Object.entries(req.body)) {
      if (allowed.includes(key)) {
        params.push(val);
        updates.push(`${key} = $${params.length}`);
      }
    }

    if (!updates.length) return res.status(400).json({ error: 'No valid fields to update' });

    params.push(req.params.id);
    const result = await db.clients.query(
      `UPDATE pcm_clients SET ${updates.join(', ')}
       WHERE client_id = $${params.length} AND deleted_at IS NULL
       RETURNING *`,
      params
    );

    if (!result.rows.length) return res.status(404).json({ error: 'Client not found' });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// ─── ADVANCE PIPELINE STAGE ───────────────────────────────────────────────────
// ─── ADVANCE CLIENT PIPELINE STAGE — REMOVED (CLOSE-GAP-17) ──────────────────
// This route used to update pcm_clients.pipeline_stage directly, with no
// role-hierarchy check, no GATE_REQUIREMENTS check, and no sentinelCheck()
// call -- the same defect CLOSE-GAP-11 fixed on the assets side. Not
// routed through advancePipeline(): that function requires asset_id,
// which this route never accepted, and there is no standalone concept of
// advancing a client's stage independent of an asset in the guarded
// model. Route kept (not deleted) so a caller gets 410 Gone instead of a
// 404 that could pass for a typo.
router.post('/:id/advance', authorize('trade_group_owner','program_manager','intake_officer'), (req, res) => {
  res.status(410).json({
    error:       'Gone',
    message:     'This endpoint no longer advances pipeline stage. It performed no role-hierarchy, gate, or Sentinel checks, and never accepted the asset_id the guarded path requires. Use POST /api/v1/pipeline/advance instead.',
    use_instead: '/api/v1/pipeline/advance'
  });
});

// ─── GET CLIENT PIPELINE AUDIT ────────────────────────────────────────────────
router.get('/:id/audit', async (req, res, next) => {
  try {
    const result = await db.clients.query(
      `SELECT * FROM pcm_client_pipeline_audit
       WHERE client_id = $1 ORDER BY created_at ASC`,
      [req.params.id]
    );
    res.json({ audit: result.rows });
  } catch (err) { next(err); }
});

// ─── GET KYC DOCUMENTS ────────────────────────────────────────────────────────
router.get('/:id/kyc', async (req, res, next) => {
  try {
    const result = await db.clients.query(
      `SELECT doc_id, doc_type, doc_subtype, file_name, submission_date,
              uploaded_at, uploaded_by, vault_status, gcs_object_path
       FROM pcm_kyc_documents
       WHERE client_id = $1 AND vault_status = 'active'
       ORDER BY uploaded_at DESC`,
      [req.params.id]
    );
    res.json({ documents: result.rows });
  } catch (err) { next(err); }
});

// ─── REGISTER KYC DOCUMENT (metadata only — upload via signed URL) ────────────
router.post('/:id/kyc', authorize('trade_group_owner','program_manager','intake_officer'), async (req, res, next) => {
  try {
    const { doc_type, doc_subtype, file_name, file_size_bytes,
            content_type, submission_date, gcs_bucket, gcs_object_path } = req.body;

    if (!doc_type || !file_name || !submission_date || !gcs_bucket || !gcs_object_path) {
      return res.status(400).json({ error: 'doc_type, file_name, submission_date, gcs_bucket, gcs_object_path required' });
    }

    const result = await db.clients.query(
      `INSERT INTO pcm_kyc_documents
        (client_id, doc_type, doc_subtype, gcs_bucket, gcs_object_path,
         file_name, file_size_bytes, content_type, submission_date, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING doc_id, doc_type, file_name, submission_date, vault_status, created_at`,
      [req.params.id, doc_type, doc_subtype, gcs_bucket, gcs_object_path,
       file_name, file_size_bytes, content_type, submission_date,
       req.user.sub || 'system']
    );

    res.status(201).json(result.rows[0]);
  } catch (err) { next(err); }
});

// ─── GET POF RECORDS ──────────────────────────────────────────────────────────
router.get('/:id/pof', async (req, res, next) => {
  try {
    const result = await db.clients.query(
      `SELECT pof_id, declared_amount, currency, issuing_bank,
              submission_date, verified, verified_at, vault_status, gcs_object_path
       FROM pcm_pof_records
       WHERE client_id = $1 AND vault_status = 'active'
       ORDER BY created_at DESC`,
      [req.params.id]
    );
    res.json({ pof_records: result.rows });
  } catch (err) { next(err); }
});

// ─── REGISTER POF RECORD ──────────────────────────────────────────────────────
router.post('/:id/pof', authorize('trade_group_owner','program_manager','intake_officer'), async (req, res, next) => {
  try {
    const { declared_amount, currency, issuing_bank, issuing_bank_swift,
            submission_date, gcs_bucket, gcs_object_path } = req.body;

    if (!declared_amount || !issuing_bank || !submission_date || !gcs_bucket || !gcs_object_path) {
      return res.status(400).json({ error: 'declared_amount, issuing_bank, submission_date, gcs_bucket, gcs_object_path required' });
    }

    const result = await db.clients.query(
      `INSERT INTO pcm_pof_records
        (client_id, declared_amount, currency, issuing_bank, issuing_bank_swift,
         submission_date, gcs_bucket, gcs_object_path)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING pof_id, declared_amount, currency, issuing_bank, submission_date, vault_status`,
      [req.params.id, declared_amount, currency || 'USD', issuing_bank,
       issuing_bank_swift, submission_date, gcs_bucket, gcs_object_path]
    );


    // AUTO-TRIGGER: pof-verifier
    const _pofOrch = require(require('path').join(__dirname, '../../agent-orchestrator'));
    const _newPof = result.rows[0];
    Promise.resolve().then(async () => {
      const assets = await require('../services/db').assets.query(
        'SELECT asset_id FROM pcm_assets WHERE client_id = $1 ORDER BY created_at DESC LIMIT 1',
        [req.params.id]
      );
      if (assets.rows.length > 0) {
        const r1 = await _pofOrch.runAgent('pof-verifier', {
          client_id:   req.params.id,
          asset_id:    assets.rows[0].asset_id,
          db:          require('../services/db'),
          triggered_by: 'auto'
        });
        console.log(JSON.stringify({ level:'info', message:'pof-verifier done', status: r1.status }));
      }
    }).catch(err => console.error(JSON.stringify({ level:'error', message:'POF auto-trigger error', error: err.message })));

    res.status(201).json(result.rows[0]);
  } catch (err) { next(err); }
});

// ─── VERIFY POF ───────────────────────────────────────────────────────────────
router.patch('/:id/pof/:pof_id/verify', authorize('trade_group_owner','program_manager'), async (req, res, next) => {
  try {
    const { verification_notes } = req.body;
    const result = await db.clients.query(
      `UPDATE pcm_pof_records
       SET verified = true, verified_at = NOW(),
           verified_by = $1, verification_notes = $2
       WHERE pof_id = $3 AND client_id = $4
       RETURNING *`,
      [req.user.sub || 'system', verification_notes, req.params.pof_id, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'POF record not found' });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// ─── OFAC RESULTS ─────────────────────────────────────────────────────────────
router.get('/:id/ofac', async (req, res, next) => {
  try {
    const result = await db.clients.query(
      `SELECT * FROM pcm_ofac_results
       WHERE client_id = $1 ORDER BY screened_at DESC`,
      [req.params.id]
    );
    res.json({ ofac_results: result.rows });
  } catch (err) { next(err); }
});

// ─── RECORD OFAC RESULT — REMOVED (CLOSE-GAP-19a) ─────────────────────────────
// This route let any caller assert pcm_clients.ofac_status -- the exact
// column the kyc_verification gate reads -- from an unverified request
// body, with no evidence it came from a real screen. Route kept (not
// deleted) so a caller gets 410 Gone instead of a 404 that could pass for
// a typo. See POST .../ofac/override for the real, dual-control path.
router.post('/:id/ofac', authorize('trade_group_owner','program_manager','intake_officer'), (req, res) => {
  res.status(410).json({
    error:       'Gone',
    message:     'This endpoint no longer sets OFAC status from an unverified request body. Automated screening is recorded by the ofac-screening agent directly. For a manual/out-of-band screen, use the dual-control override flow.',
    use_instead: '/api/v1/clients/:id/ofac/override'
  });
});

// ─── INITIATE OFAC MANUAL OVERRIDE (CLOSE-GAP-19a, step 1 of 2) ──────────────
// Records that a first principal is asserting an out-of-band screen result.
// Does NOT set pcm_clients.ofac_status -- the KYC gate does not accept this
// until a second, distinct principal confirms via the countersign endpoint
// below. A single request naming two people is not dual control.
router.post('/:id/ofac/override', authorize('trade_group_owner'), async (req, res, next) => {
  try {
    // CLOSE-GAP-26: structured fields, not just free-text reason. "Two
    // people clicked confirm" is not an audit trail for a sanctions
    // control -- the record must show what was actually screened.
    const { reason, screening_provider, screening_date, reference_number } = req.body;
    if (!reason || !reason.trim()) {
      return res.status(400).json({ error: 'reason is required — document the out-of-band screen this override is based on' });
    }
    if (!screening_provider || !screening_provider.trim()) {
      return res.status(400).json({ error: 'screening_provider is required — which service or method performed the out-of-band screen' });
    }
    if (!screening_date || !screening_date.trim()) {
      return res.status(400).json({ error: 'screening_date is required — when the out-of-band screen was actually performed' });
    }

    const client = await db.clients.query(
      `SELECT client_id FROM pcm_clients WHERE client_id = $1 AND deleted_at IS NULL`,
      [req.params.id]
    );
    if (!client.rows.length) return res.status(404).json({ error: 'Client not found' });

    const initiatedBy = req.user.sub || req.user.email;
    const summary = `Screened via ${screening_provider} on ${screening_date}${reference_number ? ` (ref: ${reference_number})` : ''}. ${reason}`;

    const result = await db.clients.query(
      `INSERT INTO pcm_ofac_results
        (client_id, provider, status, raw_response_summary, reviewed_by, reviewed_at, review_outcome)
       VALUES ($1, 'MANUAL_OVERRIDE', 'manual_review', $2, $3, NOW(), 'PENDING_COUNTERSIGN')
       RETURNING *`,
      [req.params.id, summary, initiatedBy]
    );

    res.status(201).json({
      result_id:  result.rows[0].result_id,
      status:     'PENDING_COUNTERSIGN',
      message:    'Override initiated. A different trade_group_owner must countersign before this affects the KYC gate.',
      initiated_by: initiatedBy
    });
  } catch (err) { next(err); }
});

// ─── INITIATE OFAC OUT-OF-BAND ATTESTATION (CLOSE-GAP-26, step 1 of 2) ───────
// For clients the heuristic did NOT flag (ofac_status =
// 'not_authoritatively_screened') where staff performed a real screen
// out-of-band. Distinct from /override: no automated control ran here to
// be overridden, so this uses its own provider/status/outcome vocabulary
// rather than reusing MANUAL_OVERRIDE's, which would misrepresent the
// audit trail as "every screen was an override."
router.post('/:id/ofac/attest-out-of-band', authorize('trade_group_owner'), async (req, res, next) => {
  try {
    const { reason, screening_provider, screening_date, reference_number } = req.body;
    if (!reason || !reason.trim()) {
      return res.status(400).json({ error: 'reason is required — document the out-of-band screen this attestation is based on' });
    }
    if (!screening_provider || !screening_provider.trim()) {
      return res.status(400).json({ error: 'screening_provider is required — which service or method performed the out-of-band screen' });
    }
    if (!screening_date || !screening_date.trim()) {
      return res.status(400).json({ error: 'screening_date is required — when the out-of-band screen was actually performed' });
    }

    const client = await db.clients.query(
      `SELECT client_id FROM pcm_clients WHERE client_id = $1 AND deleted_at IS NULL`,
      [req.params.id]
    );
    if (!client.rows.length) return res.status(404).json({ error: 'Client not found' });

    const initiatedBy = req.user.sub || req.user.email;
    const summary = `Screened via ${screening_provider} on ${screening_date}${reference_number ? ` (ref: ${reference_number})` : ''}. ${reason}`;

    const result = await db.clients.query(
      `INSERT INTO pcm_ofac_results
        (client_id, provider, status, raw_response_summary, reviewed_by, reviewed_at, review_outcome)
       VALUES ($1, 'OUT_OF_BAND_ATTESTATION', 'attested_out_of_band', $2, $3, NOW(), 'PENDING_ATTESTATION')
       RETURNING *`,
      [req.params.id, summary, initiatedBy]
    );

    res.status(201).json({
      result_id:  result.rows[0].result_id,
      status:     'PENDING_ATTESTATION',
      message:    'Attestation initiated. A different trade_group_owner must confirm before this affects the KYC gate.',
      initiated_by: initiatedBy
    });
  } catch (err) { next(err); }
});

// ─── CONFIRM OFAC OUT-OF-BAND ATTESTATION (CLOSE-GAP-26, step 2 of 2) ────────
// Only after this succeeds does pcm_clients.ofac_status become
// 'attested_out_of_band'.
router.patch('/:id/ofac/attest-out-of-band/:result_id/confirm', authorize('trade_group_owner'), async (req, res, next) => {
  try {
    const { reason } = req.body;
    if (!reason || !reason.trim()) {
      return res.status(400).json({ error: 'reason is required — document your own independent basis for confirming this attestation' });
    }

    const confirmedBy = req.user.sub || req.user.email;

    const existing = await db.clients.query(
      `SELECT * FROM pcm_ofac_results
       WHERE result_id = $1 AND client_id = $2 AND provider = 'OUT_OF_BAND_ATTESTATION'`,
      [req.params.result_id, req.params.id]
    );
    if (!existing.rows.length) return res.status(404).json({ error: 'Attestation not found' });

    const attestation = existing.rows[0];
    if (attestation.review_outcome !== 'PENDING_ATTESTATION') {
      return res.status(409).json({ error: `Attestation is not pending confirmation (current state: ${attestation.review_outcome})` });
    }
    if (attestation.reviewed_by === confirmedBy) {
      return res.status(403).json({ error: 'Cannot confirm your own attestation — dual control requires a different principal' });
    }

    const confirmNote = `${attestation.raw_response_summary} | Confirmed by ${confirmedBy} at ${new Date().toISOString()}: ${reason}`;

    const updated = await db.clients.query(
      `UPDATE pcm_ofac_results
       SET review_outcome = 'ATTESTATION_CONFIRMED', raw_response_summary = $1
       WHERE result_id = $2
       RETURNING *`,
      [confirmNote, req.params.result_id]
    );

    await db.clients.query(
      `UPDATE pcm_clients
       SET ofac_status = 'attested_out_of_band', ofac_screened_at = NOW(),
           ofac_provider = 'OUT_OF_BAND_ATTESTATION', ofac_reference_id = $1
       WHERE client_id = $2`,
      [req.params.result_id, req.params.id]
    );

    const governance = require('../services/governance');
    await governance.salLog({
      agent_id: confirmedBy,
      action:   'OFAC_OUT_OF_BAND_ATTESTATION_CONFIRMED',
      resource: `pcm:client:${req.params.id}`,
      decision: 'ALLOW',
      context:  { initiated_by: attestation.reviewed_by, confirmed_by: confirmedBy, result_id: req.params.result_id }
    }).catch(() => {});

    res.json(updated.rows[0]);
  } catch (err) { next(err); }
});
// CLOSE-GAP-26

// ─── COUNTERSIGN OFAC MANUAL OVERRIDE (CLOSE-GAP-19a, step 2 of 2) ───────────
// Only after this succeeds does pcm_clients.ofac_status become
// 'manual_review' -- never 'clear'. Distinguishable from a real screen in
// every downstream query, permanently.
router.patch('/:id/ofac/override/:result_id/countersign', authorize('trade_group_owner'), async (req, res, next) => {
  try {
    const { reason } = req.body;
    if (!reason || !reason.trim()) {
      return res.status(400).json({ error: 'reason is required — document your own independent basis for confirming this override' });
    }

    const countersignedBy = req.user.sub || req.user.email;

    const existing = await db.clients.query(
      `SELECT * FROM pcm_ofac_results
       WHERE result_id = $1 AND client_id = $2 AND provider = 'MANUAL_OVERRIDE'`,
      [req.params.result_id, req.params.id]
    );
    if (!existing.rows.length) return res.status(404).json({ error: 'Override not found' });

    const override = existing.rows[0];
    if (override.review_outcome !== 'PENDING_COUNTERSIGN') {
      return res.status(409).json({ error: `Override is not pending countersign (current state: ${override.review_outcome})` });
    }
    if (override.reviewed_by === countersignedBy) {
      return res.status(403).json({ error: 'Cannot countersign your own override — dual control requires a different principal' });
    }

    const countersignNote = `${override.raw_response_summary} | Countersigned by ${countersignedBy} at ${new Date().toISOString()}: ${reason}`;

    const updated = await db.clients.query(
      `UPDATE pcm_ofac_results
       SET review_outcome = 'MANUAL_OVERRIDE_CONFIRMED', raw_response_summary = $1
       WHERE result_id = $2
       RETURNING *`,
      [countersignNote, req.params.result_id]
    );

    await db.clients.query(
      `UPDATE pcm_clients
       SET ofac_status = 'manual_review', ofac_screened_at = NOW(),
           ofac_provider = 'MANUAL_OVERRIDE', ofac_reference_id = $1
       WHERE client_id = $2`,
      [req.params.result_id, req.params.id]
    );

    const governance = require('../services/governance');
    await governance.salLog({
      agent_id: countersignedBy,
      action:   'OFAC_MANUAL_OVERRIDE_CONFIRMED',
      resource: `pcm:client:${req.params.id}`,
      decision: 'ALLOW',
      context:  { initiated_by: override.reviewed_by, countersigned_by: countersignedBy, result_id: req.params.result_id }
    }).catch(() => {});

    res.json(updated.rows[0]);
  } catch (err) { next(err); }
});

// ─── SOFT DELETE CLIENT ───────────────────────────────────────────────────────
router.delete('/:id', authorize('trade_group_owner'), async (req, res, next) => {
  try {
    const result = await db.clients.query(
      `UPDATE pcm_clients SET deleted_at = NOW()
       WHERE client_id = $1 AND deleted_at IS NULL RETURNING client_id`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Client not found' });
    res.json({ message: 'Client deactivated', client_id: req.params.id });
  } catch (err) { next(err); }
});

module.exports = router;
