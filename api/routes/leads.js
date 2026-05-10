'use strict';
const express = require('express');
const db      = require('../services/db');
const router  = express.Router();

// GET /api/v1/leads
router.get('/', async (req, res) => {
  const { status, limit = 50 } = req.query;
  try {
    const query = status
      ? `SELECT l.*, r.contact_name as referrer_name, r.company as referrer_company
         FROM pcm_leads l
         LEFT JOIN pcm_referrers r ON r.referrer_id = l.referrer_id
         WHERE l.status = $1
         ORDER BY l.created_at DESC LIMIT $2`
      : `SELECT l.*, r.contact_name as referrer_name, r.company as referrer_company
         FROM pcm_leads l
         LEFT JOIN pcm_referrers r ON r.referrer_id = l.referrer_id
         ORDER BY l.created_at DESC LIMIT $1`;
    const params = status ? [status, limit] : [limit];
    const result = await db.clients.query(query, params);
    res.json({ leads: result.rows, count: result.rowCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/leads
router.post('/', async (req, res) => {
  const { client_name, contact_info, service_type,
          referral_type, referrer_id, notes } = req.body;
  if (!client_name)
    return res.status(400).json({ error: 'client_name required' });

  try {
    const result = await db.clients.query(
      `INSERT INTO pcm_leads
         (submitted_by, client_name, contact_info, service_type,
          referral_type, referrer_id, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [req.user.sub, client_name, contact_info, service_type,
       referral_type, referrer_id, notes]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/v1/leads/:id
router.patch('/:id', async (req, res) => {
  const { status, notes } = req.body;
  try {
    const result = await db.clients.query(
      `UPDATE pcm_leads
       SET status = COALESCE($1, status),
           notes  = COALESCE($2, notes),
           updated_at = NOW()
       WHERE lead_id = $3 RETURNING *`,
      [status, notes, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
