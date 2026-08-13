#!/usr/bin/env node
/**
 * CLOSE-GAP-19a: POST /clients/:id/ofac let any caller assert
 * pcm_clients.ofac_status (a KYC-gate-bound column) from an unverified
 * request body
 *
 * Determined from code, not guessed, whether a legitimate manual-override
 * case exists: the automated ofac-screening agent never calls this HTTP
 * route at all (agents/ofac-screening/index.js writes pcm_clients directly
 * via the db handle passed into agent.execute(), invoked in-process by
 * agent-orchestrator.js -- confirmed by grep, zero HTTP calls anywhere in
 * that file). So this route was never how the real screen gets recorded.
 * But its accepted body shape (provider, provider_reference_id,
 * raw_response_summary) matches recording a screen run through an
 * out-of-band/external provider the automated integration doesn't cover --
 * a real, common compliance need, not obviously fabricated. Conclusion:
 * a legitimate override case plausibly exists, so per instruction it
 * becomes an explicit, dual-control override rather than being deleted
 * outright.
 *
 * No schema migration needed. pcm_ofac_status already has an unused
 * 'manual_review' value (enum_range: pending, clear, flagged,
 * manual_review -- confirmed live, checked before writing this), and
 * pcm_ofac_results already has reviewed_by / reviewed_at / review_outcome
 * columns that no current code path populates. This design uses only
 * that existing, already-live schema.
 *
 * New flow, two separate HTTP requests, enforced server-side (a single
 * request naming two principals is not dual control -- it's a label
 * either principal could write themselves):
 *
 *   1. POST /clients/:id/ofac/override  (trade_group_owner, reason required)
 *      Writes a pcm_ofac_results row: provider='MANUAL_OVERRIDE',
 *      status='manual_review', reviewed_by=<initiator>, reviewed_at=now,
 *      review_outcome='PENDING_COUNTERSIGN'. Does NOT touch
 *      pcm_clients.ofac_status yet -- the gate is not satisfied until
 *      countersigned.
 *
 *   2. PATCH /clients/:id/ofac/override/:result_id/countersign
 *      (trade_group_owner, reason required, caller must differ from the
 *      initiator -- checked server-side against reviewed_by, not trusted
 *      from the request body). On success: review_outcome=
 *      'MANUAL_OVERRIDE_CONFIRMED', countersigner + reason appended to
 *      raw_response_summary (no dedicated countersigner column exists;
 *      appending to the existing free-text field keeps this schema-free),
 *      and only now sets pcm_clients.ofac_status='manual_review'.
 *
 * The old POST /clients/:id/ofac (free-form status assertion) returns 410,
 * pointing at the override flow -- same pattern as CLOSE-GAP-11/17.
 *
 * KYC gate (api/services/pipeline.js): 'manual_review' is never treated as
 * equivalent to 'clear'. It re-verifies against pcm_ofac_results directly
 * that the override was actually confirmed by a second principal -- not
 * just trusted from the status flag -- before passing. If ofac_status is
 * 'manual_review' but no MANUAL_OVERRIDE_CONFIRMED row exists, the gate
 * blocks with a distinct message naming the reason.
 *
 * No database access of any kind -- this script only edits source files
 * and runs `npm run build`.
 *
 * Idempotent: detects the existing CLOSE-GAP-19a marker before writing;
 * no-ops cleanly on re-run.
 *
 * Run: node scripts/close-gap-19a-ofac-dual-control-override.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO_ROOT   = path.join(__dirname, '..');
const CLIENTS_FILE = path.join(REPO_ROOT, 'api', 'routes', 'clients.js');
const PIPELINE_FILE = path.join(REPO_ROOT, 'api', 'services', 'pipeline.js');

// ─────────────────────────────────────────────────────────────────────────────
// clients.js
// ─────────────────────────────────────────────────────────────────────────────

const OLD_OFAC_BLOCK = `// ─── RECORD OFAC RESULT ───────────────────────────────────────────────────────
router.post('/:id/ofac', authorize('trade_group_owner','program_manager','intake_officer'), async (req, res, next) => {
  try {
    const { provider, provider_reference_id, status,
            match_count, raw_response_summary, screened_by_agent } = req.body;

    if (!provider || !status) {
      return res.status(400).json({ error: 'provider and status are required' });
    }

    const result = await db.clients.query(
      \`INSERT INTO pcm_ofac_results
        (client_id, provider, provider_reference_id, status,
         match_count, raw_response_summary, screened_by_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *\`,
      [req.params.id, provider, provider_reference_id, status,
       match_count || 0, raw_response_summary, screened_by_agent]
    );

    await db.clients.query(
      \`UPDATE pcm_clients SET ofac_status = $1, ofac_screened_at = NOW(),
       ofac_provider = $2, ofac_reference_id = $3
       WHERE client_id = $4\`,
      [status, provider, provider_reference_id, req.params.id]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) { next(err); }
});`;

const NEW_OFAC_BLOCK = `// ─── RECORD OFAC RESULT — REMOVED (CLOSE-GAP-19a) ─────────────────────────────
// This route let any caller assert pcm_clients.ofac_status -- the exact
// column the kyc_verification gate reads -- from an unverified request
// body, with no evidence it came from a real screen. Route kept (not
// deleted) so a caller gets 410 Gone instead of a 404 that could pass for
// a typo. See POST .../ofac/override for the real, dual-control path.
router.post('/:id/ofac', authorize('trade_group_owner','program_manager','intake_officer'), (req, res) => {
  res.status(410).json({
    error:       'Gone',
    message:     'This endpoint no longer sets OFAC status from an unverified request body. Automated screening is recorded by the ofac-screening agent directly. For a manual/out-of-band screen, use the dual-control override flow.',
    use_instead: '/api/v1/clients/:id/ofac/override'
  });
});

// ─── INITIATE OFAC MANUAL OVERRIDE (CLOSE-GAP-19a, step 1 of 2) ──────────────
// Records that a first principal is asserting an out-of-band screen result.
// Does NOT set pcm_clients.ofac_status -- the KYC gate does not accept this
// until a second, distinct principal confirms via the countersign endpoint
// below. A single request naming two people is not dual control.
router.post('/:id/ofac/override', authorize('trade_group_owner'), async (req, res, next) => {
  try {
    const { reason } = req.body;
    if (!reason || !reason.trim()) {
      return res.status(400).json({ error: 'reason is required — document the out-of-band screen this override is based on' });
    }

    const client = await db.clients.query(
      \`SELECT client_id FROM pcm_clients WHERE client_id = $1 AND deleted_at IS NULL\`,
      [req.params.id]
    );
    if (!client.rows.length) return res.status(404).json({ error: 'Client not found' });

    const initiatedBy = req.user.sub || req.user.email;

    const result = await db.clients.query(
      \`INSERT INTO pcm_ofac_results
        (client_id, provider, status, raw_response_summary, reviewed_by, reviewed_at, review_outcome)
       VALUES ($1, 'MANUAL_OVERRIDE', 'manual_review', $2, $3, NOW(), 'PENDING_COUNTERSIGN')
       RETURNING *\`,
      [req.params.id, reason, initiatedBy]
    );

    res.status(201).json({
      result_id:  result.rows[0].result_id,
      status:     'PENDING_COUNTERSIGN',
      message:    'Override initiated. A different trade_group_owner must countersign before this affects the KYC gate.',
      initiated_by: initiatedBy
    });
  } catch (err) { next(err); }
});

// ─── COUNTERSIGN OFAC MANUAL OVERRIDE (CLOSE-GAP-19a, step 2 of 2) ───────────
// Only after this succeeds does pcm_clients.ofac_status become
// 'manual_review' -- never 'clear'. Distinguishable from a real screen in
// every downstream query, permanently.
router.patch('/:id/ofac/override/:result_id/countersign', authorize('trade_group_owner'), async (req, res, next) => {
  try {
    const { reason } = req.body;
    if (!reason || !reason.trim()) {
      return res.status(400).json({ error: 'reason is required — document your own independent basis for confirming this override' });
    }

    const countersignedBy = req.user.sub || req.user.email;

    const existing = await db.clients.query(
      \`SELECT * FROM pcm_ofac_results
       WHERE result_id = $1 AND client_id = $2 AND provider = 'MANUAL_OVERRIDE'\`,
      [req.params.result_id, req.params.id]
    );
    if (!existing.rows.length) return res.status(404).json({ error: 'Override not found' });

    const override = existing.rows[0];
    if (override.review_outcome !== 'PENDING_COUNTERSIGN') {
      return res.status(409).json({ error: \`Override is not pending countersign (current state: \${override.review_outcome})\` });
    }
    if (override.reviewed_by === countersignedBy) {
      return res.status(403).json({ error: 'Cannot countersign your own override — dual control requires a different principal' });
    }

    const countersignNote = \`\${override.raw_response_summary} | Countersigned by \${countersignedBy} at \${new Date().toISOString()}: \${reason}\`;

    const updated = await db.clients.query(
      \`UPDATE pcm_ofac_results
       SET review_outcome = 'MANUAL_OVERRIDE_CONFIRMED', raw_response_summary = $1
       WHERE result_id = $2
       RETURNING *\`,
      [countersignNote, req.params.result_id]
    );

    await db.clients.query(
      \`UPDATE pcm_clients
       SET ofac_status = 'manual_review', ofac_screened_at = NOW(),
           ofac_provider = 'MANUAL_OVERRIDE', ofac_reference_id = $1
       WHERE client_id = $2\`,
      [req.params.result_id, req.params.id]
    );

    const governance = require('../services/governance');
    await governance.salLog({
      agent_id: countersignedBy,
      action:   'OFAC_MANUAL_OVERRIDE_CONFIRMED',
      resource: \`pcm:client:\${req.params.id}\`,
      decision: 'ALLOW',
      context:  { initiated_by: override.reviewed_by, countersigned_by: countersignedBy, result_id: req.params.result_id }
    }).catch(() => {});

    res.json(updated.rows[0]);
  } catch (err) { next(err); }
});`;

// ─────────────────────────────────────────────────────────────────────────────
// pipeline.js — kyc_verification gate
// ─────────────────────────────────────────────────────────────────────────────

const OLD_KYC_GATE = `  kyc_verification: async (asset_id, client_id) => {
    const kyc = await db.clients.query(
      \`SELECT COUNT(*) FROM pcm_kyc_documents
       WHERE client_id = $1 AND vault_status = 'active'\`, [client_id]
    );
    const pof = await db.clients.query(
      \`SELECT COUNT(*) FROM pcm_pof_records
       WHERE client_id = $1 AND vault_status = 'active'\`, [client_id]
    );
    const ofac = await db.clients.query(
      \`SELECT ofac_status FROM pcm_clients WHERE client_id = $1\`, [client_id]
    );
    const errors = [];
    if (parseInt(kyc.rows[0].count) === 0) errors.push('No KYC documents on file');
    if (parseInt(pof.rows[0].count) === 0) errors.push('No Proof of Funds on file');
    if (ofac.rows[0]?.ofac_status === 'pending') errors.push('OFAC screening not completed');
    if (ofac.rows[0]?.ofac_status === 'flagged')  errors.push('OFAC screening flagged — requires manual review');
    return errors;
  },`;

const NEW_KYC_GATE = `  kyc_verification: async (asset_id, client_id) => {
    const kyc = await db.clients.query(
      \`SELECT COUNT(*) FROM pcm_kyc_documents
       WHERE client_id = $1 AND vault_status = 'active'\`, [client_id]
    );
    const pof = await db.clients.query(
      \`SELECT COUNT(*) FROM pcm_pof_records
       WHERE client_id = $1 AND vault_status = 'active'\`, [client_id]
    );
    const ofac = await db.clients.query(
      \`SELECT ofac_status FROM pcm_clients WHERE client_id = $1\`, [client_id]
    );
    const errors = [];
    if (parseInt(kyc.rows[0].count) === 0) errors.push('No KYC documents on file');
    if (parseInt(pof.rows[0].count) === 0) errors.push('No Proof of Funds on file');
    if (ofac.rows[0]?.ofac_status === 'pending') errors.push('OFAC screening not completed');
    if (ofac.rows[0]?.ofac_status === 'flagged')  errors.push('OFAC screening flagged — requires manual review');
    // CLOSE-GAP-19a: 'manual_review' is a dual-control override, never
    // equivalent to a clean automated screen. Re-verify against
    // pcm_ofac_results directly that a second principal actually
    // countersigned -- do not trust the status flag alone.
    if (ofac.rows[0]?.ofac_status === 'manual_review') {
      const override = await db.clients.query(
        \`SELECT review_outcome FROM pcm_ofac_results
         WHERE client_id = $1 AND provider = 'MANUAL_OVERRIDE'
         ORDER BY screened_at DESC LIMIT 1\`, [client_id]
      );
      if (override.rows[0]?.review_outcome !== 'MANUAL_OVERRIDE_CONFIRMED') {
        errors.push('OFAC status is manual_review but the dual-control override was not confirmed by a second principal');
      }
    }
    return errors;
  },`;

function main() {
  for (const f of [CLIENTS_FILE, PIPELINE_FILE]) {
    if (!fs.existsSync(f)) {
      console.error(`✗ Target file not found: ${f}`);
      process.exit(1);
    }
  }

  let clientsSrc  = fs.readFileSync(CLIENTS_FILE, 'utf8');
  let pipelineSrc = fs.readFileSync(PIPELINE_FILE, 'utf8');

  if (clientsSrc.includes('CLOSE-GAP-19a') && pipelineSrc.includes('CLOSE-GAP-19a')) {
    console.log('✓ CLOSE-GAP-19a already applied — no-op.');
    return;
  }

  if (!clientsSrc.includes(OLD_OFAC_BLOCK)) {
    console.error('✗ Expected POST /:id/ofac handler not found in clients.js — file may have changed.');
    console.error('  Refusing to apply blind edit. Manual review required.');
    process.exit(1);
  }
  if (!pipelineSrc.includes(OLD_KYC_GATE)) {
    console.error('✗ Expected kyc_verification gate not found in pipeline.js — file may have changed.');
    console.error('  Refusing to apply blind edit. Manual review required.');
    process.exit(1);
  }

  clientsSrc  = clientsSrc.replace(OLD_OFAC_BLOCK, NEW_OFAC_BLOCK);
  pipelineSrc = pipelineSrc.replace(OLD_KYC_GATE, NEW_KYC_GATE);

  fs.writeFileSync(CLIENTS_FILE, clientsSrc, 'utf8');
  fs.writeFileSync(PIPELINE_FILE, pipelineSrc, 'utf8');

  console.log('✓ CLOSE-GAP-19a applied:');
  console.log('  - POST /clients/:id/ofac now returns 410');
  console.log('  - POST /clients/:id/ofac/override + PATCH .../countersign added (dual control)');
  console.log('  - kyc_verification gate re-verifies dual-control confirmation for manual_review');

  console.log('\nRunning npm run build...');
  execSync('npm run build', { cwd: REPO_ROOT, stdio: 'inherit' });
}

main();
