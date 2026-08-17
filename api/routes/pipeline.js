'use strict';
const governance = require('../services/governance');
const { sentinelCheck } = require('../services/governance');
'use strict';

const express  = require('express');
const { authorize } = require('../middleware/authorize');
const { requireOwnClientOrStaff } = require('../middleware/ownership');
const {
  advancePipeline,
  getPipelineStatus,
  validateGate,
  STAGES
} = require('../services/pipeline');
const router = express.Router();

// asset_id-scoped routes below look up the owning client_id directly.
const ownAssetId = requireOwnClientOrStaff(async req => {
  const db = require('../services/db');
  const idParam = req.params.asset_id || req.body.asset_id;
  const r = await db.assets.query(
    `SELECT client_id FROM pcm_assets WHERE asset_id = $1 AND deleted_at IS NULL`,
    [idParam]
  );
  return r.rows.length ? r.rows[0].client_id : null;
});

// ─── GET PIPELINE SUMMARY (count by status + recent entries) ──────────────────
// GET /api/v1/pipeline  — mounted with authenticate in app.js   /* fix-pipeline-summary */
// Platform-wide, cross-client (recent transitions across every client) --
// staff-only, same shape as /board and forms.js's monitoring/alerts.
router.get('/', authorize('administrator','program_manager','intake_officer'), async (_req, res, next) => {
  try {
    const db = require('../services/db');
    const byStatus = await db.clients.query(
      `SELECT to_stage AS status, COUNT(*)::int AS count
         FROM pcm_client_pipeline_audit
        GROUP BY to_stage
        ORDER BY count DESC`
    );
    const recent = await db.clients.query(
      `SELECT client_id, from_stage, to_stage, transitioned_by,
              transition_role, reason, notes, created_at
         FROM pcm_client_pipeline_audit
        ORDER BY created_at DESC
        LIMIT 20`
    );
    const total = byStatus.rows.reduce((sum, r) => sum + Number(r.count), 0);
    res.json({
      total,
      by_status: byStatus.rows,
      recent:    recent.rows,
      generated_at: new Date().toISOString()
    });
  } catch (err) { next(err); }
});


// ─── GET STAGE DEFINITIONS ────────────────────────────────────────────────────
router.get('/stages', (_req, res) => {
  res.json({ stages: STAGES });
});

// ─── GET PIPELINE STATUS FOR ASSET ───────────────────────────────────────────
router.get('/status/:asset_id', ownAssetId, async (req, res, next) => {
  try {
    const { client_id } = req.query;
    if (!client_id) return res.status(400).json({ error: 'client_id query param required' });

    const status = await getPipelineStatus(req.params.asset_id, client_id);
    if (!status) return res.status(404).json({ error: 'Asset not found' });
    res.json(status);
  } catch (err) { next(err); }
});

// ─── ADVANCE PIPELINE STAGE ───────────────────────────────────────────────────
// 2026-08-17 (Intake Officer scope, third revision): intake_officer
// removed. "Collects the package and routes it to legal. That is the
// whole job... no advancing past intake" -- this is literally the
// advance action. STAGES.kyc_verification.gate_roles below updated to
// match (program_manager, not intake_officer) since this route-level
// gate is the only live path to checkRoleAuthority's stage-specific
// check for a human actor -- an intake_officer assigned as legal's
// handler still can't reach it even via isAssignedHandler, since they
// never pass this outer authorize() at all. Recording what legal
// decided (legal-attestation entry/countersign, POF outcome) stays with
// Intake Officer; moving the deal forward to the next stage does not.
router.post('/advance', authorize('administrator','program_manager'), async (req, res, next) => {
  try {
    const { asset_id, client_id, to_stage, notes } = req.body;

    if (!asset_id || !client_id || !to_stage) {
      return res.status(400).json({ error: 'asset_id, client_id, to_stage required' });
    }

    const result = await advancePipeline({
      asset_id, client_id, to_stage,
      user: req.user, notes
    });

    if (!result.success) {
      return res.status(result.code).json({
        error: result.error,
        gate_errors: result.gate_errors
      });
    }

    res.json(result);
  } catch (err) { next(err); }
});

// ─── VALIDATE GATE (pre-flight check) ─────────────────────────────────────────
// Previously had no authorize() or ownership check at all -- any authenticated
// role, including 'client', could pre-flight-probe gate blockers for any
// other party's asset_id.
router.post('/validate', ownAssetId, async (req, res, next) => {
  try {
    const { asset_id, client_id, to_stage } = req.body;
    if (!asset_id || !client_id || !to_stage) {
      return res.status(400).json({ error: 'asset_id, client_id, to_stage required' });
    }

    const errors = await validateGate(to_stage, asset_id, client_id);
    res.json({
      stage: to_stage,
      ready: errors.length === 0,
      blockers: errors
    });
  } catch (err) { next(err); }
});

// ─── GET PIPELINE BOARD (all active assets by stage) ─────────────────────────
// Cross-client by design (every active asset org-wide) -- staff-only. A
// 'client' role has no legitimate use for the full trade pipeline board.
router.get('/board', authorize('administrator','program_manager','intake_officer'), async (req, res, next) => {
  try {
    const db = require('../services/db');
    const result = await db.assets.query(
      `SELECT a.asset_id, a.client_id, a.asset_type, a.pipeline_stage,
              a.pipeline_reference, a.declared_value, a.currency,
              a.bank_assignment, a.created_at,
              h.transitioned_by, h.created_at as last_transition
       FROM pcm_assets a
       LEFT JOIN LATERAL (
         SELECT transitioned_by, created_at FROM pcm_pipeline_history
         WHERE asset_id = a.asset_id ORDER BY created_at DESC LIMIT 1
       ) h ON true
       WHERE a.pipeline_stage NOT IN ('completed','rejected')
       ORDER BY a.pipeline_stage, a.created_at`
    );

    // Group by stage
    const board = {};
    for (const row of result.rows) {
      if (!board[row.pipeline_stage]) board[row.pipeline_stage] = [];
      board[row.pipeline_stage].push(row);
    }

    res.json({ board, total: result.rowCount });
  } catch (err) { next(err); }
});

// ─── REJECT ASSET ─────────────────────────────────────────────────────────────
router.post('/reject', authorize('administrator'), async (req, res, next) => {
  try {
    const { asset_id, client_id, reason } = req.body;
    if (!asset_id || !client_id || !reason) {
      return res.status(400).json({ error: 'asset_id, client_id, reason required' });
    }

    const result = await advancePipeline({
      asset_id, client_id, to_stage: 'rejected',
      user: req.user, notes: reason
    });

    res.json(result);
  } catch (err) { next(err); }
});

// ─── VERIFY INSTRUMENT INTEGRITY (human-review confirmation) ─────────────────
// CLOSE-GAP-04: the ONLY path permitted to set instrument_integrity_status
// to 'verified'. The instrument-integrity agent cannot self-clear this status.
router.post('/verify-instrument', authorize('program_manager'), async (req, res, next) => {
  try {
    const { asset_id, client_id, decision, verification_channel_note } = req.body;

    if (!asset_id || !client_id) {
      return res.status(400).json({ error: 'asset_id and client_id required' });
    }
    if (!['verified', 'blocked'].includes(decision)) {
      return res.status(400).json({ error: "decision must be 'verified' or 'blocked'" });
    }
    if (!verification_channel_note || !verification_channel_note.trim()) {
      return res.status(400).json({
        error: 'verification_channel_note required — document how this was independently confirmed (or why it is being blocked). Contact info from the submitted documents must NOT be used for verification.'
      });
    }

    const db = require('../services/db');
    const governance = require('../services/governance');

    const current = await db.assets.query(
      `SELECT instrument_integrity_status FROM pcm_assets WHERE asset_id = $1`,
      [asset_id]
    );
    if (!current.rows.length) {
      return res.status(404).json({ error: 'Asset not found' });
    }
    if (current.rows[0].instrument_integrity_status === 'verified') {
      return res.status(409).json({ error: 'Asset already verified — no action taken' });
    }

    // CLOSE-GAP-21: 'verified' must never be reachable with zero
    // instrument-integrity screening history. The agent only ever writes
    // 'blocked' or 'pending_human_verification' on completion (never
    // 'verified' itself) -- a row existing is the correct terminality
    // check. 'blocked' is left unrestricted: a human should be able to
    // proactively hold a suspicious asset without prior agent history.
    if (decision === 'verified') {
      const priorResult = await db.assets.query(
        `SELECT id FROM pcm_instrument_integrity_results WHERE asset_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [asset_id]
      );
      if (!priorResult.rows.length) {
        return res.status(422).json({
          error: 'Cannot verify — no instrument-integrity screening result on file for this asset'
        });
      }
    }

    const reviewedBy = req.user?.sub || req.user?.email || 'unknown_reviewer';

    await db.assets.query(
      `UPDATE pcm_assets SET instrument_integrity_status = $1 WHERE asset_id = $2`,
      [decision, asset_id]
    );

    await db.assets.query(
      `UPDATE pcm_instrument_integrity_results
         SET reviewed_by = $1, reviewed_at = NOW(), verification_channel_note = $2, status = $3
       WHERE id = (
         SELECT id FROM pcm_instrument_integrity_results
         WHERE asset_id = $4 ORDER BY created_at DESC LIMIT 1
       )`,
      [reviewedBy, verification_channel_note, decision, asset_id]
    );

    await governance.salLog({
      agent_id: reviewedBy,
      action:   `INSTRUMENT_INTEGRITY_REVIEW.${decision.toUpperCase()}`,
      resource: `pcm:asset:${asset_id}`,
      decision: decision === 'verified' ? 'ALLOW' : 'BLOCK',
      context:  { asset_id, client_id, reviewed_by: reviewedBy, verification_channel_note }
    });

    res.json({
      success: true,
      asset_id,
      instrument_integrity_status: decision,
      reviewed_by: reviewedBy
    });
  } catch (err) { next(err); }
});

// ─── HOLD ASSET ───────────────────────────────────────────────────────────────
router.post('/hold', authorize('program_manager'), async (req, res, next) => {
  try {
    const { asset_id, client_id, notes } = req.body;
    if (!asset_id || !client_id) {
      return res.status(400).json({ error: 'asset_id and client_id required' });
    }

    const result = await advancePipeline({
      asset_id, client_id, to_stage: 'on_hold',
      user: req.user, notes
    });

    res.json(result);
  } catch (err) { next(err); }
});

// ─── RESUME ASSET FROM HOLD (CLOSE-GAP-30) ─────────────────────────────────────
// The only valid exit from on_hold: back to exactly the stage the asset
// was on immediately before being held, reconstructed from
// pcm_pipeline_history. advancePipeline()'s own isValidTransition() check
// re-verifies this independently rather than trusting the lookup here.
router.post('/resume', authorize('program_manager'), async (req, res, next) => {
  try {
    const { asset_id, client_id, notes } = req.body;
    if (!asset_id || !client_id) {
      return res.status(400).json({ error: 'asset_id and client_id required' });
    }

    const db = require('../services/db');
    const priorStage = await db.assets.query(
      `SELECT from_stage FROM pcm_pipeline_history
       WHERE asset_id = $1 AND to_stage = 'on_hold'
       ORDER BY created_at DESC LIMIT 1`, [asset_id]
    );
    if (!priorStage.rows.length) {
      return res.status(409).json({ error: 'No on_hold transition found for this asset — nothing to resume' });
    }

    const result = await advancePipeline({
      asset_id, client_id, to_stage: priorStage.rows[0].from_stage,
      user: req.user, notes
    });

    res.json(result);
  } catch (err) { next(err); }
});

module.exports = router;
