#!/usr/bin/env node
/**
 * CLOSE-GAP-16: wire sentinelCheck() into advancePipeline(), fail-closed
 *
 * Prerequisite, done separately and deployed first (Step 4a): pcm-api's
 * task definition must already have SENTINEL_JWT_SECRET wired (valueFrom
 * ops-jwt-secret) before this is deployed. Deploying this gate with the
 * secret absent would take every pipeline advance offline immediately
 * (sentinelCheck() fails closed with no secret configured) -- that
 * ordering is enforced by process, not by this script, which only edits
 * source.
 *
 * Placement: after role authority + gate requirements (the existing local
 * checks) both pass, before any database mutation. A rejected or
 * unreachable Sentinel blocks the transition the same way failed gate
 * requirements already do -- no new failure class as far as the caller of
 * advancePipeline() is concerned, just a new *reason* for the existing
 * "blocked" outcome.
 *
 * gap-12 status model extended with a third state: 'blocked_unavailable',
 * distinct from 'blocked_error' (an exception was thrown) and
 * 'blocked_pending' (the system answered and the answer was no --
 * unmet gate requirements, or now also a genuine Sentinel BLOCK decision).
 * 'blocked_unavailable' means the policy engine itself could not be
 * reached or did not respond in time (BLOCK_SENTINEL_UNAVAILABLE /
 * BLOCK_SENTINEL_ERROR / BLOCK_SENTINEL_TIMEOUT from CLOSE-GAP-14/15) --
 * a materially different fact for an audit record than "policy said no."
 *
 * The asset/client existence read (previously step 3) is moved ahead of
 * the new Sentinel check and its SELECT extended to include
 * pipeline_reference, which Sentinel's HIGH_RISK_ACTIONS context check
 * expects alongside client_id.
 *
 * No database access of any kind -- this script only edits source files
 * and runs `npm run build`.
 *
 * Idempotent: detects the existing CLOSE-GAP-16 marker before writing;
 * no-ops cleanly on re-run.
 *
 * Run: node scripts/close-gap-16-wire-sentinel-gate.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const TARGET    = path.join(REPO_ROOT, 'api', 'services', 'pipeline.js');

const OLD_REQUIRE = `'use strict';

const db = require('./db');`;

const NEW_REQUIRE = `'use strict';

const db         = require('./db');
const governance = require('./governance');`;

const OLD_ADVANCE_BODY = `  // 2. Gate requirements check
  let gateErrors;
  try {
    gateErrors = systemCheck ? systemCheck.errors : await validateGate(to_stage, asset_id, client_id);
  } catch (err) {
    return { success: false, code: 422, error: err.message, block_reason: 'blocked_error' };
  }
  if (gateErrors.length > 0) {
    return { success: false, code: 422, error: 'Gate requirements not met', block_reason: 'blocked_pending', gate_errors: gateErrors };
  }

  // 3. Get current stages
  const asset = await db.assets.query(
    \`SELECT pipeline_stage FROM pcm_assets WHERE asset_id = $1\`, [asset_id]
  );
  const client = await db.clients.query(
    \`SELECT pipeline_stage FROM pcm_clients WHERE client_id = $1 AND deleted_at IS NULL\`, [client_id]
  );

  if (!asset.rows.length) return { success: false, code: 404, error: 'Asset not found' };
  if (!client.rows.length) return { success: false, code: 404, error: 'Client not found' };

  const from_stage = asset.rows[0].pipeline_stage;

  // 4. Advance both asset and client`;

const NEW_ADVANCE_BODY = `  // 2. Gate requirements check
  let gateErrors;
  try {
    gateErrors = systemCheck ? systemCheck.errors : await validateGate(to_stage, asset_id, client_id);
  } catch (err) {
    return { success: false, code: 422, error: err.message, block_reason: 'blocked_error' };
  }
  if (gateErrors.length > 0) {
    return { success: false, code: 422, error: 'Gate requirements not met', block_reason: 'blocked_pending', gate_errors: gateErrors };
  }

  // 3. Get current stages (moved ahead of the Sentinel check below so
  //    pipeline_reference is available in its context)
  const asset = await db.assets.query(
    \`SELECT pipeline_stage, pipeline_reference FROM pcm_assets WHERE asset_id = $1\`, [asset_id]
  );
  const client = await db.clients.query(
    \`SELECT pipeline_stage FROM pcm_clients WHERE client_id = $1 AND deleted_at IS NULL\`, [client_id]
  );

  if (!asset.rows.length) return { success: false, code: 404, error: 'Asset not found' };
  if (!client.rows.length) return { success: false, code: 404, error: 'Client not found' };

  const from_stage = asset.rows[0].pipeline_stage;

  // CLOSE-GAP-16: Sentinel enforcement gate, fail-closed. Runs after the
  // local checks above (role authority, gate requirements) and before any
  // state mutation below. BLOCK_SENTINEL_UNAVAILABLE / BLOCK_SENTINEL_ERROR
  // / BLOCK_SENTINEL_TIMEOUT (the policy engine could not be reached or
  // did not answer -- see CLOSE-GAP-14/15) map to block_reason
  // 'blocked_unavailable', distinguishable from a real Sentinel BLOCK
  // decision (block_reason 'blocked_pending', same bucket as unmet gate
  // requirements: the system answered, the answer was no).
  const sentinelResult = await governance.sentinelCheck(
    \`PIPELINE_ADVANCE.\${to_stage.toUpperCase()}\`,
    \`pcm:asset:\${asset_id}\`,
    {
      client_id,
      pipeline_reference: asset.rows[0].pipeline_reference,
      from_stage, to_stage,
      transitioned_by: user.sub || 'system'
    }
  );
  if (!sentinelResult.allowed) {
    const dependencyDown = sentinelResult.decision === 'BLOCK_SENTINEL_UNAVAILABLE'
                         || sentinelResult.decision === 'BLOCK_SENTINEL_ERROR'
                         || sentinelResult.decision === 'BLOCK_SENTINEL_TIMEOUT';
    return {
      success: false,
      code: dependencyDown ? 503 : 403,
      error: sentinelResult.reason || 'Blocked by Sentinel policy',
      block_reason: dependencyDown ? 'blocked_unavailable' : 'blocked_pending',
      sentinel_decision: sentinelResult.decision
    };
  }

  // 4. Advance both asset and client`;

function main() {
  if (!fs.existsSync(TARGET)) {
    console.error(`✗ Target file not found: ${TARGET}`);
    process.exit(1);
  }

  let contents = fs.readFileSync(TARGET, 'utf8');

  if (contents.includes('CLOSE-GAP-16')) {
    console.log('✓ CLOSE-GAP-16 already applied — no-op.');
    return;
  }

  if (!contents.includes(OLD_REQUIRE)) {
    console.error('✗ Expected require block not found — file may have changed since this script was written.');
    console.error('  Refusing to apply blind edit. Manual review required.');
    process.exit(1);
  }
  if (!contents.includes(OLD_ADVANCE_BODY)) {
    console.error('✗ Expected advancePipeline() body not found — file may have changed since this script was written.');
    console.error('  Refusing to apply blind edit. Manual review required.');
    process.exit(1);
  }

  contents = contents.replace(OLD_REQUIRE, NEW_REQUIRE);
  contents = contents.replace(OLD_ADVANCE_BODY, NEW_ADVANCE_BODY);

  fs.writeFileSync(TARGET, contents, 'utf8');
  console.log('✓ CLOSE-GAP-16 applied: advancePipeline() now calls sentinelCheck()');
  console.log('  fail-closed, after local gate checks and before any DB mutation.');
  console.log('  New block_reason: blocked_unavailable (dependency down/timed out),');
  console.log('  distinct from blocked_error and blocked_pending.');

  console.log('\nRunning npm run build...');
  execSync('npm run build', { cwd: REPO_ROOT, stdio: 'inherit' });
}

main();
