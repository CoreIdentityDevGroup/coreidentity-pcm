'use strict';

const express  = require('express');
const db       = require('../services/db');
const { authorize } = require('../middleware/authorize');
const { requireOwnClientOrStaff } = require('../middleware/ownership');
const router   = express.Router();

// Client-linked GET routes below take agreement_id from the path and look up
// its owning client_id.
const ownAgreement = requireOwnClientOrStaff(async req => {
  const r = await db.forms.query(
    `SELECT client_id FROM pcm_agreements WHERE agreement_id = $1`,
    [req.params.id]
  );
  return r.rows.length ? r.rows[0].client_id : null;
});

// ─── GET AGREEMENT TYPES ──────────────────────────────────────────────────────
router.get('/types', async (_req, res, next) => {
  try {
    const result = await db.forms.query(
      `SELECT * FROM pcm_agreement_type_reference ORDER BY display_name`
    );
    res.json({ agreement_types: result.rows });
  } catch (err) { next(err); }
});

// ─── LIST AGREEMENTS ──────────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { asset_id, agreement_type, status,
            pipeline_reference, limit = 50, offset = 0 } = req.query;
    // Client-role tokens are always scoped to their own client_id, regardless
    // of any client_id passed in the query string -- combined with an AND on
    // asset_id below, this also blocks probing another client's asset_id.
    const client_id = req.user?.role === 'client' ? req.user.client_id : req.query.client_id;
    let query = `SELECT * FROM pcm_agreements WHERE 1=1`;
    const params = [];

    if (asset_id)          { params.push(asset_id);          query += ` AND asset_id = $${params.length}`; }
    if (client_id)         { params.push(client_id);         query += ` AND client_id = $${params.length}`; }
    if (agreement_type)    { params.push(agreement_type);    query += ` AND agreement_type = $${params.length}`; }
    if (status)            { params.push(status);            query += ` AND status = $${params.length}`; }
    if (pipeline_reference){ params.push(pipeline_reference);query += ` AND pipeline_reference = $${params.length}`; }

    params.push(parseInt(limit));
    params.push(parseInt(offset));
    query += ` ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const result = await db.forms.query(query, params);
    res.json({ agreements: result.rows, count: result.rowCount });
  } catch (err) { next(err); }
});

// ─── GET AGREEMENT ────────────────────────────────────────────────────────────
router.get('/:id', ownAgreement, async (req, res, next) => {
  try {
    const agreement = await db.forms.query(
      `SELECT * FROM pcm_agreements WHERE agreement_id = $1`, [req.params.id]
    );
    if (!agreement.rows.length) return res.status(404).json({ error: 'Agreement not found' });

    const parties = await db.forms.query(
      `SELECT * FROM pcm_agreement_parties WHERE agreement_id = $1 ORDER BY created_at`,
      [req.params.id]
    );

    res.json({ ...agreement.rows[0], parties: parties.rows });
  } catch (err) { next(err); }
});

// ─── CREATE AGREEMENT ─────────────────────────────────────────────────────────
router.post('/', authorize('trade_group_owner','program_manager','intake_officer'), async (req, res, next) => {
  try {
    const {
      asset_id, client_id, agreement_type, jurisdiction_type,
      governing_law, pipeline_stage_required, pipeline_stage_gate,
      effective_date, expiry_date, auto_renew, renewal_notice_days,
      gcs_bucket, gcs_object_path, file_name, content_type,
      pipeline_reference, notes, parties = []
    } = req.body;

    if (!asset_id || !client_id || !agreement_type || !jurisdiction_type ||
        !pipeline_stage_required || !gcs_bucket || !gcs_object_path ||
        !file_name || !pipeline_reference) {
      return res.status(400).json({
        error: 'asset_id, client_id, agreement_type, jurisdiction_type, pipeline_stage_required, gcs_bucket, gcs_object_path, file_name, pipeline_reference required'
      });
    }

    const result = await db.forms.query(
      `INSERT INTO pcm_agreements
        (asset_id, client_id, agreement_type, jurisdiction_type, governing_law,
         pipeline_stage_required, pipeline_stage_gate, effective_date, expiry_date,
         auto_renew, renewal_notice_days, gcs_bucket, gcs_object_path, file_name,
         content_type, pipeline_reference, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING *`,
      [asset_id, client_id, agreement_type, jurisdiction_type, governing_law,
       pipeline_stage_required, pipeline_stage_gate ?? true,
       effective_date, expiry_date, auto_renew ?? false,
       renewal_notice_days ?? 30, gcs_bucket, gcs_object_path, file_name,
       content_type || 'application/pdf', pipeline_reference, notes]
    );

    const agreement = result.rows[0];

    // Insert parties if provided
    for (const party of parties) {
      await db.forms.query(
        `INSERT INTO pcm_agreement_parties
          (agreement_id, party_name, party_role, party_entity_type,
           party_jurisdiction, signatory_name, signatory_title, signatory_email)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [agreement.agreement_id, party.party_name, party.party_role,
         party.party_entity_type, party.party_jurisdiction,
         party.signatory_name, party.signatory_title, party.signatory_email]
      );
    }

    // Record initial version
    await db.forms.query(
      `INSERT INTO pcm_agreement_versions
        (agreement_id, version_number, gcs_object_path, gcs_bucket,
         file_name, changed_by, change_note)
       VALUES ($1,1,$2,$3,$4,$5,'Initial version')`,
      [agreement.agreement_id, gcs_object_path, gcs_bucket,
       file_name, req.user.sub || 'system']
    );

    res.status(201).json(agreement);
  } catch (err) { next(err); }
});

// ─── UPDATE AGREEMENT STATUS ──────────────────────────────────────────────────
// CLOSE-GAP-19b: 'fully_executed' and 'partially_signed' are computed by
// PATCH /:id/parties/:party_id/sign from actual signature state -- they
// must not be settable here from an unverified request body. Every other
// status in the enum (draft, pending_signature, expired, superseded,
// voided) has no signature-computed equivalent and remains a legitimate
// manual action.
const SIGNATURE_COMPUTED_STATUSES = ['fully_executed', 'partially_signed'];

router.patch('/:id/status', authorize('trade_group_owner','program_manager'), async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: 'status is required' });

    if (SIGNATURE_COMPUTED_STATUSES.includes(status)) {
      return res.status(403).json({
        error:       'Status not settable directly',
        status,
        message:     `'${status}' is computed from actual party signatures, not assertable directly. Use PATCH /:id/parties/:party_id/sign.`,
        use_instead: '/api/v1/forms/:id/parties/:party_id/sign'
      });
    }

    const result = await db.forms.query(
      `UPDATE pcm_agreements SET status = $1
       WHERE agreement_id = $2 RETURNING *`,
      [status, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Agreement not found' });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// ─── ADD NEW VERSION ──────────────────────────────────────────────────────────
router.post('/:id/versions', authorize('trade_group_owner','program_manager'), async (req, res, next) => {
  try {
    const { gcs_bucket, gcs_object_path, file_name, change_reason, change_note } = req.body;

    if (!gcs_bucket || !gcs_object_path || !file_name) {
      return res.status(400).json({ error: 'gcs_bucket, gcs_object_path, file_name required' });
    }

    const current = await db.forms.query(
      `SELECT version FROM pcm_agreements WHERE agreement_id = $1`, [req.params.id]
    );
    if (!current.rows.length) return res.status(404).json({ error: 'Agreement not found' });

    const next_version = current.rows[0].version + 1;

    await db.forms.query(
      `UPDATE pcm_agreements SET version = $1, gcs_object_path = $2,
       gcs_bucket = $3, file_name = $4 WHERE agreement_id = $5`,
      [next_version, gcs_object_path, gcs_bucket, file_name, req.params.id]
    );

    const result = await db.forms.query(
      `INSERT INTO pcm_agreement_versions
        (agreement_id, version_number, gcs_object_path, gcs_bucket,
         file_name, changed_by, change_reason, change_note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [req.params.id, next_version, gcs_object_path, gcs_bucket,
       file_name, req.user.sub || 'system', change_reason, change_note]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) { next(err); }
});

// ─── GET VERSION HISTORY ──────────────────────────────────────────────────────
router.get('/:id/versions', ownAgreement, async (req, res, next) => {
  try {
    const result = await db.forms.query(
      `SELECT * FROM pcm_agreement_versions
       WHERE agreement_id = $1 ORDER BY version_number ASC`,
      [req.params.id]
    );
    res.json({ versions: result.rows });
  } catch (err) { next(err); }
});

// ─── RECORD PARTY SIGNATURE ───────────────────────────────────────────────────
router.patch('/:id/parties/:party_id/sign', authorize('trade_group_owner','program_manager'), async (req, res, next) => {
  try {
    const { signature_method, signature_reference } = req.body;

    const result = await db.forms.query(
      `UPDATE pcm_agreement_parties
       SET signed = true, signed_at = NOW(),
           signature_method = $1, signature_reference = $2
       WHERE party_id = $3 AND agreement_id = $4
       RETURNING *`,
      [signature_method, signature_reference, req.params.party_id, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Party not found' });

    // Check if all parties have signed — if so, update agreement status
    const unsigned = await db.forms.query(
      `SELECT COUNT(*) FROM pcm_agreement_parties
       WHERE agreement_id = $1 AND signed = false`,
      [req.params.id]
    );

    if (parseInt(unsigned.rows[0].count) === 0) {
      await db.forms.query(
        `UPDATE pcm_agreements SET status = 'fully_executed', execution_date = NOW()
         WHERE agreement_id = $1`,
        [req.params.id]
      );
    } else {
      await db.forms.query(
        `UPDATE pcm_agreements SET status = 'partially_signed'
         WHERE agreement_id = $1 AND status = 'pending_signature'`,
        [req.params.id]
      );
    }

    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// ─── GET MONITORING LOG ───────────────────────────────────────────────────────
router.get('/:id/monitoring', ownAgreement, async (req, res, next) => {
  try {
    const { resolved } = req.query;
    let query = `SELECT * FROM pcm_contract_monitoring_log WHERE agreement_id = $1`;
    const params = [req.params.id];

    if (resolved !== undefined) {
      params.push(resolved === 'true');
      query += ` AND resolved = $${params.length}`;
    }

    query += ` ORDER BY created_at DESC`;
    const result = await db.forms.query(query, params);
    res.json({ monitoring_log: result.rows });
  } catch (err) { next(err); }
});

// ─── LOG MONITORING EVENT ─────────────────────────────────────────────────────
// Previously had NO authorize() at all -- any authenticated role, including
// 'client', could fabricate a monitoring event (arbitrary severity/message/
// agent_id) against any agreement/asset/client_id, not just their own. Staff
// tuple matches the other POST-write routes in this file (creation, resolve).
router.post('/:id/monitoring', authorize('trade_group_owner','program_manager','intake_officer'), async (req, res, next) => {
  try {
    const { asset_id, client_id, pipeline_reference, event_type,
            severity, message, agent_id } = req.body;

    if (!event_type || !message || !agent_id || !asset_id ||
        !client_id || !pipeline_reference) {
      return res.status(400).json({
        error: 'event_type, message, agent_id, asset_id, client_id, pipeline_reference required'
      });
    }

    const result = await db.forms.query(
      `INSERT INTO pcm_contract_monitoring_log
        (agreement_id, asset_id, client_id, pipeline_reference,
         event_type, severity, message, agent_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [req.params.id, asset_id, client_id, pipeline_reference,
       event_type, severity || 'info', message, agent_id]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) { next(err); }
});

// ─── RESOLVE MONITORING EVENT ─────────────────────────────────────────────────
router.patch('/:id/monitoring/:log_id/resolve', authorize('trade_group_owner','program_manager'), async (req, res, next) => {
  try {
    const { resolution_note } = req.body;
    const result = await db.forms.query(
      `UPDATE pcm_contract_monitoring_log
       SET resolved = true, resolved_at = NOW(),
           resolved_by = $1, resolution_note = $2
       WHERE log_id = $3 AND agreement_id = $4
       RETURNING *`,
      [req.user.sub || 'system', resolution_note,
       req.params.log_id, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Monitoring event not found' });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// ─── GET UNRESOLVED MONITORING ALERTS ─────────────────────────────────────────
// Platform-wide view across every agreement/client -- staff-only, same shape
// as pipeline/board. No per-agreement scoping is possible here since it's
// inherently cross-client by design; a 'client' role has no legitimate use
// for an org-wide alerts feed.
router.get('/monitoring/alerts', authorize('trade_group_owner','program_manager','intake_officer'), async (req, res, next) => {
  try {
    const result = await db.forms.query(
      `SELECT m.*, a.agreement_type, a.pipeline_reference, a.status as agreement_status
       FROM pcm_contract_monitoring_log m
       JOIN pcm_agreements a ON m.agreement_id = a.agreement_id
       WHERE m.resolved = false
       ORDER BY
         CASE m.severity WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END,
         m.created_at DESC`
    );
    res.json({ alerts: result.rows, count: result.rowCount });
  } catch (err) { next(err); }
});

module.exports = router;
