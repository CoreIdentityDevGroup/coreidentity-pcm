'use strict';

const express  = require('express');
const db       = require('../services/db');
const { authorize, normalizeRole } = require('../middleware/authorize');
const { requireOwnClientOrStaff } = require('../middleware/ownership');
const router   = express.Router();

// Client-linked GET routes below take asset_id from the path and look up its
// owning client_id, so a client-role token scoped to a different client_id
// gets 403'd by requireOwnClientOrStaff rather than reading another
// client's asset.
const ownAsset = requireOwnClientOrStaff(async req => {
  const r = await db.assets.query(
    `SELECT client_id FROM pcm_assets WHERE asset_id = $1 AND deleted_at IS NULL`,
    [req.params.id]
  );
  return r.rows.length ? r.rows[0].client_id : null;
});

// ─── LIST ASSETS ──────────────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { asset_type, pipeline_stage, limit = 50, offset = 0 } = req.query;
    // Client-role tokens are always scoped to their own client_id, regardless
    // of any client_id passed in the query string.
    const client_id = req.user?.role === 'client' ? req.user.client_id : req.query.client_id;
    let query = `SELECT * FROM pcm_assets WHERE deleted_at IS NULL`;
    const params = [];

    if (asset_type)     { params.push(asset_type);     query += ` AND asset_type = $${params.length}`; }
    if (pipeline_stage) { params.push(pipeline_stage); query += ` AND pipeline_stage = $${params.length}`; }
    if (client_id)      { params.push(client_id);      query += ` AND client_id = $${params.length}`; }

    params.push(parseInt(limit));
    params.push(parseInt(offset));
    query += ` ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const result = await db.assets.query(query, params);
    res.json({ assets: result.rows, count: result.rowCount });
  } catch (err) { next(err); }
});

// ─── GET ASSET ────────────────────────────────────────────────────────────────
router.get('/:id', ownAsset, async (req, res, next) => {
  try {
    const result = await db.assets.query(
      `SELECT * FROM pcm_assets WHERE asset_id = $1 AND deleted_at IS NULL`, [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Asset not found' });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// ─── CREATE ASSET ─────────────────────────────────────────────────────────────
router.post('/', authorize('program_manager'), async (req, res, next) => {
  try {
    const { client_id, asset_type, asset_subtype, description,
            location, declared_value, currency, notes } = req.body;

    if (!client_id || !asset_type) {
      return res.status(400).json({ error: 'client_id and asset_type are required' });
    }

    const ref = `PCM-${Date.now()}-${Math.random().toString(36).substr(2,6).toUpperCase()}`;

    const result = await db.assets.query(
      `INSERT INTO pcm_assets
        (client_id, asset_type, asset_subtype, description,
         location, declared_value, currency, pipeline_reference, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [client_id, asset_type, asset_subtype, description,
       location, declared_value, currency || 'USD', ref, notes]
    );

    await db.assets.query(
      `INSERT INTO pcm_pipeline_history
        (asset_id, client_id, from_stage, to_stage, transitioned_by, transition_role)
       VALUES ($1,$2,NULL,'intake',$3,$4)`,
      [result.rows[0].asset_id, client_id,
       req.user.sub || 'system', req.user.role]
    );


    // AUTO-TRIGGER: asset-classifier + bank-routing + instrument-integrity
    const _assetOrch = require(require('path').join(__dirname, '../../agent-orchestrator'));
    const _newAsset = result.rows[0];
    const { instrument_type, isin, cusip, swift_mt_type, swift_raw_message } = req.body;
    Promise.resolve().then(async () => {
      const r1 = await _assetOrch.runAgent('asset-classifier', {
        client_id:      _newAsset.client_id,
        asset_id:       _newAsset.asset_id,
        description:    _newAsset.description,
        asset_subtype:  _newAsset.asset_subtype,
        declared_value: _newAsset.declared_value,
        currency:       _newAsset.currency,
        triggered_by:   'auto'
      });
      console.log(JSON.stringify({ level:'info', message:'asset-classifier done', status: r1.status }));
      const r2 = await _assetOrch.runAgent('bank-routing', {
        client_id:      _newAsset.client_id,
        asset_id:       _newAsset.asset_id,
        asset_type:     r1?.asset_type || _newAsset.asset_type,
        declared_value: _newAsset.declared_value,
        currency:       _newAsset.currency,
        country_of_origin: _newAsset.location,
        triggered_by:   'auto'
      });
      console.log(JSON.stringify({ level:'info', message:'bank-routing done', status: r2.status }));
      const r3 = await _assetOrch.runAgent('instrument-integrity', {
        client_id:           _newAsset.client_id,
        asset_id:            _newAsset.asset_id,
        description:         _newAsset.description,
        instrument_type,
        isin,
        cusip,
        swift_mt_type,
        swift_raw_message,
        triggered_by:        'auto'
      });
      console.log(JSON.stringify({ level:'info', message:'instrument-integrity done', status: r3.status }));
    }).catch(err => console.error(JSON.stringify({ level:'error', message:'Asset auto-trigger error', error: err.message })));

    res.status(201).json(result.rows[0]);
  } catch (err) { next(err); }
});

// ─── UPDATE ASSET ─────────────────────────────────────────────────────────────
router.patch('/:id', authorize('program_manager'), async (req, res, next) => {
  try {
    const allowed = ['asset_subtype','description','location','declared_value',
                     'currency','bank_assignment','bank_swift_code','notes'];
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
    const result = await db.assets.query(
      `UPDATE pcm_assets SET ${updates.join(', ')}
       WHERE asset_id = $${params.length} RETURNING *`,
      params
    );

    if (!result.rows.length) return res.status(404).json({ error: 'Asset not found' });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// ─── ADVANCE ASSET PIPELINE STAGE — REMOVED (CLOSE-GAP-11) ───────────────────
// This route used to update pcm_assets.pipeline_stage directly, with no
// role-authority check, no GATE_REQUIREMENTS check, and no sentinelCheck()
// call — a second, unguarded path to the same transition that
// POST /api/v1/pipeline/advance already gates. Route kept (not deleted) so
// a caller gets 410 Gone instead of a 404 that could pass for a typo.
router.post('/:id/advance', authorize('program_manager'), (req, res) => {
  res.status(410).json({
    error:       'Gone',
    message:     'This endpoint no longer advances pipeline stage. It performed no role-authority, gate, or Sentinel checks. Use POST /api/v1/pipeline/advance instead.',
    use_instead: '/api/v1/pipeline/advance'
  });
});

// TODO(gap-12): token-minting / deletion-certification triggers, unwired.
// Moved off POST /:id/advance by CLOSE-GAP-11
// (scripts/close-gap-11-remove-unguarded-advance.js) rather than deleted.
// Not called from anywhere in this file or elsewhere in the repo.
// Phase 0 Q10 has not settled whether stage_8_trade_close refers to a
// transaction-stage or an asset-stage event; re-wiring this against the
// wrong object is exactly the mistake CLOSE-GAP-11 exists to unwind. Do not
// call this function until Q10 is resolved and the correct call site is
// chosen deliberately — not restored to its old location by default.
//
// CLOSE-GAP-24 (Phase 3.3): the 'completed' branch specifically must not be
// wired up as-is even once Q10 is resolved. agents/deletion-certification
// issues a permanent pcm_deletion_certificates row asserting documents were
// deleted, but performs no deletion (no DELETE statement anywhere in that
// module, against pcm_kyc_documents/pcm_pof_records/pcm_asset_documents or
// GCS). Wiring this today would generate a false compliance certificate on
// every asset reaching 'completed', not close a gap. Real deletion is an
// out-of-scope product/legal decision (retention holds, reversibility,
// what "delete" means for GCS-backed vault objects), not a coding task.
async function _unwiredStageAdvanceTriggers(assetId, asset, to_stage) {
  const _stageOrch = require(require('path').join(__dirname, '../../agent-orchestrator'));

  // CLOSE-GAP-23 (Phase 3.3): the 'tokenization' branch that used to call
  // agents/token-minting is removed, not just left unwired. That module
  // writes a differently-shaped record to pcm_asset_documents and never
  // sets pcm_assets.token_id -- wiring it here would not satisfy the
  // completed-stage gate (which checks token_id), only create a confusing
  // duplicate side-effect. Real tokenization is api/services/pipeline.js's
  // triggerTokenization(), already wired into advancePipeline() at
  // to_stage === 'tokenization'. See agents/token-minting/index.js and its
  // manifest.json for the superseded-module marker.
  if (to_stage === 'completed') {
    const r = await _stageOrch.runAgent('deletion-certification', {
      asset_id:           assetId,
      client_id:          asset.client_id,
      pipeline_reference: asset.pipeline_reference,
      triggered_by:       'auto'
    });
    console.log(JSON.stringify({ level:'info', message:'deletion-certification done', status: r.status }));
  }
}

// ─── GET PIPELINE HISTORY ─────────────────────────────────────────────────────
router.get('/:id/history', ownAsset, async (req, res, next) => {
  try {
    const result = await db.assets.query(
      `SELECT * FROM pcm_pipeline_history
       WHERE asset_id = $1 ORDER BY created_at ASC`,
      [req.params.id]
    );
    res.json({ history: result.rows });
  } catch (err) { next(err); }
});

// ─── GET VALUATIONS ───────────────────────────────────────────────────────────
router.get('/:id/valuations', ownAsset, async (req, res, next) => {
  try {
    const result = await db.assets.query(
      `SELECT valuation_id, appraised_value, currency, appraiser_name,
              appraisal_date, submission_date, date_validation_status, parsed_value
       FROM pcm_valuations WHERE asset_id = $1 ORDER BY created_at DESC`,
      [req.params.id]
    );
    res.json({ valuations: result.rows });
  } catch (err) { next(err); }
});

// ─── SUBMIT VALUATION (with same-date enforcement) ────────────────────────────
router.post('/:id/valuations', authorize('program_manager'), async (req, res, next) => {
  try {
    const { appraised_value, currency, appraiser_name, appraiser_organization,
            appraiser_license, appraisal_date, submission_date,
            gcs_bucket, gcs_object_path } = req.body;

    if (!appraised_value || !appraiser_name || !appraisal_date ||
        !submission_date || !gcs_bucket || !gcs_object_path) {
      return res.status(400).json({ error: 'appraised_value, appraiser_name, appraisal_date, submission_date, gcs_bucket, gcs_object_path required' });
    }

    // ── SAME-DATE ENFORCEMENT ─────────────────────────────────────────────────
    // All valuations for the same asset must share the same submission_date.
    const existing = await db.assets.query(
      `SELECT submission_date FROM pcm_valuations
       WHERE asset_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [req.params.id]
    );

    let date_validation_status = 'passed';
    let date_validation_notes  = null;

    if (existing.rows.length > 0) {
      const prev = existing.rows[0].submission_date;
      const prevStr = new Date(prev).toISOString().split('T')[0];
      if (prevStr !== submission_date) {
        date_validation_status = 'failed';
        date_validation_notes  = `Date mismatch: previous submission_date=${prevStr}, this submission_date=${submission_date}`;
        return res.status(422).json({
          error: 'Same-date enforcement failed',
          details: date_validation_notes,
          previous_submission_date: prevStr,
          submitted_date: submission_date
        });
      }
    }

    const result = await db.assets.query(
      `INSERT INTO pcm_valuations
        (asset_id, appraised_value, currency, appraiser_name, appraiser_organization,
         appraiser_license, appraisal_date, submission_date, date_validation_status,
         date_validation_notes, gcs_bucket, gcs_object_path)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [req.params.id, appraised_value, currency || 'USD', appraiser_name,
       appraiser_organization, appraiser_license, appraisal_date, submission_date,
       date_validation_status, date_validation_notes, gcs_bucket, gcs_object_path]
    );

    // AUTO-TRIGGER: valuation-parser + document-date-validator
    const _valOrch = require(require('path').join(__dirname, '../../agent-orchestrator'));
    const _newVal = result.rows[0];
    Promise.resolve().then(async () => {
      const assetRow = await db.assets.query(
        `SELECT client_id, declared_value FROM pcm_assets WHERE asset_id = $1`, [req.params.id]
      );
      if (!assetRow.rows.length) return;
      const { client_id, declared_value } = assetRow.rows[0];

      const r1 = await _valOrch.runAgent('valuation-parser', {
        asset_id:        req.params.id,
        appraised_value: _newVal.appraised_value,
        declared_value,
        currency:        _newVal.currency,
        appraiser_name:  _newVal.appraiser_name,
        appraisal_date:  _newVal.appraisal_date,
        triggered_by:    'auto'
      });
      console.log(JSON.stringify({ level:'info', message:'valuation-parser done', status: r1.status }));

      const pofRow = await require('../services/db').clients.query(
        `SELECT submission_date FROM pcm_pof_records
         WHERE client_id = $1 AND vault_status = 'active'
         ORDER BY submission_date DESC LIMIT 1`,
        [client_id]
      );
      const r2 = await _valOrch.runAgent('document-date-validator', {
        asset_id:        req.params.id,
        appraisal_date:  _newVal.appraisal_date,
        submission_date: _newVal.submission_date,
        pof_date:        pofRow.rows[0]?.submission_date || null,
        triggered_by:    'auto'
      });
      console.log(JSON.stringify({ level:'info', message:'document-date-validator done', status: r2.status }));
    }).catch(err => console.error(JSON.stringify({ level:'error', message:'Valuation auto-trigger error', error: err.message })));

    res.status(201).json(result.rows[0]);
  } catch (err) { next(err); }
});

// ─── GET SUPPORTING DOCUMENTS ─────────────────────────────────────────────────
router.get('/:id/documents', ownAsset, async (req, res, next) => {
  try {
    const result = await db.assets.query(
      `SELECT doc_id, doc_type, doc_subtype, file_name,
              submission_date, uploaded_at, uploaded_by, vault_status
       FROM pcm_asset_documents
       WHERE asset_id = $1 AND vault_status = 'active'
       ORDER BY uploaded_at DESC`,
      [req.params.id]
    );
    res.json({ documents: result.rows });
  } catch (err) { next(err); }
});

// ─── REGISTER SUPPORTING DOCUMENT ────────────────────────────────────────────
router.post('/:id/documents', authorize('program_manager'), async (req, res, next) => {
  try {
    const { doc_type, doc_subtype, file_name, file_size_bytes,
            content_type, submission_date, gcs_bucket, gcs_object_path } = req.body;

    if (!doc_type || !file_name || !submission_date || !gcs_bucket || !gcs_object_path) {
      return res.status(400).json({ error: 'doc_type, file_name, submission_date, gcs_bucket, gcs_object_path required' });
    }

    const result = await db.assets.query(
      `INSERT INTO pcm_asset_documents
        (asset_id, doc_type, doc_subtype, gcs_bucket, gcs_object_path,
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

// ─── GET CLASSIFICATION TOKEN ─────────────────────────────────────────────────
router.get('/:id/token', ownAsset, async (req, res, next) => {
  try {
    const result = await db.assets.query(
      `SELECT token_id, asset_type, verified_value, currency, verification_date,
              issuing_authority, pipeline_reference, token_purpose,
              transferable, signature_algorithm, minted_at
       FROM pcm_classification_tokens WHERE asset_id = $1`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'No classification token found for this asset' });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// ─── ASSIGN TRADER BANK ───────────────────────────────────────────────────────
router.post('/:id/bank-assignment', authorize('program_manager'), async (req, res, next) => {
  try {
    const { bank_name, bank_jurisdiction, bank_swift_code,
            assignment_basis, notes } = req.body;

    if (!bank_name || !bank_jurisdiction) {
      return res.status(400).json({ error: 'bank_name and bank_jurisdiction are required' });
    }

    const asset = await db.assets.query(
      `SELECT client_id FROM pcm_assets WHERE asset_id = $1 AND deleted_at IS NULL`, [req.params.id]
    );
    if (!asset.rows.length) return res.status(404).json({ error: 'Asset not found' });

    await db.assets.query(
      `UPDATE pcm_assets SET bank_assignment = $1, bank_swift_code = $2,
       bank_assignment_date = NOW() WHERE asset_id = $3`,
      [bank_name, bank_swift_code, req.params.id]
    );

    const result = await db.assets.query(
      `INSERT INTO pcm_bank_assignments
        (asset_id, client_id, bank_name, bank_jurisdiction,
         bank_swift_code, assignment_basis, assigned_by, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [req.params.id, asset.rows[0].client_id, bank_name, bank_jurisdiction,
       bank_swift_code, assignment_basis, req.user.sub || 'system', notes]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) { next(err); }
});

// ─── GET BANK ASSIGNMENT HISTORY ──────────────────────────────────────────────
router.get('/:id/bank-assignments', ownAsset, async (req, res, next) => {
  try {
    const result = await db.assets.query(
      `SELECT * FROM pcm_bank_assignments
       WHERE asset_id = $1 ORDER BY assigned_at DESC`,
      [req.params.id]
    );
    res.json({ bank_assignments: result.rows });
  } catch (err) { next(err); }
});

// ─── ASSIGN PACKAGE HANDLER ───────────────────────────────────────────────────
// 2026-08-24 (replaces legal-attestation entry, removed this session --
// CoreG reviews its own documentation, there is no external counsel step
// to piggyback the assignment on anymore). Standalone: claims ownership
// of a package, nothing else. Self-referential by design, same
// constraint the old entry route had -- assigned_role/assigned_staff_id
// come from req.user, NEVER the request body, so a caller cannot claim
// an assignment on someone else's behalf.
//
// Facilitator can self-assign too (superset rule, unchanged from the old
// route) -- assigned_handler_role's CHECK still allows 'facilitator'
// (db/migrations/0013). The stored role is descriptive only; ownership
// authority is decided by staff_id match in checkRoleAuthority, not this
// value.
router.post('/:id/assign', authorize('intake_officer', 'program_manager'), async (req, res, next) => {
  try {
    const asset = await db.assets.query(
      `SELECT asset_id FROM pcm_assets WHERE asset_id = $1 AND deleted_at IS NULL`,
      [req.params.id]
    );
    if (!asset.rows.length) return res.status(404).json({ error: 'Asset not found' });

    const assignedRole = normalizeRole(req.user.role);
    const staffId = req.user.staff_id;

    const result = await db.assets.query(
      `UPDATE pcm_assets SET assigned_handler_role = $1, assigned_handler_staff_id = $2
       WHERE asset_id = $3 RETURNING asset_id, assigned_handler_role, assigned_handler_staff_id`,
      [assignedRole, staffId, req.params.id]
    );

    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// ─── SUBMIT PACKAGE TO PLATFORM ───────────────────────────────────────────────
// 2026-08-24. CoreG is an intermediary that collects and reviews
// documentation itself (stages 1-7). Once securitization (stage 7)
// completes, the package goes to the platform -- an external party with
// no portal login -- for its own review; tokenization (stage 8) only
// proceeds on the platform's approval (see GATE_REQUIREMENTS.tokenization
// in api/services/pipeline.js). This route records that the package was
// sent, for accountability, same discipline pcm_ofac_results already
// applies to CoreG's own screening: structured fields, a recorded
// principal, a recorded timestamp.
//
// manifest is a point-in-time SNAPSHOT of what's actually being sent, not
// a set of references to resolve later -- buildSubmissionManifest reads
// the real field values off every evidence table at submission time, so
// if a document or valuation changes or gets superseded afterward, this
// row still shows what the platform actually received.
async function buildSubmissionManifest(asset_id, client_id) {
  const [asset, valuations, assetDocuments, integrity, agreements, kycDocs, pofRecords, ofac] = await Promise.all([
    db.assets.query(`SELECT * FROM pcm_assets WHERE asset_id = $1`, [asset_id]),
    db.assets.query(`SELECT * FROM pcm_valuations WHERE asset_id = $1 ORDER BY created_at DESC`, [asset_id]),
    db.assets.query(`SELECT doc_id, doc_type, doc_subtype, file_name, submission_date, uploaded_at, uploaded_by
                      FROM pcm_asset_documents WHERE asset_id = $1 AND vault_status = 'active'`, [asset_id]),
    db.assets.query(`SELECT * FROM pcm_instrument_integrity_results WHERE asset_id = $1`, [asset_id]),
    db.forms.query(`SELECT agreement_id, agreement_type, status, effective_date, execution_date, file_name
                     FROM pcm_agreements WHERE asset_id = $1 AND status = 'fully_executed'`, [asset_id]),
    db.clients.query(`SELECT doc_id, doc_type, doc_subtype, file_name, submission_date, uploaded_at, uploaded_by
                       FROM pcm_kyc_documents WHERE client_id = $1 AND vault_status = 'active'`, [client_id]),
    db.clients.query(`SELECT pof_id, declared_amount, currency, issuing_bank, submission_date, verified
                       FROM pcm_pof_records WHERE client_id = $1 AND vault_status = 'active'`, [client_id]),
    db.clients.query(`SELECT result_id, provider, status, match_method, screened_at
                       FROM pcm_ofac_results WHERE client_id = $1 ORDER BY screened_at DESC LIMIT 1`, [client_id])
  ]);

  return {
    asset:               asset.rows[0] || null,
    valuations:          valuations.rows,
    asset_documents:     assetDocuments.rows,
    instrument_integrity: integrity.rows,
    agreements:          agreements.rows,
    kyc_documents:       kycDocs.rows,
    pof_records:         pofRecords.rows,
    ofac_result:         ofac.rows[0] || null
  };
}

router.post('/:id/platform-submission', authorize('program_manager'), async (req, res, next) => {
  try {
    const asset = await db.assets.query(
      `SELECT asset_id, client_id, pipeline_stage FROM pcm_assets WHERE asset_id = $1 AND deleted_at IS NULL`,
      [req.params.id]
    );
    if (!asset.rows.length) return res.status(404).json({ error: 'Asset not found' });
    const { client_id, pipeline_stage } = asset.rows[0];

    if (pipeline_stage !== 'securitization') {
      return res.status(409).json({ error: `Asset must be at 'securitization' to submit to the platform (current stage: ${pipeline_stage})` });
    }

    const manifest = await buildSubmissionManifest(req.params.id, client_id);
    const submittedBy = req.user.sub || req.user.email;

    const result = await db.assets.query(
      `INSERT INTO pcm_platform_submissions (asset_id, submitted_by, manifest)
       VALUES ($1,$2,$3) RETURNING submission_id, asset_id, submitted_by, submitted_at`,
      [req.params.id, submittedBy, JSON.stringify(manifest)]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) { next(err); }
});

router.get('/:id/platform-submissions', ownAsset, async (req, res, next) => {
  try {
    const result = await db.assets.query(
      `SELECT submission_id, asset_id, submitted_by, submitted_at
       FROM pcm_platform_submissions WHERE asset_id = $1 ORDER BY submitted_at DESC`,
      [req.params.id]
    );
    res.json({ submissions: result.rows });
  } catch (err) { next(err); }
});

// ─── RECORD PLATFORM RESPONSE ─────────────────────────────────────────────────
// APPROVED or DENIED, no conditions -- same binary-no-default discipline
// the removed legal-attestation outcome used. No countersign: the
// platform itself is the second party to this decision, so a single
// CoreG principal recording what the platform said is not the same kind
// of claim an out-of-band attestation was.
//
// DENIED archives the package by moving it to 'rejected' -- reusing the
// existing terminal stage rather than inventing a distinct "archived"
// state (see this session's design note: 'rejected' is already
// unconditionally terminal, already audit-logged via
// pcm_pipeline_history, and the reason a package died is already fully
// captured in pcm_platform_responses + the transition notes below, same
// pattern the removed legal-attestation-denial auto-reject used).
router.post('/:id/platform-submission/:submission_id/response', authorize('program_manager'), async (req, res, next) => {
  try {
    const { decision } = req.body;
    if (decision !== 'APPROVED' && decision !== 'DENIED') {
      return res.status(400).json({ error: "decision is required and must be 'APPROVED' or 'DENIED'" });
    }

    const submission = await db.assets.query(
      `SELECT submission_id, asset_id FROM pcm_platform_submissions
       WHERE submission_id = $1 AND asset_id = $2`,
      [req.params.submission_id, req.params.id]
    );
    if (!submission.rows.length) return res.status(404).json({ error: 'Submission not found' });

    const existingResponse = await db.assets.query(
      `SELECT response_id FROM pcm_platform_responses WHERE submission_id = $1`,
      [req.params.submission_id]
    );
    if (existingResponse.rows.length) {
      return res.status(409).json({ error: 'This submission already has a recorded response.' });
    }

    const recordedBy = req.user.sub || req.user.email;
    const result = await db.assets.query(
      `INSERT INTO pcm_platform_responses (submission_id, decision, recorded_by)
       VALUES ($1,$2,$3) RETURNING *`,
      [req.params.submission_id, decision, recordedBy]
    );

    let rejection = null;
    if (decision === 'DENIED') {
      const asset = await db.assets.query(`SELECT client_id FROM pcm_assets WHERE asset_id = $1`, [req.params.id]);
      const { advancePipeline } = require('../services/pipeline');
      rejection = await advancePipeline({
        asset_id: req.params.id,
        client_id: asset.rows[0].client_id,
        to_stage: 'rejected',
        user: { sub: req.user.sub, staff_id: req.user.staff_id, role: 'facilitator' },
        notes: `Automatic: platform denied submission ${req.params.submission_id} (recorded by ${recordedBy})`
      });
      if (!rejection.success) {
        console.error(JSON.stringify({
          level: 'error', message: 'Platform denial recorded but automatic rejection failed',
          submission_id: req.params.submission_id, asset_id: req.params.id, error: rejection.error
        }));
      }
    }

    res.status(201).json({ ...result.rows[0], auto_rejected: decision === 'DENIED', rejection_result: rejection });
  } catch (err) { next(err); }
});

module.exports = router;
