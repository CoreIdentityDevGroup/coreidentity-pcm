#!/usr/bin/env node
/**
 * CLOSE-GAP-17: Remove the unguarded POST /api/v1/clients/:id/advance path
 *
 * Finding: this route updated pcm_clients.pipeline_stage directly, with no
 * role-hierarchy check (only the generic 'any of these three roles' gate
 * via authorize(), same three roles regardless of target stage), no
 * GATE_REQUIREMENTS check, and no sentinelCheck() call. Structurally the
 * same defect CLOSE-GAP-11 fixed on the assets side
 * (api/routes/assets.js POST /:id/advance), left unfixed on the clients
 * side.
 *
 * Determined from code, not guessed, that this cannot simply be routed
 * through advancePipeline() the way one might first assume: the guarded
 * endpoint (POST /api/v1/pipeline/advance, api/routes/pipeline.js:63)
 * requires asset_id, client_id, AND to_stage -- advancePipeline() treats
 * asset and client pipeline_stage as a single value advanced together in
 * lockstep (api/services/pipeline.js, step 4: both UPDATEs in one
 * Promise.all). POST /clients/:id/advance never accepts an asset_id at
 * all. There is no standalone concept of "advance just the client" in the
 * guarded model -- confirmed by grepping the whole repo for every write
 * to pcm_clients.pipeline_stage: the only two are this route and
 * advancePipeline()'s lockstep UPDATE. No external caller of this route
 * exists anywhere on this box (checked coreidentity-pcm itself, the
 * infrastructure repo, coreidentity-tools scripts -- zero references).
 *
 * Fix: same as CLOSE-GAP-11 -- the route is not deleted (a 404 here would
 * be indistinguishable from a typo in the URL; a 410 states plainly that
 * this used to work and won't again), pointing callers at the real,
 * guarded endpoint.
 *
 * No database access of any kind -- this script only edits source files
 * and runs `npm run build`.
 *
 * Idempotent: detects the existing 410 handler before writing; no-ops
 * cleanly on re-run.
 *
 * Run: node scripts/close-gap-17-remove-unguarded-client-advance.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const TARGET    = path.join(REPO_ROOT, 'api', 'routes', 'clients.js');

const OLD_BLOCK = `router.post('/:id/advance', authorize('trade_group_owner','program_manager','intake_officer'), async (req, res, next) => {
  try {
    const { to_stage, reason, notes } = req.body;
    if (!to_stage) return res.status(400).json({ error: 'to_stage is required' });

    const client = await db.clients.query(
      \`SELECT * FROM pcm_clients WHERE client_id = $1 AND deleted_at IS NULL\`,
      [req.params.id]
    );
    if (!client.rows.length) return res.status(404).json({ error: 'Client not found' });

    const from_stage = client.rows[0].pipeline_stage;

    const result = await db.clients.query(
      \`UPDATE pcm_clients SET pipeline_stage = $1
       WHERE client_id = $2 RETURNING *\`,
      [to_stage, req.params.id]
    );

    await db.clients.query(
      \`INSERT INTO pcm_client_pipeline_audit
        (client_id, from_stage, to_stage, transitioned_by, transition_role, reason, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7)\`,
      [req.params.id, from_stage, to_stage,
       req.user.sub || 'system', req.user.role, reason, notes]
    );

    res.json({ client: result.rows[0], transition: { from: from_stage, to: to_stage } });
  } catch (err) { next(err); }
});`;

const NEW_BLOCK = `// ─── ADVANCE CLIENT PIPELINE STAGE — REMOVED (CLOSE-GAP-17) ──────────────────
// This route used to update pcm_clients.pipeline_stage directly, with no
// role-hierarchy check, no GATE_REQUIREMENTS check, and no sentinelCheck()
// call -- the same defect CLOSE-GAP-11 fixed on the assets side. Not
// routed through advancePipeline(): that function requires asset_id,
// which this route never accepted, and there is no standalone concept of
// advancing a client's stage independent of an asset in the guarded
// model. Route kept (not deleted) so a caller gets 410 Gone instead of a
// 404 that could pass for a typo.
router.post('/:id/advance', authorize('trade_group_owner','program_manager','intake_officer'), (req, res) => {
  res.status(410).json({
    error:       'Gone',
    message:     'This endpoint no longer advances pipeline stage. It performed no role-hierarchy, gate, or Sentinel checks, and never accepted the asset_id the guarded path requires. Use POST /api/v1/pipeline/advance instead.',
    use_instead: '/api/v1/pipeline/advance'
  });
});`;

function main() {
  if (!fs.existsSync(TARGET)) {
    console.error(`✗ Target file not found: ${TARGET}`);
    process.exit(1);
  }

  const contents = fs.readFileSync(TARGET, 'utf8');

  if (contents.includes('CLOSE-GAP-17')) {
    console.log('✓ CLOSE-GAP-17 already applied — no-op.');
    return;
  }

  if (!contents.includes(OLD_BLOCK)) {
    console.error('✗ Expected /:id/advance handler not found — file may have changed since this script was written.');
    console.error('  Refusing to apply blind edit. Manual review required.');
    process.exit(1);
  }

  fs.writeFileSync(TARGET, contents.replace(OLD_BLOCK, NEW_BLOCK), 'utf8');
  console.log('✓ CLOSE-GAP-17 applied: POST /api/v1/clients/:id/advance now returns 410, points to /api/v1/pipeline/advance.');

  console.log('\nRunning npm run build...');
  execSync('npm run build', { cwd: REPO_ROOT, stdio: 'inherit' });
}

main();
