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
      [req.user?.sub || 'system', client_name, contact_info, service_type,
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

// POST /api/v1/leads/public — no auth required — public intake form
router.post('/public', async (req, res, next) => {
  try {
    const {
      client_name, contact_info, service_type, referral_type,
      notes, role, estimated_value, currency
    } = req.body;

    if (!client_name || !contact_info) {
      return res.status(400).json({ error: 'client_name and contact_info required' });
    }

    const result = await db.clients.query(
      `INSERT INTO pcm_leads
         (client_name, contact_info, service_type, referral_type,
          notes, status, submitted_by)
       VALUES ($1, $2, $3, $4, $5, 'new', 'public-intake')
       RETURNING lead_id, client_name, status, created_at`,
      [client_name, contact_info,
       service_type || null,
       referral_type || role || null,
       [notes, estimated_value ? `Est. Value: ${currency || 'USD'} ${estimated_value}` : '']
         .filter(Boolean).join(' | ') || null]
    );

    const lead = result.rows[0];

    // SAL governance log — non-blocking
    const { salLog } = require('../services/governance');
    salLog({
      action:   'PUBLIC_INTAKE_SUBMISSION',
      resource: `pcm:lead:${lead.lead_id}`,
      decision: 'ALLOW',
      context:  { client_name, contact_info, role, service_type }
    }).catch(() => {});

    res.status(201).json({
      success:   true,
      lead_id:   lead.lead_id,
      reference: `COREG-${lead.lead_id.split('-')[0].toUpperCase()}`,
      message:   'Intake submitted successfully'
    });
  } catch (err) { next(err); }
});


module.exports = router;
