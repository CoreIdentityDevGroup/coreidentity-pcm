#!/usr/bin/env node
/**
 * CLOSE-GAP-22 (Phase 3.2): contract-monitoring writes to a table that
 * does not exist
 *
 * agents/contract-monitoring/index.js INSERTs into pcm_monitoring_log,
 * which has never existed in the live schema (confirmed originally in
 * this session's manual sweep, re-confirmed independently by the Phase 2
 * validator's live schema check). The real table, pcm_contract_
 * monitoring_log, has a materially different column set (checked live
 * before writing this):
 *
 *   log_id, agreement_id, asset_id, client_id, pipeline_reference,
 *   event_type, severity, message, agent_id, resolved, resolved_at,
 *   resolved_by, resolution_note, created_at
 *
 * Three real gaps beyond the table name, each would have caused its own
 * failure even with the name fixed:
 *
 * 1. asset_id and client_id are NOT NULL on the real table. The current
 *    query never selects them from pcm_agreements (which has both --
 *    checked live). Added to the SELECT.
 * 2. event_type has a CHECK constraint (missing_signature,
 *    missing_required_document, approaching_expiry, expired,
 *    pipeline_gate_blocked, execution_confirmed, renewal_required,
 *    status_change) that does not include 'expiry_warning', the literal
 *    the code writes. Mapped to 'expired' / 'approaching_expiry' using
 *    the exact same days_until <= 0 condition the code already computes
 *    for severity -- not a new judgment call, reusing the existing one.
 * 3. agent_id is NOT NULL text, never set by the current code. Set to
 *    'contract-monitoring-agent', matching the naming convention every
 *    other agent in this repo already uses for this field (e.g.
 *    deletion-certification-agent, ofac-screening-agent).
 *
 * severity values (info/warning/critical) already match the live
 * pcm_monitoring_severity enum exactly -- unchanged.
 *
 * No database access of any kind -- this script only edits source files
 * and runs `npm run build`.
 *
 * Idempotent: detects the existing CLOSE-GAP-22 marker before writing;
 * no-ops cleanly on re-run.
 *
 * Run: node scripts/close-gap-22-contract-monitoring-schema.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const TARGET    = path.join(REPO_ROOT, 'agents', 'contract-monitoring', 'index.js');

const OLD_QUERY = `  // Find expiring agreements
  const expiring = await db.forms.query(
    \`SELECT a.agreement_id, a.agreement_type, a.expiry_date, 
            a.pipeline_reference, a.status
     FROM pcm_agreements a
     WHERE a.expiry_date IS NOT NULL
       AND a.expiry_date <= $1
       AND a.status NOT IN ('expired')
     ORDER BY a.expiry_date ASC\`,
    [in_90]
  );`;

const NEW_QUERY = `  // Find expiring agreements
  const expiring = await db.forms.query(
    \`SELECT a.agreement_id, a.agreement_type, a.expiry_date,
            a.pipeline_reference, a.status, a.asset_id, a.client_id
     FROM pcm_agreements a
     WHERE a.expiry_date IS NOT NULL
       AND a.expiry_date <= $1
       AND a.status NOT IN ('expired')
     ORDER BY a.expiry_date ASC\`,
    [in_90]
  );`;

const OLD_INSERT = `    // Log alert
    await db.forms.query(
      \`INSERT INTO pcm_monitoring_log
         (agreement_id, alert_type, severity, message, pipeline_reference)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING\`,
      [
        agreement.agreement_id,
        'expiry_warning',
        severity,
        alerts[alerts.length - 1].message,
        agreement.pipeline_reference
      ]
    );`;

const NEW_INSERT = `    // Log alert. CLOSE-GAP-22: corrected table name (see script header),
    // correct required columns (asset_id/client_id are NOT NULL live),
    // and event_type mapped to the live CHECK constraint's allowed values
    // using the same days_until <= 0 condition already computed above
    // for severity.
    await db.forms.query(
      \`INSERT INTO pcm_contract_monitoring_log
         (agreement_id, asset_id, client_id, pipeline_reference, event_type, severity, message, agent_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)\`,
      [
        agreement.agreement_id,
        agreement.asset_id,
        agreement.client_id,
        agreement.pipeline_reference,
        days_until <= 0 ? 'expired' : 'approaching_expiry',
        severity,
        alerts[alerts.length - 1].message,
        'contract-monitoring-agent'
      ]
    );`;

function main() {
  if (!fs.existsSync(TARGET)) {
    console.error(`✗ Target file not found: ${TARGET}`);
    process.exit(1);
  }

  let contents = fs.readFileSync(TARGET, 'utf8');

  if (contents.includes('CLOSE-GAP-22')) {
    console.log('✓ CLOSE-GAP-22 already applied — no-op.');
    return;
  }

  if (!contents.includes(OLD_QUERY)) {
    console.error('✗ Expected SELECT query not found — file may have changed since this script was written.');
    console.error('  Refusing to apply blind edit. Manual review required.');
    process.exit(1);
  }
  if (!contents.includes(OLD_INSERT)) {
    console.error('✗ Expected INSERT statement not found — file may have changed since this script was written.');
    console.error('  Refusing to apply blind edit. Manual review required.');
    process.exit(1);
  }

  contents = contents.replace(OLD_QUERY, NEW_QUERY);
  contents = contents.replace(OLD_INSERT, NEW_INSERT);

  fs.writeFileSync(TARGET, contents, 'utf8');
  console.log('✓ CLOSE-GAP-22 applied: contract-monitoring now writes to the correct');
  console.log('  live table with all NOT NULL columns populated and a valid event_type.');

  console.log('\nRunning npm run build...');
  execSync('npm run build', { cwd: REPO_ROOT, stdio: 'inherit' });
}

main();
