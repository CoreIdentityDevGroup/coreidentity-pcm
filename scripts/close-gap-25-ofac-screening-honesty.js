#!/usr/bin/env node
/**
 * CLOSE-GAP-25 (Phase 3.4, part 1): ofac-screening self-declares as a
 * heuristic pre-screen, not an authoritative sanctions check.
 *
 * agents/ofac-screening/index.js is 10 hardcoded country strings and 4
 * regex name patterns. It has never called any external API. Its own
 * manifest and README both claimed "via third-party API" -- false, and
 * the same class of defect as deletion-certification's manifest (CLOSE-
 * GAP-24). Corrected both.
 *
 * The agent previously set status = 'clear' when it found no match, which
 * downstream code (the kyc_verification gate) read as "screened clean".
 * It changes to 'not_authoritatively_screened' (see
 * db/migrations/0001-ofac-status-not-authoritative.sql for the enum
 * migration this depends on -- already applied live). 'flagged' is
 * unchanged: a heuristic match is still real signal worth a human look,
 * same as before.
 *
 * provider relabeled following the same explicit-placeholder pattern this
 * session already used for deletion-certification's unsigned signature
 * column (UNSIGNED-NO-PQ-BACKEND-V1) -- reads as non-authoritative in any
 * audit query, not just in prose documentation.
 *
 * No database access -- source file edits only. Idempotent.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO_ROOT  = path.join(__dirname, '..');
const AGENT_FILE = path.join(REPO_ROOT, 'agents', 'ofac-screening', 'index.js');
const MANIFEST   = path.join(REPO_ROOT, 'agents', 'ofac-screening', 'manifest.json');
const README     = path.join(REPO_ROOT, 'agents', 'ofac-screening', 'README.md');

const MARKER = 'CLOSE-GAP-25';

const OLD_AGENT = `  const status = flags.length > 0 ? 'flagged' : 'clear';

  // Record result in DB
  if (client_id && db) {
    await db.clients.query(
      \`INSERT INTO pcm_ofac_results 
         (client_id, provider, provider_reference_id, status, match_count, 
          raw_response_summary, screened_by_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7)\`,
      [
        client_id,
        'CoreIdentity-OFAC-Agent',
        \`COREG-\${Date.now()}\`,
        status,
        flags.length,
        JSON.stringify({ flags, warnings }),
        'ofac-screening-agent'
      ]
    );`;

const NEW_AGENT = `  // CLOSE-GAP-25: this agent has never called an external sanctions API --
  // it is a hardcoded heuristic (10 country strings, 4 regex patterns).
  // A match is still real signal ('flagged'), but "no match" is NOT the
  // same claim as "screened clean against the real SDN list" -- calling
  // it 'clear' let the kyc_verification gate treat an unauthoritative
  // heuristic as a completed sanctions screen. See
  // db/migrations/0001-ofac-status-not-authoritative.sql.
  const status = flags.length > 0 ? 'flagged' : 'not_authoritatively_screened';

  // Record result in DB
  if (client_id && db) {
    await db.clients.query(
      \`INSERT INTO pcm_ofac_results 
         (client_id, provider, provider_reference_id, status, match_count, 
          raw_response_summary, screened_by_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7)\`,
      [
        client_id,
        'HEURISTIC-PRESCREEN-NOT-SDN-V1',
        \`COREG-\${Date.now()}\`,
        status,
        flags.length,
        JSON.stringify({ flags, warnings }),
        'ofac-screening-agent'
      ]
    );`;

function patchAgent() {
  let contents = fs.readFileSync(AGENT_FILE, 'utf8');
  if (contents.includes(MARKER)) {
    console.log('✓ CLOSE-GAP-25 already applied to ofac-screening/index.js — no-op.');
    return;
  }
  if (!contents.includes(OLD_AGENT)) {
    console.error('✗ Expected block not found in ofac-screening/index.js — file may have changed.');
    process.exit(1);
  }
  contents = contents.replace(OLD_AGENT, NEW_AGENT);
  fs.writeFileSync(AGENT_FILE, contents, 'utf8');
  console.log('✓ ofac-screening/index.js: relabeled provider, status no longer claims "clear".');
}

function fixManifest() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const FALSE_CLAIM = 'Runs client name, entity, and banking partner against OFAC/sanctions watchlists via third-party API. Logs result to audit trail.';
  const CORRECTED = 'Heuristic pre-screen only -- matches client name/country against a hardcoded list (10 countries, 4 regex patterns compiled into source). Does NOT call any external OFAC/SDN API or watchlist. A match is real signal (status: flagged); no match does NOT mean a real sanctions screen cleared this client (status: not_authoritatively_screened). Logs result to audit trail.';
  if (manifest.description === FALSE_CLAIM) {
    manifest.description = CORRECTED;
    fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    console.log('✓ Corrected ofac-screening manifest.json false "third-party API" claim.');
  } else if (manifest.description === CORRECTED) {
    console.log('✓ ofac-screening manifest already corrected — no-op.');
  } else {
    console.error('✗ manifest.json description does not match expected old or new text — manual review required.');
    process.exit(1);
  }
}

function fixReadme() {
  let contents = fs.readFileSync(README, 'utf8');
  const OLD = 'Runs client name, entity, and banking partner against OFAC/sanctions watchlists via third-party API. Logs result to audit trail.';
  const NEW = 'Heuristic pre-screen only -- matches client name/country against a hardcoded list (10 countries, 4 regex patterns compiled into source). Does NOT call any external OFAC/SDN API or watchlist. A match is real signal (status: flagged); no match does NOT mean a real sanctions screen cleared this client (status: not_authoritatively_screened). Logs result to audit trail.\n\n**CLOSE-GAP-25:** full OFAC SDN list integration is tracked separately (see docs/Instrument-Counterparty-Integrity-Agent-Spec.md §6.3) -- ingesting Treasury\'s actual SDN dataset and a real matching pipeline is a genuine data-integration dependency, not something this agent currently does.';
  if (contents.includes(OLD)) {
    contents = contents.replace(OLD, NEW);
    fs.writeFileSync(README, contents, 'utf8');
    console.log('✓ Corrected ofac-screening README.md false "third-party API" claim.');
  } else if (contents.includes('CLOSE-GAP-25')) {
    console.log('✓ ofac-screening README already corrected — no-op.');
  } else {
    console.error('✗ README.md description does not match expected old text — manual review required.');
    process.exit(1);
  }
}

function main() {
  patchAgent();
  fixManifest();
  fixReadme();
  console.log('\nRunning npm run build...');
  execSync('npm run build', { cwd: REPO_ROOT, stdio: 'inherit' });
}

main();
