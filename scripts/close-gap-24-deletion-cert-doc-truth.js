#!/usr/bin/env node
/**
 * CLOSE-GAP-24 (Phase 3.3): deletion-certification doc truth
 *
 * No inline substitute exists for this agent -- advancePipeline() has no
 * handling at all for to_stage === 'completed'. That is not the finding.
 * The finding is that the agent's own manifest asserts a capability the
 * code does not have: "Executes automated deletion of sensitive vault
 * contents at trade closure." The code (agents/deletion-certification/
 * index.js) issues a permanent pcm_deletion_certificates row asserting
 * every document was deleted, but contains no DELETE statement anywhere.
 *
 * This script does not wire the agent up and does not implement real
 * deletion -- that requires a product/legal decision (retention holds,
 * reversibility, what "delete" means for GCS-backed vault objects) that
 * is out of scope for an unattended run. It only corrects the manifest's
 * false claim and strengthens the existing code comments so the gap is
 * visible to the next reader without relying on this scrub's report.
 *
 * No database access. Idempotent: detects the CLOSE-GAP-24 marker.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO_ROOT   = path.join(__dirname, '..');
const ASSETS_ROUTE = path.join(REPO_ROOT, 'api', 'routes', 'assets.js');
const AGENT_INDEX  = path.join(REPO_ROOT, 'agents', 'deletion-certification', 'index.js');
const MANIFEST     = path.join(REPO_ROOT, 'agents', 'deletion-certification', 'manifest.json');

const MARKER = 'CLOSE-GAP-24';

const OLD_COMMENT_BLOCK = `// Phase 0 Q10 has not settled whether stage_8_trade_close refers to a
// transaction-stage or an asset-stage event; re-wiring this against the
// wrong object is exactly the mistake CLOSE-GAP-11 exists to unwind. Do not
// call this function until Q10 is resolved and the correct call site is
// chosen deliberately — not restored to its old location by default.`;

const NEW_COMMENT_BLOCK = `// Phase 0 Q10 has not settled whether stage_8_trade_close refers to a
// transaction-stage or an asset-stage event; re-wiring this against the
// wrong object is exactly the mistake CLOSE-GAP-11 exists to unwind. Do not
// call this function until Q10 is resolved and the correct call site is
// chosen deliberately — not restored to its old location by default.
//
// CLOSE-GAP-24 (Phase 3.3): the 'completed' branch specifically must not be
// wired up as-is even once Q10 is resolved. agents/deletion-certification
// issues a permanent pcm_deletion_certificates row asserting documents were
// deleted, but performs no deletion (no DELETE statement anywhere in that
// module, against pcm_kyc_documents/pcm_pof_records/pcm_asset_documents or
// GCS). Wiring this today would generate a false compliance certificate on
// every asset reaching 'completed', not close a gap. Real deletion is an
// out-of-scope product/legal decision (retention holds, reversibility,
// what "delete" means for GCS-backed vault objects), not a coding task.`;

function patchAssetsRouteComment() {
  let contents = fs.readFileSync(ASSETS_ROUTE, 'utf8');
  if (contents.includes(MARKER)) {
    console.log('✓ CLOSE-GAP-24 already applied to assets.js — no-op.');
    return;
  }
  if (!contents.includes(OLD_COMMENT_BLOCK)) {
    console.error('✗ Expected comment block not found — file may have changed since this script was written.');
    process.exit(1);
  }
  contents = contents.replace(OLD_COMMENT_BLOCK, NEW_COMMENT_BLOCK);
  fs.writeFileSync(ASSETS_ROUTE, contents, 'utf8');
  console.log('✓ Strengthened _unwiredStageAdvanceTriggers() warning comment.');
}

function fixManifest() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const FALSE_CLAIM = 'Executes automated deletion of sensitive vault contents at trade closure. Generates cryptographic deletion certificate.';
  if (manifest.description === FALSE_CLAIM) {
    manifest.description = 'Issues a deletion certificate at trade closure asserting vault contents were deleted. Does NOT itself delete anything -- no deletion logic exists in this codebase for the referenced documents (pcm_kyc_documents, pcm_pof_records, pcm_asset_documents) or their GCS objects. Not currently wired to any pipeline stage.';
    fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    console.log('✓ Corrected deletion-certification manifest.json false capability claim.');
  } else if (manifest.description.startsWith('Issues a deletion certificate')) {
    console.log('✓ deletion-certification manifest already corrected — no-op.');
  } else {
    console.error('✗ Manifest description does not match expected old or new text — manual review required.');
    process.exit(1);
  }
}

function strengthenAgentComment() {
  let contents = fs.readFileSync(AGENT_INDEX, 'utf8');
  if (contents.includes(MARKER)) {
    console.log('✓ CLOSE-GAP-24 marker already present in deletion-certification/index.js — no-op.');
    return;
  }
  const OLD = `  // Store cert reference. NOTE: no post-quantum signing backend exists in this
  // repo yet (manifest declares SLH-DSA-128s, but nothing implements it) — the
  // signature column is filled with an explicitly-labeled placeholder rather
  // than a fabricated value, so it reads as unsigned in any audit query.`;
  const NEW = `  // Store cert reference. NOTE: no post-quantum signing backend exists in this
  // repo yet (manifest declares SLH-DSA-128s, but nothing implements it) — the
  // signature column is filled with an explicitly-labeled placeholder rather
  // than a fabricated value, so it reads as unsigned in any audit query.
  //
  // CLOSE-GAP-24: this function does not delete anything. It only asserts
  // that deletion occurred (documents_certified, document_manifest with
  // certified_deleted_at timestamps, retention_period: 'permanent'). Do not
  // wire this into the pipeline believing it performs the deletion its own
  // output claims -- see api/routes/assets.js's _unwiredStageAdvanceTriggers()
  // for the full explanation.`;
  if (!contents.includes(OLD)) {
    console.error('✗ Expected comment block not found in deletion-certification/index.js.');
    process.exit(1);
  }
  contents = contents.replace(OLD, NEW);
  fs.writeFileSync(AGENT_INDEX, contents, 'utf8');
  console.log('✓ Strengthened deletion-certification/index.js non-deletion warning.');
}

function main() {
  patchAssetsRouteComment();
  fixManifest();
  strengthenAgentComment();
  console.log('\nRunning npm run build...');
  execSync('npm run build', { cwd: REPO_ROOT, stdio: 'inherit' });
}

main();
