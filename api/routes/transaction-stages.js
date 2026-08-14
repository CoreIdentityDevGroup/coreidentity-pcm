'use strict';

const express  = require('express');
const db       = require('../services/db');
const { authorize } = require('../middleware/authorize');
const router   = express.Router();

const STAGE_STATUSES = ['pending', 'in_progress', 'completed', 'skipped', 'not_applicable'];
const TERMINAL_STATUSES = ['completed', 'skipped', 'not_applicable'];

// ─── UPDATE PIPELINE STAGE (staff) ────────────────────────────────────────────
// Mounted on /api/v1/transactions, so the path is /:txId/stages/:stageNumber.
//
// Real gating, not a bare status flip -- this table had none until this pass
// (found live and reachable during the fabricated-governance sweep; a prior
// session's "inert, zero rows, deferred" conclusion was withdrawn once the
// routes were confirmed mounted and reachable). Mirrors the asset pipeline's
// enforcement shape (api/services/pipeline.js: isValidTransition, evidence
// requirements, gated client attestation) at the level this generic 8-stage
// model actually supports -- it has no per-stage domain semantics the way
// the asset pipeline's named stages do (kyc_verification, appraisal_review,
// etc.), so this does NOT invent per-stage evidence requirements it has no
// basis for. What it enforces for real:
//   1. Sequential order -- stage N can only be completed once 1..N-1 are
//      each in a terminal status (completed/skipped/not_applicable).
//   2. Evidence -- completing a stage requires a non-empty `notes` value.
//   3. The client rules-acknowledgment gate (transactions.js's
//      POST /:id/acknowledge-rules) actually blocks stage completion now,
//      instead of being a self-attested field nothing ever reads.
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

    if (status === 'completed') {
      const txResult = await db.clients.query(
        `SELECT rules_acknowledged FROM pcm_transactions WHERE transaction_id = $1`,
        [req.params.txId]
      );
      if (!txResult.rows.length) return res.status(404).json({ error: 'Transaction not found' });
      if (!txResult.rows[0].rules_acknowledged) {
        return res.status(422).json({
          error: 'Client has not acknowledged rules for this transaction — ' +
                 'POST /:id/acknowledge-rules must be completed before any stage can be marked completed',
        });
      }

      const priorStages = await db.clients.query(
        `SELECT stage_number, status FROM pcm_transaction_stages
         WHERE transaction_id = $1 AND stage_number < $2 ORDER BY stage_number ASC`,
        [req.params.txId, stageNumber]
      );
      const incomplete = priorStages.rows.filter(s => !TERMINAL_STATUSES.includes(s.status));
      if (incomplete.length) {
        return res.status(422).json({
          error: 'Cannot complete this stage — prior stages are not yet resolved',
          incomplete_stages: incomplete.map(s => s.stage_number),
        });
      }

      if (!notes || !String(notes).trim()) {
        // Fall back to checking whatever notes value is already on record, in
        // case this call only sets status and notes were recorded earlier.
        const existingNotes = await db.clients.query(
          `SELECT notes FROM pcm_transaction_stages WHERE transaction_id = $1 AND stage_number = $2`,
          [req.params.txId, stageNumber]
        );
        const onRecord = existingNotes.rows[0]?.notes;
        if (!onRecord || !String(onRecord).trim()) {
          return res.status(422).json({
            error: 'Cannot mark a stage completed without evidence — `notes` must be a non-empty string',
          });
        }
      }
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
