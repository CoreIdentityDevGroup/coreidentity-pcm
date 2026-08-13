#!/usr/bin/env node
/**
 * CLOSE-GAP-23 (Phase 3.3): token-minting reconciliation
 *
 * Two implementations exist. api/services/pipeline.js's triggerTokenization()
 * is wired into advancePipeline() at to_stage === 'tokenization' and is the
 * ONLY writer of pcm_assets.token_id, which the completed-stage gate checks
 * for. agents/token-minting/index.js is unreachable (its only call site,
 * _unwiredStageAdvanceTriggers(), has zero callers) and, even if wired,
 * would not satisfy the gate: it writes a differently-shaped record to
 * pcm_asset_documents, never pcm_classification_tokens, and never touches
 * pcm_assets.token_id.
 *
 * Reconciliation: triggerTokenization() is canonical (no change needed
 * there). This script removes the dead, non-functional tokenization branch
 * from _unwiredStageAdvanceTriggers() so a future engineer can't wire it up
 * by mistake and get silent gate failures, and marks the superseded agent
 * module + manifest as dead rather than merely "unwired."
 *
 * No database access. Idempotent: detects the CLOSE-GAP-23 marker.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO_ROOT   = path.join(__dirname, '..');
const ASSETS_ROUTE = path.join(REPO_ROOT, 'api', 'routes', 'assets.js');
const AGENT_INDEX  = path.join(REPO_ROOT, 'agents', 'token-minting', 'index.js');
const MANIFEST     = path.join(REPO_ROOT, 'agents', 'token-minting', 'manifest.json');

const OLD_FN = `async function _unwiredStageAdvanceTriggers(assetId, asset, to_stage) {
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
  } else if (to_stage === 'completed') {`;

const NEW_FN = `async function _unwiredStageAdvanceTriggers(assetId, asset, to_stage) {
  const _stageOrch = require(require('path').join(__dirname, '../../agent-orchestrator'));

  // CLOSE-GAP-23 (Phase 3.3): the 'tokenization' branch that used to call
  // agents/token-minting is removed, not just left unwired. That module
  // writes a differently-shaped record to pcm_asset_documents and never
  // sets pcm_assets.token_id -- wiring it here would not satisfy the
  // completed-stage gate (which checks token_id), only create a confusing
  // duplicate side-effect. Real tokenization is api/services/pipeline.js's
  // triggerTokenization(), already wired into advancePipeline() at
  // to_stage === 'tokenization'. See agents/token-minting/index.js and its
  // manifest.json for the superseded-module marker.
  if (to_stage === 'completed') {`;

const MARKER = 'CLOSE-GAP-23';

function patchAssetsRoute() {
  let contents = fs.readFileSync(ASSETS_ROUTE, 'utf8');
  if (contents.includes(MARKER)) {
    console.log('✓ CLOSE-GAP-23 already applied to assets.js — no-op.');
    return;
  }
  if (!contents.includes(OLD_FN)) {
    console.error('✗ Expected _unwiredStageAdvanceTriggers() body not found — file may have changed.');
    process.exit(1);
  }
  contents = contents.replace(OLD_FN, NEW_FN);
  fs.writeFileSync(ASSETS_ROUTE, contents, 'utf8');
  console.log('✓ Removed dead tokenization branch from _unwiredStageAdvanceTriggers().');
}

function markAgentModuleDead() {
  let contents = fs.readFileSync(AGENT_INDEX, 'utf8');
  if (contents.includes(MARKER)) {
    console.log('✓ CLOSE-GAP-23 marker already present in token-minting/index.js — no-op.');
    return;
  }
  const banner = `'use strict';

// CLOSE-GAP-23 (Phase 3.3): SUPERSEDED / DEAD. This module has no reachable
// call site (was only invoked via api/routes/assets.js's
// _unwiredStageAdvanceTriggers(), which had zero callers and has now had
// this branch removed entirely). Even if wired, it would not satisfy the
// completed-stage gate: it writes to pcm_asset_documents, never
// pcm_classification_tokens or pcm_assets.token_id. Canonical tokenization
// is api/services/pipeline.js's triggerTokenization(), wired into
// advancePipeline(). Kept in the tree for reference only -- do not wire
// this module up without first replacing its DB writes to match the real
// pcm_classification_tokens schema.
`;
  contents = contents.replace(`'use strict';\n`, banner);
  fs.writeFileSync(AGENT_INDEX, contents, 'utf8');
  console.log('✓ Marked agents/token-minting/index.js as superseded/dead.');
}

function fixManifest() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  if (manifest.description.startsWith('[SUPERSEDED')) {
    console.log('✓ token-minting manifest already marked superseded — no-op.');
    return;
  }
  manifest.description = '[SUPERSEDED/DEAD — CLOSE-GAP-23: no reachable call site; real tokenization is api/services/pipeline.js triggerTokenization()] ' + manifest.description;
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log('✓ Marked token-minting manifest.json description as superseded.');
}

function main() {
  patchAssetsRoute();
  markAgentModuleDead();
  fixManifest();
  console.log('\nRunning npm run build...');
  execSync('npm run build', { cwd: REPO_ROOT, stdio: 'inherit' });
}

main();
