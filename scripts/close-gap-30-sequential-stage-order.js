#!/usr/bin/env node
/**
 * CLOSE-GAP-30 (Phase 6.1 follow-up): advancePipeline() previously had no
 * sequential-stage-order enforcement at all -- it only checked role
 * authority and the TARGET stage's own GATE_REQUIREMENTS entry. An asset
 * could jump directly from intake to tokenization (minting a real
 * classification token) with zero KYC, POF, OFAC, appraisal, instrument-
 * integrity, bank-assignment, or agreement evidence, as long as the
 * target stage's own narrow gate happened to be satisfiable. Confirmed by
 * a test (tests/gates.stagejump.test.js) before this fix, which the same
 * change updates to assert the corrected behavior.
 *
 * Design, per explicit direction:
 *   - Stage order is read from STAGES -- the same object GATE_REQUIREMENTS
 *     keys off -- not a second, independently-maintained ordering.
 *   - Ordinary forward progression: to_stage's order must be EXACTLY
 *     from_stage's order + 1. No skipping.
 *   - rejected: reachable from any non-terminal stage at any time,
 *     preserving existing behavior (the /reject route never restricted
 *     which stage an asset could be rejected from).
 *   - on_hold: reachable from any non-terminal stage (pause), same as
 *     reject.
 *   - Resuming FROM on_hold: valid ONLY to the exact stage the asset was
 *     on immediately before being held, reconstructed from
 *     pcm_pipeline_history (from_stage on that asset's most recent
 *     to_stage = 'on_hold' row) -- never any other target. No resume
 *     route existed before this change; one is added (POST
 *     /pipeline/resume) so this is actually reachable, not just
 *     theoretically valid.
 *   - All other backward transitions: blocked entirely. Read the whole
 *     gate-checking codebase for a legitimate backward case (e.g. a
 *     rejected appraisal sending an asset back for revaluation) -- none
 *     exists. Nothing in this codebase ever decrements pipeline_stage
 *     outside of on_hold/rejected. If a real backward-transition need is
 *     discovered later, it needs the same dual-control treatment as the
 *     OFAC out-of-band attestation (CLOSE-GAP-26) -- an explicit,
 *     distinctly-recorded action, never a silent decrement -- not
 *     assumed or built speculatively here.
 *
 * No database access -- source file edits only. Idempotent.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO_ROOT      = path.join(__dirname, '..');
const PIPELINE_SVC    = path.join(REPO_ROOT, 'api', 'services', 'pipeline.js');
const PIPELINE_ROUTE  = path.join(REPO_ROOT, 'api', 'routes', 'pipeline.js');

const MARKER = 'CLOSE-GAP-30';

// ── api/services/pipeline.js ────────────────────────────────────────────────

const OLD_STAGES_CLOSE = `  rejected:         { order: 0, gate_role: 'trade_group_owner', label: 'Rejected' },
  on_hold:          { order: 0, gate_role: 'program_manager',   label: 'On Hold' }
};`;

const NEW_STAGES_CLOSE = `  rejected:         { order: 0, gate_role: 'trade_group_owner', label: 'Rejected' },
  on_hold:          { order: 0, gate_role: 'program_manager',   label: 'On Hold' }
};

// CLOSE-GAP-30: sequential-stage-order enforcement, previously absent
// entirely. Reads order from STAGES above -- the same source
// GATE_REQUIREMENTS keys off -- not a second ordering. See this script's
// header (scripts/close-gap-30-sequential-stage-order.js) for the full
// design rationale (why rejected/on_hold are any-stage exits, why
// on_hold's return is the one narrow exception, why all other backward
// moves are blocked outright).
function isValidTransition(from_stage, to_stage, priorStageBeforeHold) {
  if (to_stage === 'rejected') {
    return from_stage !== 'rejected' && from_stage !== 'completed';
  }
  if (to_stage === 'on_hold') {
    return from_stage !== 'rejected' && from_stage !== 'completed' && from_stage !== 'on_hold';
  }
  if (from_stage === 'on_hold') {
    return priorStageBeforeHold != null && to_stage === priorStageBeforeHold;
  }
  if (from_stage === 'rejected') {
    return false; // terminal -- no transitions out
  }
  const fromOrder = STAGES[from_stage]?.order;
  const toOrder   = STAGES[to_stage]?.order;
  if (fromOrder == null || toOrder == null) return false;
  return toOrder === fromOrder + 1;
}`;

function patchPipelineService() {
  let contents = fs.readFileSync(PIPELINE_SVC, 'utf8');
  if (contents.includes(MARKER)) {
    console.log('✓ CLOSE-GAP-30 already applied to api/services/pipeline.js — no-op.');
    return;
  }

  if (!contents.includes(OLD_STAGES_CLOSE)) {
    console.error('✗ STAGES closing block not found — file may have changed.');
    process.exit(1);
  }
  contents = contents.replace(OLD_STAGES_CLOSE, NEW_STAGES_CLOSE);

  const OLD_FROM_STAGE_BLOCK = `  const from_stage = asset.rows[0].pipeline_stage;

  // CLOSE-GAP-16: Sentinel enforcement gate, fail-closed.`;

  const NEW_FROM_STAGE_BLOCK = `  const from_stage = asset.rows[0].pipeline_stage;

  // CLOSE-GAP-30: sequential-order check, before Sentinel (same
  // ordering as the gate-requirements check above -- local, cheaper
  // checks first). Resuming from on_hold needs the pre-hold stage,
  // reconstructed from pcm_pipeline_history -- the only place it's
  // recorded, since no separate "held_from_stage" column exists.
  let priorStageBeforeHold = null;
  if (from_stage === 'on_hold') {
    const priorStageResult = await db.assets.query(
      \`SELECT from_stage FROM pcm_pipeline_history
       WHERE asset_id = $1 AND to_stage = 'on_hold'
       ORDER BY created_at DESC LIMIT 1\`, [asset_id]
    );
    priorStageBeforeHold = priorStageResult.rows[0]?.from_stage || null;
  }
  if (!isValidTransition(from_stage, to_stage, priorStageBeforeHold)) {
    return {
      success: false, code: 422,
      error: \`Invalid stage transition: \${from_stage} -> \${to_stage}. Stages must advance one at a time; direct jumps are rejected.\`,
      block_reason: 'blocked_invalid_transition'
    };
  }

  // CLOSE-GAP-16: Sentinel enforcement gate, fail-closed.`;

  if (!contents.includes(OLD_FROM_STAGE_BLOCK)) {
    console.error('✗ from_stage/Sentinel-comment block not found — file may have changed.');
    process.exit(1);
  }
  contents = contents.replace(OLD_FROM_STAGE_BLOCK, NEW_FROM_STAGE_BLOCK);

  const OLD_EXPORTS = `module.exports = { advancePipeline, getPipelineStatus, validateGate, STAGES };`;
  const NEW_EXPORTS = `module.exports = { advancePipeline, getPipelineStatus, validateGate, STAGES, isValidTransition };`;
  if (!contents.includes(OLD_EXPORTS)) {
    console.error('✗ module.exports line not found — file may have changed.');
    process.exit(1);
  }
  contents = contents.replace(OLD_EXPORTS, NEW_EXPORTS);

  fs.writeFileSync(PIPELINE_SVC, contents, 'utf8');
  console.log('✓ api/services/pipeline.js: sequential-stage-order enforcement added.');
}

// ── api/routes/pipeline.js: new POST /resume route ──────────────────────────

function patchPipelineRoute() {
  let contents = fs.readFileSync(PIPELINE_ROUTE, 'utf8');
  if (contents.includes(MARKER)) {
    console.log('✓ CLOSE-GAP-30 already applied to api/routes/pipeline.js — no-op.');
    return;
  }

  const OLD_HOLD_ROUTE = `// ─── HOLD ASSET ───────────────────────────────────────────────────────────────
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

module.exports = router;`;

  const NEW_HOLD_ROUTE = `// ─── HOLD ASSET ───────────────────────────────────────────────────────────────
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

// ─── RESUME ASSET FROM HOLD (CLOSE-GAP-30) ─────────────────────────────────────
// The only valid exit from on_hold: back to exactly the stage the asset
// was on immediately before being held, reconstructed from
// pcm_pipeline_history. advancePipeline()'s own isValidTransition() check
// re-verifies this independently rather than trusting the lookup here.
router.post('/resume', authorize('trade_group_owner','program_manager'), async (req, res, next) => {
  try {
    const { asset_id, client_id, notes } = req.body;
    if (!asset_id || !client_id) {
      return res.status(400).json({ error: 'asset_id and client_id required' });
    }

    const db = require('../services/db');
    const priorStage = await db.assets.query(
      \`SELECT from_stage FROM pcm_pipeline_history
       WHERE asset_id = $1 AND to_stage = 'on_hold'
       ORDER BY created_at DESC LIMIT 1\`, [asset_id]
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

module.exports = router;`;

  if (!contents.includes(OLD_HOLD_ROUTE)) {
    console.error('✗ Expected /hold route + module.exports block not found — file may have changed.');
    process.exit(1);
  }
  contents = contents.replace(OLD_HOLD_ROUTE, NEW_HOLD_ROUTE);
  fs.writeFileSync(PIPELINE_ROUTE, contents, 'utf8');
  console.log('✓ api/routes/pipeline.js: POST /resume route added.');
}

function main() {
  patchPipelineService();
  patchPipelineRoute();
  console.log('\nRunning npm run build...');
  execSync('npm run build', { cwd: REPO_ROOT, stdio: 'inherit' });
}

main();
