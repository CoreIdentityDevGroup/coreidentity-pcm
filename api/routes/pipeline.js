'use strict';
const governance = require('../services/governance');
const { sentinelCheck } = require('../services/governance');
'use strict';

const express  = require('express');
const { authorize } = require('../middleware/authorize');
const {
  advancePipeline,
  getPipelineStatus,
  validateGate,
  STAGES
} = require('../services/pipeline');
const router = express.Router();

// ─── GET STAGE DEFINITIONS ────────────────────────────────────────────────────
router.get('/stages', (_req, res) => {
  res.json({ stages: STAGES });
});

// ─── GET PIPELINE STATUS FOR ASSET ───────────────────────────────────────────
router.get('/status/:asset_id', async (req, res, next) => {
  try {
    const { client_id } = req.query;
    if (!client_id) return res.status(400).json({ error: 'client_id query param required' });

    const status = await getPipelineStatus(req.params.asset_id, client_id);
    if (!status) return res.status(404).json({ error: 'Asset not found' });
    res.json(status);
  } catch (err) { next(err); }
});

// ─── ADVANCE PIPELINE STAGE ───────────────────────────────────────────────────
router.post('/advance', authorize('trade_group_owner','program_manager','intake_officer'), async (req, res, next) => {
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
router.post('/validate', async (req, res, next) => {
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
router.get('/board', async (req, res, next) => {
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
router.post('/reject', authorize('trade_group_owner'), async (req, res, next) => {
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

// ─── HOLD ASSET ───────────────────────────────────────────────────────────────
router.post('/hold', authorize('trade_group_owner','program_manager'), async (req, res, next) => {
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

module.exports = router;
