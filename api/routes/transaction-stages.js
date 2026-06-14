'use strict';

const express  = require('express');
const db       = require('../services/db');
const { authorize } = require('../middleware/authorize');
const router   = express.Router();

const STAGE_STATUSES = ['pending', 'in_progress', 'completed', 'skipped', 'not_applicable'];

// ─── UPDATE PIPELINE STAGE (staff) ────────────────────────────────────────────
// Mounted on /api/v1/transactions, so the path is /:txId/stages/:stageNumber.
router.put('/:txId/stages/:stageNumber', authorize('trade_group_owner','program_manager','intake_officer'), async (req, res, next) => {
  try {
    const stageNumber = parseInt(req.params.stageNumber, 10);
    if (!Number.isInteger(stageNumber) || stageNumber < 1 || stageNumber > 8) {
      return res.status(400).json({ error: 'stageNumber must be an integer between 1 and 8' });
    }

    const { status, notes } = req.body;
    if (status !== undefined && !STAGE_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${STAGE_STATUSES.join(', ')}` });
    }
    if (status === undefined && notes === undefined) {
      return res.status(400).json({ error: 'No valid fields to update (status and/or notes)' });
    }

    const updates = [];
    const params  = [];
    if (status !== undefined) {
      params.push(status);
      updates.push(`status = $${params.length}`);
      // Stamp completion time only when moving to 'completed'.
      updates.push(status === 'completed' ? `completed_at = NOW()` : `completed_at = NULL`);
    }
    if (notes !== undefined) {
      params.push(notes);
      updates.push(`notes = $${params.length}`);
    }
    updates.push(`updated_at = NOW()`);

    params.push(req.params.txId);
    params.push(stageNumber);
    const result = await db.clients.query(
      `UPDATE pcm_transaction_stages SET ${updates.join(', ')}
       WHERE transaction_id = $${params.length - 1} AND stage_number = $${params.length}
       RETURNING *`,
      params
    );

    if (!result.rows.length) return res.status(404).json({ error: 'Transaction stage not found' });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

module.exports = router;
