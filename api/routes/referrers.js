'use strict';
const express = require('express');
const db      = require('../services/db');
const { authorize } = require('../middleware/authorize');
const router  = express.Router();

// Referrers have no per-client ownership concept (flat CRM directory), but
// had NO authorize() at all -- any authenticated role, including 'client',
// could read referrer PII (email, phone) or create/modify referrer records.
// Staff-only, matching the tuple used throughout the rest of this codebase.

// GET /api/v1/referrers
router.get('/', authorize('trade_group_owner','program_manager','intake_officer'), async (req, res) => {
  const { type } = req.query;
  try {
    const query = type
      ? `SELECT * FROM pcm_referrers WHERE referral_type = $1 AND active = true ORDER BY contact_name`
      : `SELECT * FROM pcm_referrers WHERE active = true ORDER BY referral_type, contact_name`;
    const params = type ? [type] : [];
    const result = await db.clients.query(query, params);
    res.json({ referrers: result.rows, count: result.rowCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/referrers
router.post('/', authorize('trade_group_owner','program_manager','intake_officer'), async (req, res) => {
  const { referral_type, contact_name, company, email, phone, notes } = req.body;
  if (!referral_type || !contact_name)
    return res.status(400).json({ error: 'referral_type and contact_name required' });

  try {
    const result = await db.clients.query(
      `INSERT INTO pcm_referrers (referral_type, contact_name, company, email, phone, notes)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [referral_type, contact_name, company, email, phone, notes]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/v1/referrers/:id
router.patch('/:id', authorize('trade_group_owner','program_manager','intake_officer'), async (req, res) => {
  const { contact_name, company, email, phone, notes, active } = req.body;
  try {
    const result = await db.clients.query(
      `UPDATE pcm_referrers
       SET contact_name = COALESCE($1, contact_name),
           company      = COALESCE($2, company),
           email        = COALESCE($3, email),
           phone        = COALESCE($4, phone),
           notes        = COALESCE($5, notes),
           active       = COALESCE($6, active),
           updated_at   = NOW()
       WHERE referrer_id = $7
       RETURNING *`,
      [contact_name, company, email, phone, notes, active, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
