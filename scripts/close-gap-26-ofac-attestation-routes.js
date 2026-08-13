#!/usr/bin/env node
/**
 * CLOSE-GAP-26 (Phase 3.4, part 2): structured attestation content +
 * new out-of-band attestation route pair.
 *
 * Two changes to api/routes/clients.js:
 *
 * 1. Retrofit the existing MANUAL_OVERRIDE initiate route (CLOSE-GAP-19a).
 *    It previously required only a free-text `reason`. "Two people
 *    clicked confirm" is not an audit trail -- the record must capture
 *    WHAT was attested to: which provider/method performed the out-of-
 *    band screen, when, and a reference number if one exists. Now
 *    requires screening_provider + screening_date in addition to reason.
 *    The countersign step is unchanged in shape (it confirms the
 *    already-recorded claim, not a second independent screen) but the
 *    structured data from initiate is preserved through to the final
 *    record either way.
 *
 * 2. New route pair, structurally identical to the override flow but a
 *    distinct provider/status/outcome vocabulary: POST .../ofac/attest-
 *    out-of-band (initiate) and PATCH .../ofac/attest-out-of-band/
 *    :result_id/confirm (second principal). This is for clients the
 *    heuristic did NOT flag (status: not_authoritatively_screened) where
 *    staff performed a real screen out-of-band. Deliberately not reusing
 *    MANUAL_OVERRIDE's status/outcome values: an "override" implies a
 *    control ran and a human is superseding its result. Here no
 *    automated control ran at all -- collapsing the two into one status
 *    would make every sanctions screening event read as an override in
 *    the audit trail, which is a false record for the common case where
 *    nothing was ever overridden.
 *
 * No database access -- source file edits only. Idempotent.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const TARGET    = path.join(REPO_ROOT, 'api', 'routes', 'clients.js');

const MARKER = 'CLOSE-GAP-26';

const OLD_INITIATE = `router.post('/:id/ofac/override', authorize('trade_group_owner'), async (req, res, next) => {
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
});`;

const NEW_INITIATE = `router.post('/:id/ofac/override', authorize('trade_group_owner'), async (req, res, next) => {
  try {
    // CLOSE-GAP-26: structured fields, not just free-text reason. "Two
    // people clicked confirm" is not an audit trail for a sanctions
    // control -- the record must show what was actually screened.
    const { reason, screening_provider, screening_date, reference_number } = req.body;
    if (!reason || !reason.trim()) {
      return res.status(400).json({ error: 'reason is required — document the out-of-band screen this override is based on' });
    }
    if (!screening_provider || !screening_provider.trim()) {
      return res.status(400).json({ error: 'screening_provider is required — which service or method performed the out-of-band screen' });
    }
    if (!screening_date || !screening_date.trim()) {
      return res.status(400).json({ error: 'screening_date is required — when the out-of-band screen was actually performed' });
    }

    const client = await db.clients.query(
      \`SELECT client_id FROM pcm_clients WHERE client_id = $1 AND deleted_at IS NULL\`,
      [req.params.id]
    );
    if (!client.rows.length) return res.status(404).json({ error: 'Client not found' });

    const initiatedBy = req.user.sub || req.user.email;
    const summary = \`Screened via \${screening_provider} on \${screening_date}\${reference_number ? \` (ref: \${reference_number})\` : ''}. \${reason}\`;

    const result = await db.clients.query(
      \`INSERT INTO pcm_ofac_results
        (client_id, provider, status, raw_response_summary, reviewed_by, reviewed_at, review_outcome)
       VALUES ($1, 'MANUAL_OVERRIDE', 'manual_review', $2, $3, NOW(), 'PENDING_COUNTERSIGN')
       RETURNING *\`,
      [req.params.id, summary, initiatedBy]
    );

    res.status(201).json({
      result_id:  result.rows[0].result_id,
      status:     'PENDING_COUNTERSIGN',
      message:    'Override initiated. A different trade_group_owner must countersign before this affects the KYC gate.',
      initiated_by: initiatedBy
    });
  } catch (err) { next(err); }
});

// ─── INITIATE OFAC OUT-OF-BAND ATTESTATION (CLOSE-GAP-26, step 1 of 2) ───────
// For clients the heuristic did NOT flag (ofac_status =
// 'not_authoritatively_screened') where staff performed a real screen
// out-of-band. Distinct from /override: no automated control ran here to
// be overridden, so this uses its own provider/status/outcome vocabulary
// rather than reusing MANUAL_OVERRIDE's, which would misrepresent the
// audit trail as "every screen was an override."
router.post('/:id/ofac/attest-out-of-band', authorize('trade_group_owner'), async (req, res, next) => {
  try {
    const { reason, screening_provider, screening_date, reference_number } = req.body;
    if (!reason || !reason.trim()) {
      return res.status(400).json({ error: 'reason is required — document the out-of-band screen this attestation is based on' });
    }
    if (!screening_provider || !screening_provider.trim()) {
      return res.status(400).json({ error: 'screening_provider is required — which service or method performed the out-of-band screen' });
    }
    if (!screening_date || !screening_date.trim()) {
      return res.status(400).json({ error: 'screening_date is required — when the out-of-band screen was actually performed' });
    }

    const client = await db.clients.query(
      \`SELECT client_id FROM pcm_clients WHERE client_id = $1 AND deleted_at IS NULL\`,
      [req.params.id]
    );
    if (!client.rows.length) return res.status(404).json({ error: 'Client not found' });

    const initiatedBy = req.user.sub || req.user.email;
    const summary = \`Screened via \${screening_provider} on \${screening_date}\${reference_number ? \` (ref: \${reference_number})\` : ''}. \${reason}\`;

    const result = await db.clients.query(
      \`INSERT INTO pcm_ofac_results
        (client_id, provider, status, raw_response_summary, reviewed_by, reviewed_at, review_outcome)
       VALUES ($1, 'OUT_OF_BAND_ATTESTATION', 'attested_out_of_band', $2, $3, NOW(), 'PENDING_ATTESTATION')
       RETURNING *\`,
      [req.params.id, summary, initiatedBy]
    );

    res.status(201).json({
      result_id:  result.rows[0].result_id,
      status:     'PENDING_ATTESTATION',
      message:    'Attestation initiated. A different trade_group_owner must confirm before this affects the KYC gate.',
      initiated_by: initiatedBy
    });
  } catch (err) { next(err); }
});

// ─── CONFIRM OFAC OUT-OF-BAND ATTESTATION (CLOSE-GAP-26, step 2 of 2) ────────
// Only after this succeeds does pcm_clients.ofac_status become
// 'attested_out_of_band'.
router.patch('/:id/ofac/attest-out-of-band/:result_id/confirm', authorize('trade_group_owner'), async (req, res, next) => {
  try {
    const { reason } = req.body;
    if (!reason || !reason.trim()) {
      return res.status(400).json({ error: 'reason is required — document your own independent basis for confirming this attestation' });
    }

    const confirmedBy = req.user.sub || req.user.email;

    const existing = await db.clients.query(
      \`SELECT * FROM pcm_ofac_results
       WHERE result_id = $1 AND client_id = $2 AND provider = 'OUT_OF_BAND_ATTESTATION'\`,
      [req.params.result_id, req.params.id]
    );
    if (!existing.rows.length) return res.status(404).json({ error: 'Attestation not found' });

    const attestation = existing.rows[0];
    if (attestation.review_outcome !== 'PENDING_ATTESTATION') {
      return res.status(409).json({ error: \`Attestation is not pending confirmation (current state: \${attestation.review_outcome})\` });
    }
    if (attestation.reviewed_by === confirmedBy) {
      return res.status(403).json({ error: 'Cannot confirm your own attestation — dual control requires a different principal' });
    }

    const confirmNote = \`\${attestation.raw_response_summary} | Confirmed by \${confirmedBy} at \${new Date().toISOString()}: \${reason}\`;

    const updated = await db.clients.query(
      \`UPDATE pcm_ofac_results
       SET review_outcome = 'ATTESTATION_CONFIRMED', raw_response_summary = $1
       WHERE result_id = $2
       RETURNING *\`,
      [confirmNote, req.params.result_id]
    );

    await db.clients.query(
      \`UPDATE pcm_clients
       SET ofac_status = 'attested_out_of_band', ofac_screened_at = NOW(),
           ofac_provider = 'OUT_OF_BAND_ATTESTATION', ofac_reference_id = $1
       WHERE client_id = $2\`,
      [req.params.result_id, req.params.id]
    );

    const governance = require('../services/governance');
    await governance.salLog({
      agent_id: confirmedBy,
      action:   'OFAC_OUT_OF_BAND_ATTESTATION_CONFIRMED',
      resource: \`pcm:client:\${req.params.id}\`,
      decision: 'ALLOW',
      context:  { initiated_by: attestation.reviewed_by, confirmed_by: confirmedBy, result_id: req.params.result_id }
    }).catch(() => {});

    res.json(updated.rows[0]);
  } catch (err) { next(err); }
});
// CLOSE-GAP-26`;

function main() {
  let contents = fs.readFileSync(TARGET, 'utf8');
  if (contents.includes(MARKER)) {
    console.log('✓ CLOSE-GAP-26 already applied — no-op.');
    return;
  }
  if (!contents.includes(OLD_INITIATE)) {
    console.error('✗ Expected override-initiate route block not found — file may have changed.');
    process.exit(1);
  }
  contents = contents.replace(OLD_INITIATE, NEW_INITIATE);
  fs.writeFileSync(TARGET, contents, 'utf8');
  console.log('✓ Retrofitted /override with structured screening fields; added /attest-out-of-band route pair.');

  console.log('\nRunning npm run build...');
  execSync('npm run build', { cwd: REPO_ROOT, stdio: 'inherit' });
}

main();
