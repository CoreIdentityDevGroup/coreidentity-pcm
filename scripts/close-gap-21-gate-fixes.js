#!/usr/bin/env node
/**
 * CLOSE-GAP-21: two related gate-correctness fixes
 *
 * (1) GATE_REQUIREMENTS has no entry for 'rejected' or 'on_hold'.
 * validateGate()'s own CLOSE-GAP-12-C1 rule ("absence of a gate
 * definition is never a pass, must throw") means every call to
 * POST /pipeline/reject and POST /pipeline/hold currently 422s,
 * unconditionally -- both routes are broken. This is a direct
 * consequence of gap-12's own fix: correctly fail-closed as a general
 * rule, but it didn't account for administrative/terminal stages that
 * have no forward-progress data precondition to check in the first
 * place. Fix: add explicit, always-pass gate entries for both --
 * role authority (checkRoleAuthority(), unaffected by this change) is
 * the real and sufficient control for rejecting or holding an asset.
 * This is a deliberate, reviewable "no data precondition" entry, not a
 * silent gap the way the pre-gap-12 missing-entry behavior was.
 *
 * (2) POST /verify-instrument (Phase 1 finding, not fixed until now):
 * could set instrument_integrity_status='verified' with zero
 * pcm_instrument_integrity_results rows on file -- the UPDATE ran
 * unconditionally; only a later, separate UPDATE (keyed by a subquery
 * that silently no-ops if no row exists) tried to record the review.
 * Fix: require at least one pcm_instrument_integrity_results row to
 * exist for the asset before permitting decision='verified'. The
 * instrument-integrity agent only ever writes 'blocked' or
 * 'pending_human_verification' (never 'verified' itself, confirmed in
 * CLOSE-GAP-18's investigation) -- since the agent runs synchronously
 * and always leaves exactly one of those two on completion, "a row
 * exists" is the correct terminality check; there is no separate
 * in-progress state to distinguish. Scoped to decision='verified' only --
 * blocking an asset (the more conservative action) is left unrestricted,
 * since a human should be able to proactively hold a suspicious asset
 * even without prior agent history.
 *
 * No database access of any kind -- this script only edits source files
 * and runs `npm run build`.
 *
 * Idempotent: detects the existing CLOSE-GAP-21 marker before writing;
 * no-ops cleanly on re-run.
 *
 * Run: node scripts/close-gap-21-gate-fixes.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO_ROOT      = path.join(__dirname, '..');
const PIPELINE_FILE  = path.join(REPO_ROOT, 'api', 'services', 'pipeline.js');
const ROUTES_FILE    = path.join(REPO_ROOT, 'api', 'routes', 'pipeline.js');

// ─────────────────────────────────────────────────────────────────────────────
// (1) GATE_REQUIREMENTS entries for rejected / on_hold
// ─────────────────────────────────────────────────────────────────────────────

const OLD_GATES_TAIL = `  completed: async (asset_id, client_id) => {
    const asset = await db.assets.query(
      \`SELECT token_id FROM pcm_assets WHERE asset_id = $1\`, [asset_id]
    );
    const errors = [];
    if (!asset.rows[0]?.token_id) errors.push('No classification token minted for this asset');
    return errors;
  }
};`;

const NEW_GATES_TAIL = `  completed: async (asset_id, client_id) => {
    const asset = await db.assets.query(
      \`SELECT token_id FROM pcm_assets WHERE asset_id = $1\`, [asset_id]
    );
    const errors = [];
    if (!asset.rows[0]?.token_id) errors.push('No classification token minted for this asset');
    return errors;
  },

  // CLOSE-GAP-21: 'rejected' and 'on_hold' are administrative/terminal
  // stages, not forward-progress gates -- there is no data precondition
  // to check the way kyc_verification/appraisal_review/etc. gate forward
  // movement on evidence. checkRoleAuthority() is the real control for
  // both. Explicit always-pass entries, not a silent gap: before this,
  // the absence of any entry made validateGate() throw (CLOSE-GAP-12-C1's
  // own "no gate definition = block" rule), which made every call to
  // POST /pipeline/reject and POST /pipeline/hold 422 unconditionally.
  rejected: async () => [],
  on_hold:  async () => []
};`;

// ─────────────────────────────────────────────────────────────────────────────
// (2) verify-instrument terminal-row check
// ─────────────────────────────────────────────────────────────────────────────

const OLD_VERIFY = `    const current = await db.assets.query(
      \`SELECT instrument_integrity_status FROM pcm_assets WHERE asset_id = $1\`,
      [asset_id]
    );
    if (!current.rows.length) {
      return res.status(404).json({ error: 'Asset not found' });
    }
    if (current.rows[0].instrument_integrity_status === 'verified') {
      return res.status(409).json({ error: 'Asset already verified — no action taken' });
    }

    const reviewedBy = req.user?.sub || req.user?.email || 'unknown_reviewer';`;

const NEW_VERIFY = `    const current = await db.assets.query(
      \`SELECT instrument_integrity_status FROM pcm_assets WHERE asset_id = $1\`,
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
        \`SELECT id FROM pcm_instrument_integrity_results WHERE asset_id = $1 ORDER BY created_at DESC LIMIT 1\`,
        [asset_id]
      );
      if (!priorResult.rows.length) {
        return res.status(422).json({
          error: 'Cannot verify — no instrument-integrity screening result on file for this asset'
        });
      }
    }

    const reviewedBy = req.user?.sub || req.user?.email || 'unknown_reviewer';`;

function applyTo(targetPath, replacements, label) {
  if (!fs.existsSync(targetPath)) {
    console.error(`✗ Target file not found: ${targetPath}`);
    process.exit(1);
  }
  let contents = fs.readFileSync(targetPath, 'utf8');

  for (const [oldBlock, newBlock] of replacements) {
    if (!contents.includes(oldBlock)) {
      console.error(`✗ Expected block not found in ${label} — file may have changed since this script was written.`);
      console.error('  Refusing to apply blind edit. Manual review required.');
      process.exit(1);
    }
    contents = contents.replace(oldBlock, newBlock);
  }

  fs.writeFileSync(targetPath, contents, 'utf8');
}

function main() {
  const pipelineSrc = fs.readFileSync(PIPELINE_FILE, 'utf8');
  const routesSrc    = fs.readFileSync(ROUTES_FILE, 'utf8');

  if (pipelineSrc.includes('CLOSE-GAP-21') && routesSrc.includes('CLOSE-GAP-21')) {
    console.log('✓ CLOSE-GAP-21 already applied — no-op.');
    return;
  }

  applyTo(PIPELINE_FILE, [[OLD_GATES_TAIL, NEW_GATES_TAIL]], 'api/services/pipeline.js');
  applyTo(ROUTES_FILE,   [[OLD_VERIFY, NEW_VERIFY]],         'api/routes/pipeline.js');

  console.log('✓ CLOSE-GAP-21 applied:');
  console.log('  - GATE_REQUIREMENTS.rejected / .on_hold added (always pass; role check is the control)');
  console.log('  - POST /verify-instrument requires a pcm_instrument_integrity_results row before verified');

  console.log('\nRunning npm run build...');
  execSync('npm run build', { cwd: REPO_ROOT, stdio: 'inherit' });
}

main();
