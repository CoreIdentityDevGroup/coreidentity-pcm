'use strict';

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
      referral_source, referral_contact, notes
    } = req.body;

    if (!full_name || !email || !country_of_origin) {
      return res.status(400).json({ error: 'full_name, email, and country_of_origin are required' });
    }

    const result = await db.clients.query(
      `INSERT INTO pcm_clients
        (full_name, email, phone, country_of_origin, jurisdiction,
         referral_source, referral_contact, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [full_name, email, phone, country_of_origin, jurisdiction,
       referral_source, referral_contact, notes]
    );

    await db.clients.query(
      `INSERT INTO pcm_client_pipeline_audit
        (client_id, from_stage, to_stage, transitioned_by, transition_role)
       VALUES ($1, NULL, 'intake', $2, $3)`,
      [result.rows[0].client_id, req.user.sub || 'system', req.user.role]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) { next(err); }
});

// ─── UPDATE CLIENT ────────────────────────────────────────────────────────────
router.patch('/:id', authorize('trade_group_owner','program_manager','intake_officer'), async (req, res, next) => {
  try {
    const allowed = ['full_name','email','phone','country_of_origin','jurisdiction',
                     'referral_source','referral_contact','notes',
                     'assigned_trade_group_owner','assigned_program_manager','assigned_intake_officer',
                     'bank_assignment'];
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
router.post('/:id/advance', authorize('trade_group_owner','program_manager','intake_officer'), async (req, res, next) => {
  try {
    const { to_stage, reason, notes } = req.body;
    if (!to_stage) return res.status(400).json({ error: 'to_stage is required' });

    const client = await db.clients.query(
      `SELECT * FROM pcm_clients WHERE client_id = $1 AND deleted_at IS NULL`,
      [req.params.id]
    );
    if (!client.rows.length) return res.status(404).json({ error: 'Client not found' });

    const from_stage = client.rows[0].pipeline_stage;

    const result = await db.clients.query(
      `UPDATE pcm_clients SET pipeline_stage = $1
       WHERE client_id = $2 RETURNING *`,
      [to_stage, req.params.id]
    );

    await db.clients.query(
      `INSERT INTO pcm_client_pipeline_audit
        (client_id, from_stage, to_stage, transitioned_by, transition_role, reason, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [req.params.id, from_stage, to_stage,
       req.user.sub || 'system', req.user.role, reason, notes]
    );

    res.json({ client: result.rows[0], transition: { from: from_stage, to: to_stage } });
  } catch (err) { next(err); }
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

// ─── RECORD OFAC RESULT ───────────────────────────────────────────────────────
router.post('/:id/ofac', authorize('trade_group_owner','program_manager','intake_officer'), async (req, res, next) => {
  try {
    const { provider, provider_reference_id, status,
            match_count, raw_response_summary, screened_by_agent } = req.body;

    if (!provider || !status) {
      return res.status(400).json({ error: 'provider and status are required' });
    }

    const result = await db.clients.query(
      `INSERT INTO pcm_ofac_results
        (client_id, provider, provider_reference_id, status,
         match_count, raw_response_summary, screened_by_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [req.params.id, provider, provider_reference_id, status,
       match_count || 0, raw_response_summary, screened_by_agent]
    );

    await db.clients.query(
      `UPDATE pcm_clients SET ofac_status = $1, ofac_screened_at = NOW(),
       ofac_provider = $2, ofac_reference_id = $3
       WHERE client_id = $4`,
      [status, provider, provider_reference_id, req.params.id]
    );

    res.status(201).json(result.rows[0]);
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
