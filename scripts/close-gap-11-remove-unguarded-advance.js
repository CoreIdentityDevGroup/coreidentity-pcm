#!/usr/bin/env node
/**
 * CLOSE-GAP-11: Remove the unguarded POST /api/v1/assets/:id/advance path
 *
 * Finding: this route updated pcm_assets.pipeline_stage directly, with no
 * call to checkRoleAuthority(), no call to validateGate()/GATE_REQUIREMENTS,
 * and no call to sentinelCheck(). It coexisted with POST /api/v1/pipeline/
 * advance, which does call all three. Two routes reaching the same column
 * with different enforcement means the enforced one was never the only one.
 *
 * Fix: the route is not deleted (a 404 here would be indistinguishable from
 * a typo in the URL; a 410 states plainly that this used to work and won't
 * again). The handler body is replaced with a 410 Gone pointing callers at
 * POST /api/v1/pipeline/advance.
 *
 * The token-minting and deletion-certification auto-triggers that lived
 * inside this handler are moved into a dormant, unexported function in the
 * same file (_unwiredStageAdvanceTriggers) rather than deleted. They are not
 * re-wired anywhere. Phase 0 Q10 has not settled whether stage_8_trade_close
 * refers to a transaction-stage or an asset-stage event; wiring these two
 * agent calls to the wrong object is the exact class of mistake this script
 * exists to unwind, so re-wiring is left as a marked TODO(gap-12) for a
 * separate, deliberate change once Q10 resolves.
 *
 * No database access of any kind — this script only edits source files and
 * runs `npm run build` (which validates agent manifests, not the database).
 *
 * Idempotent: detects the existing 410 handler before writing; no-ops
 * cleanly on re-run.
 * Ends with: npm run build
 *
 * Run: node scripts/close-gap-11-remove-unguarded-advance.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const TARGET    = path.join(REPO_ROOT, 'api', 'routes', 'assets.js');

const OLD_BLOCK = `// ─── ADVANCE ASSET PIPELINE STAGE ─────────────────────────────────────────────
router.post('/:id/advance', authorize('trade_group_owner','program_manager','intake_officer'), async (req, res, next) => {
  try {
    const { to_stage, notes } = req.body;
    if (!to_stage) return res.status(400).json({ error: 'to_stage is required' });

    const asset = await db.assets.query(
      \`SELECT * FROM pcm_assets WHERE asset_id = $1 AND deleted_at IS NULL\`, [req.params.id]
    );
    if (!asset.rows.length) return res.status(404).json({ error: 'Asset not found' });

    const from_stage = asset.rows[0].pipeline_stage;

    const result = await db.assets.query(
      \`UPDATE pcm_assets SET pipeline_stage = $1
       WHERE asset_id = $2 RETURNING *\`,
      [to_stage, req.params.id]
    );

    await db.assets.query(
      \`INSERT INTO pcm_pipeline_history
        (asset_id, client_id, from_stage, to_stage, transitioned_by, transition_role, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7)\`,
      [req.params.id, asset.rows[0].client_id,
       from_stage, to_stage, req.user.sub || 'system', req.user.role, notes]
    );

    // AUTO-TRIGGER: token-minting (tokenization) / deletion-certification (completed)
    if (to_stage === 'tokenization' || to_stage === 'completed') {
      const _stageOrch = require(require('path').join(__dirname, '../../agent-orchestrator'));
      const _asset = result.rows[0];
      Promise.resolve().then(async () => {
        if (to_stage === 'tokenization') {
          const val = await db.assets.query(
            \`SELECT appraised_value FROM pcm_valuations
             WHERE asset_id = $1 ORDER BY created_at DESC LIMIT 1\`,
            [req.params.id]
          );
          const r = await _stageOrch.runAgent('token-minting', {
            asset_id:           req.params.id,
            client_id:          _asset.client_id,
            pipeline_reference: _asset.pipeline_reference,
            appraised_value:    val.rows[0]?.appraised_value || _asset.declared_value,
            currency:           _asset.currency,
            bank_assignment:    _asset.bank_assignment,
            triggered_by:       'auto'
          });
          console.log(JSON.stringify({ level:'info', message:'token-minting done', status: r.status }));
        } else {
          const r = await _stageOrch.runAgent('deletion-certification', {
            asset_id:           req.params.id,
            client_id:          _asset.client_id,
            pipeline_reference: _asset.pipeline_reference,
            triggered_by:       'auto'
          });
          console.log(JSON.stringify({ level:'info', message:'deletion-certification done', status: r.status }));
        }
      }).catch(err => console.error(JSON.stringify({ level:'error', message:'Stage-advance auto-trigger error', error: err.message })));
    }

    res.json({ asset: result.rows[0], transition: { from: from_stage, to: to_stage } });
  } catch (err) { next(err); }
});`;

const NEW_BLOCK = `// ─── ADVANCE ASSET PIPELINE STAGE — REMOVED (CLOSE-GAP-11) ───────────────────
// This route used to update pcm_assets.pipeline_stage directly, with no
// role-authority check, no GATE_REQUIREMENTS check, and no sentinelCheck()
// call — a second, unguarded path to the same transition that
// POST /api/v1/pipeline/advance already gates. Route kept (not deleted) so
// a caller gets 410 Gone instead of a 404 that could pass for a typo.
router.post('/:id/advance', authorize('trade_group_owner','program_manager','intake_officer'), (req, res) => {
  res.status(410).json({
    error:       'Gone',
    message:     'This endpoint no longer advances pipeline stage. It performed no role-authority, gate, or Sentinel checks. Use POST /api/v1/pipeline/advance instead.',
    use_instead: '/api/v1/pipeline/advance'
  });
});

// TODO(gap-12): token-minting / deletion-certification triggers, unwired.
// Moved off POST /:id/advance by CLOSE-GAP-11
// (scripts/close-gap-11-remove-unguarded-advance.js) rather than deleted.
// Not called from anywhere in this file or elsewhere in the repo.
// Phase 0 Q10 has not settled whether stage_8_trade_close refers to a
// transaction-stage or an asset-stage event; re-wiring this against the
// wrong object is exactly the mistake CLOSE-GAP-11 exists to unwind. Do not
// call this function until Q10 is resolved and the correct call site is
// chosen deliberately — not restored to its old location by default.
async function _unwiredStageAdvanceTriggers(assetId, asset, to_stage) {
  const _stageOrch = require(require('path').join(__dirname, '../../agent-orchestrator'));

  if (to_stage === 'tokenization') {
    const val = await db.assets.query(
      \`SELECT appraised_value FROM pcm_valuations
       WHERE asset_id = $1 ORDER BY created_at DESC LIMIT 1\`,
      [assetId]
    );
    const r = await _stageOrch.runAgent('token-minting', {
      asset_id:           assetId,
      client_id:          asset.client_id,
      pipeline_reference: asset.pipeline_reference,
      appraised_value:    val.rows[0]?.appraised_value || asset.declared_value,
      currency:           asset.currency,
      bank_assignment:    asset.bank_assignment,
      triggered_by:       'auto'
    });
    console.log(JSON.stringify({ level:'info', message:'token-minting done', status: r.status }));
  } else if (to_stage === 'completed') {
    const r = await _stageOrch.runAgent('deletion-certification', {
      asset_id:           assetId,
      client_id:          asset.client_id,
      pipeline_reference: asset.pipeline_reference,
      triggered_by:       'auto'
    });
    console.log(JSON.stringify({ level:'info', message:'deletion-certification done', status: r.status }));
  }
}`;

function main() {
  if (!fs.existsSync(TARGET)) {
    console.error(`✗ Target file not found: ${TARGET}`);
    process.exit(1);
  }

  const contents = fs.readFileSync(TARGET, 'utf8');

  if (contents.includes('CLOSE-GAP-11')) {
    console.log('✓ CLOSE-GAP-11 already applied — no-op.');
    return;
  }

  if (!contents.includes(OLD_BLOCK)) {
    console.error('✗ Expected /:id/advance handler not found — file may have changed since this script was written.');
    console.error('  Refusing to apply blind edit. Manual review required.');
    process.exit(1);
  }

  fs.writeFileSync(TARGET, contents.replace(OLD_BLOCK, NEW_BLOCK), 'utf8');
  console.log('✓ CLOSE-GAP-11 applied: POST /api/v1/assets/:id/advance now returns 410, points to /api/v1/pipeline/advance.');
  console.log('  token-minting / deletion-certification triggers moved to dormant _unwiredStageAdvanceTriggers() — TODO(gap-12), not called.');

  console.log('\nRunning npm run build...');
  execSync('npm run build', { cwd: REPO_ROOT, stdio: 'inherit' });
}

main();
