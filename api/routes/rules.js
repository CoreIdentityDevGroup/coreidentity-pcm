'use strict';

const express  = require('express');
const db       = require('../services/db');
const { authorize } = require('../middleware/authorize');
const router   = express.Router();

const RULE_TYPES = ['kyc_instructions', 'pof_instructions', 'rules_of_the_road'];

// ─── LIST ALL ACTIVE RULES ────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const result = await db.clients.query(
      `SELECT * FROM pcm_rules_content WHERE active = true ORDER BY rule_type ASC`
    );
    res.json({ rules: result.rows });
  } catch (err) { next(err); }
});

// ─── GET SINGLE RULE BY TYPE ──────────────────────────────────────────────────
router.get('/:type', async (req, res, next) => {
  try {
    if (!RULE_TYPES.includes(req.params.type)) {
      return res.status(400).json({ error: `Unknown rule type '${req.params.type}'`, allowed: RULE_TYPES });
    }
    const result = await db.clients.query(
      `SELECT * FROM pcm_rules_content WHERE rule_type = $1 AND active = true`,
      [req.params.type]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Rule content not found' });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// ─── UPDATE RULE CONTENT (admin) ──────────────────────────────────────────────
router.put('/:type', authorize('trade_group_owner'), async (req, res, next) => {
  try {
    if (!RULE_TYPES.includes(req.params.type)) {
      return res.status(400).json({ error: `Unknown rule type '${req.params.type}'`, allowed: RULE_TYPES });
    }

    const { content, title } = req.body;
    if (content === undefined && title === undefined) {
      return res.status(400).json({ error: 'content and/or title is required' });
    }

    const updates = [];
    const params  = [];
    if (title !== undefined)   { params.push(title);   updates.push(`title = $${params.length}`); }
    if (content !== undefined) { params.push(content); updates.push(`content = $${params.length}`); }
    updates.push(`version = version + 1`);
    updates.push(`updated_at = NOW()`);

    params.push(req.params.type);
    const result = await db.clients.query(
      `UPDATE pcm_rules_content SET ${updates.join(', ')}
       WHERE rule_type = $${params.length} AND active = true RETURNING *`,
      params
    );

    if (!result.rows.length) return res.status(404).json({ error: 'Rule content not found' });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

module.exports = router;
