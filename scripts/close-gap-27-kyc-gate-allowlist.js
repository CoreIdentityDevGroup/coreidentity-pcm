#!/usr/bin/env node
/**
 * CLOSE-GAP-27 (Phase 3.4, part 3): kyc_verification's OFAC check,
 * blocklist -> allowlist.
 *
 * Before: enumerated bad statuses (pending, flagged) and pushed errors for
 * those; manual_review got its own dual-control re-verification; anything
 * else -- including 'clear', and any future/unexpected status -- passed
 * by omission. That is a blocklist: new statuses are trusted by default.
 *
 * After: only two specific, independently-verified states pass --
 * manual_review with a confirmed MANUAL_OVERRIDE, or
 * attested_out_of_band with a confirmed OUT_OF_BAND_ATTESTATION. Every
 * other value, including the legacy 'clear' status still sitting on one
 * pre-existing row (still at pipeline_stage 'intake', has not reached this
 * gate -- verified live, no backfill needed) blocks by default. This is
 * an allowlist: unknown/unexpected statuses are untrusted by default,
 * matching the pattern bank_assignment/tokenization/completed already use
 * elsewhere in this same file.
 *
 * No database access -- source file edits only. Idempotent.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const TARGET    = path.join(REPO_ROOT, 'api', 'services', 'pipeline.js');

const MARKER = 'CLOSE-GAP-27';

const OLD_BLOCK = `    const errors = [];
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

const NEW_BLOCK = `    const errors = [];
    if (parseInt(kyc.rows[0].count) === 0) errors.push('No KYC documents on file');
    if (parseInt(pof.rows[0].count) === 0) errors.push('No Proof of Funds on file');

    // CLOSE-GAP-27: allowlist, not blocklist. Only two independently-
    // verified states satisfy OFAC screening -- everything else
    // (pending, flagged, not_authoritatively_screened, the legacy 'clear'
    // value, or either status below without its matching confirmed
    // record) blocks by default. Enumerating only the bad values here
    // previously let 'clear' -- an unauthoritative heuristic result --
    // pass with zero human involvement. See CLOSE-GAP-25/26 and
    // db/migrations/0001-ofac-status-not-authoritative.sql.
    const ofacStatus = ofac.rows[0]?.ofac_status;
    let ofacSatisfied = false;

    if (ofacStatus === 'manual_review') {
      // Genuinely flagged by the heuristic, dual-control override.
      const override = await db.clients.query(
        \`SELECT review_outcome FROM pcm_ofac_results
         WHERE client_id = $1 AND provider = 'MANUAL_OVERRIDE'
         ORDER BY screened_at DESC LIMIT 1\`, [client_id]
      );
      ofacSatisfied = override.rows[0]?.review_outcome === 'MANUAL_OVERRIDE_CONFIRMED';
    } else if (ofacStatus === 'attested_out_of_band') {
      // Heuristic found no match, but that's not authoritative -- a real
      // out-of-band screen was performed and dual-control attested.
      const attestation = await db.clients.query(
        \`SELECT review_outcome FROM pcm_ofac_results
         WHERE client_id = $1 AND provider = 'OUT_OF_BAND_ATTESTATION'
         ORDER BY screened_at DESC LIMIT 1\`, [client_id]
      );
      ofacSatisfied = attestation.rows[0]?.review_outcome === 'ATTESTATION_CONFIRMED';
    }

    if (!ofacSatisfied) {
      errors.push(\`OFAC screening not satisfied (status: \${ofacStatus || 'none'}) — requires either a confirmed dual-control override (heuristic flagged a match) or a confirmed out-of-band attestation (heuristic found no match, which is not itself authoritative)\`);
    }
    return errors;
  },`;

function main() {
  let contents = fs.readFileSync(TARGET, 'utf8');
  if (contents.includes(MARKER)) {
    console.log('✓ CLOSE-GAP-27 already applied — no-op.');
    return;
  }
  if (!contents.includes(OLD_BLOCK)) {
    console.error('✗ Expected kyc_verification gate block not found — file may have changed.');
    process.exit(1);
  }
  contents = contents.replace(OLD_BLOCK, NEW_BLOCK);
  fs.writeFileSync(TARGET, contents, 'utf8');
  console.log('✓ kyc_verification OFAC check rewritten as an allowlist.');

  console.log('\nRunning npm run build...');
  execSync('npm run build', { cwd: REPO_ROOT, stdio: 'inherit' });
}

main();
