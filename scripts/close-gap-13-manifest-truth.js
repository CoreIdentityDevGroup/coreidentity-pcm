#!/usr/bin/env node
/**
 * CLOSE-GAP-13: Manifest truth pass — documentation only, no code changes
 *
 * Across all 12 agent manifests, ais-registration-manifest.json, and the
 * 11 agent READMEs (instrument-integrity has no README — 11, not 12):
 *
 *   1. "sentinel_enforced": true  →  "sentinel_enforced": false
 *      sentinelCheck() (api/services/governance.js) has no call site
 *      anywhere in the codebase. It is not wired pending a decision — it
 *      is unwired today. Set false, not removed, so the field stays
 *      available to flip once a real call site exists.
 *
 *   2. "pq_signing": "ML-DSA-65"  →  "pq_signing": "UNSIGNED-NO-PQ-BACKEND-V1"
 *      No ML-DSA/SLH-DSA/post-quantum signing library or implementation
 *      exists anywhere in this repo or its dependencies. Value reuses the
 *      exact label agents/deletion-certification/index.js already writes
 *      into certificate_signature for the same reason, rather than
 *      inventing a second label for the same fact.
 *
 *   3. README "| Sentinel | Enforced |" governance-table rows are removed
 *      entirely (not corrected to a different value — the row asserted a
 *      capability that isn't there; there is nothing accurate to put in
 *      its place that isn't already covered by the Sentinel field's
 *      removal from the manifest itself).
 *
 *   4. README "| PQ Signing | ML-DSA-65 |" rows are corrected in place to
 *      "| PQ Signing | UNSIGNED-NO-PQ-BACKEND-V1 |" — same reasoning as (2).
 *
 *   5. token-minting's description (manifest.json AND README.md both carry
 *      the identical sentence) claims "cryptographically signed
 *      classification certificate." agents/token-minting/index.js performs
 *      no cryptographic operation at all — no hash, no signature, no
 *      keypair — it only writes the string 'ML-DSA-65' into a JSON field.
 *      Corrected to state plainly that the certificate is not signed.
 *
 * This script does not touch any agents/*\/index.js, api/*, or
 * agent-orchestrator.js — documentation only, per instruction. No database
 * access. No git push.
 *
 * Idempotent: each rule is detected independently per file by checking for
 * its "before" text; a file/rule already in the corrected state is
 * reported as such and left alone. Re-running after a full pass reports
 * everything as already-correct and exits 0 without writing or running the
 * build.
 *
 * Ends with: npm run build
 *
 * Run: node scripts/close-gap-13-manifest-truth.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');

const AGENTS = [
  'asset-classifier', 'bank-routing', 'contract-monitoring',
  'deletion-certification', 'document-date-validator', 'instrument-integrity',
  'intake-parser', 'ofac-screening', 'pof-verifier', 'token-minting',
  'transaction-monitoring', 'valuation-parser'
];

const MANIFEST_FILES = [
  ...AGENTS.map(a => path.join(REPO_ROOT, 'agents', a, 'manifest.json')),
  path.join(REPO_ROOT, 'ais-registration-manifest.json')
];

// instrument-integrity has no README.md — 11 agents, not 12.
const README_FILES = AGENTS
  .filter(a => a !== 'instrument-integrity')
  .map(a => path.join(REPO_ROOT, 'agents', a, 'README.md'));

const SENTINEL_FIELD_OLD = '"sentinel_enforced": true,';
const SENTINEL_FIELD_NEW = '"sentinel_enforced": false,';

const PQ_FIELD_OLD = '"pq_signing": "ML-DSA-65"';
const PQ_FIELD_NEW = '"pq_signing": "UNSIGNED-NO-PQ-BACKEND-V1"';

const SENTINEL_ROW = '| Sentinel | Enforced |';

const PQ_ROW_OLD = '| PQ Signing | ML-DSA-65 |';
const PQ_ROW_NEW = '| PQ Signing | UNSIGNED-NO-PQ-BACKEND-V1 |';

const TOKEN_MINTING_DESC_OLD =
  'Mints cryptographically signed classification certificate upon trade completion. ID and verification only — no transferable right.';
const TOKEN_MINTING_DESC_NEW =
  'Mints a classification certificate upon trade completion. Certificate is not cryptographically signed — no PQ signing backend is implemented. ID and verification only — no transferable right.';

function replaceAllCount(str, find, replace) {
  const count = str.split(find).length - 1;
  return { result: count > 0 ? str.split(find).join(replace) : str, count };
}

function removeLineCount(str, exactLine) {
  const lines = str.split('\n');
  let count = 0;
  const kept = lines.filter(line => {
    if (line === exactLine) { count++; return false; }
    return true;
  });
  return { result: kept.join('\n'), count };
}

function processManifest(filePath, changes) {
  const rel = path.relative(REPO_ROOT, filePath);
  if (!fs.existsSync(filePath)) {
    changes.push({ file: rel, rule: 'file-check', status: 'ABORT', detail: 'file not found' });
    return false;
  }
  let contents = fs.readFileSync(filePath, 'utf8');
  let dirty = false;

  const sentinelOutcome = applyOne(contents, SENTINEL_FIELD_OLD, SENTINEL_FIELD_NEW, SENTINEL_FIELD_NEW);
  contents = sentinelOutcome.contents;
  if (sentinelOutcome.changed) dirty = true;
  changes.push({ file: rel, rule: 'sentinel_enforced', status: sentinelOutcome.status, count: sentinelOutcome.count });

  const pqOutcome = applyOne(contents, PQ_FIELD_OLD, PQ_FIELD_NEW, PQ_FIELD_NEW);
  contents = pqOutcome.contents;
  if (pqOutcome.changed) dirty = true;
  changes.push({ file: rel, rule: 'pq_signing', status: pqOutcome.status, count: pqOutcome.count });

  if (filePath.endsWith(path.join('token-minting', 'manifest.json'))) {
    const descOld = `"description": "${TOKEN_MINTING_DESC_OLD}",`;
    const descNew = `"description": "${TOKEN_MINTING_DESC_NEW}",`;
    const descOutcome = applyOne(contents, descOld, descNew, descNew);
    contents = descOutcome.contents;
    if (descOutcome.changed) dirty = true;
    changes.push({ file: rel, rule: 'signed-description', status: descOutcome.status, count: descOutcome.count });
  }

  if (dirty) fs.writeFileSync(filePath, contents, 'utf8');
  return dirty;
}

function processReadme(filePath, changes) {
  const rel = path.relative(REPO_ROOT, filePath);
  if (!fs.existsSync(filePath)) {
    changes.push({ file: rel, rule: 'file-check', status: 'ABORT', detail: 'file not found' });
    return false;
  }
  let contents = fs.readFileSync(filePath, 'utf8');
  let dirty = false;

  const hasSentinelRow = contents.includes(SENTINEL_ROW);
  if (hasSentinelRow) {
    const { result, count } = removeLineCount(contents, SENTINEL_ROW);
    contents = result;
    dirty = true;
    changes.push({ file: rel, rule: 'sentinel-row-removed', status: 'CHANGED', count });
  } else {
    changes.push({ file: rel, rule: 'sentinel-row-removed', status: 'ALREADY_CORRECT', count: 0 });
  }

  const pqOutcome = applyOne(contents, PQ_ROW_OLD, PQ_ROW_NEW, PQ_ROW_NEW);
  contents = pqOutcome.contents;
  if (pqOutcome.changed) dirty = true;
  changes.push({ file: rel, rule: 'pq-signing-row', status: pqOutcome.status, count: pqOutcome.count });

  if (filePath.endsWith(path.join('token-minting', 'README.md'))) {
    const descOutcome = applyOne(contents, TOKEN_MINTING_DESC_OLD, TOKEN_MINTING_DESC_NEW, TOKEN_MINTING_DESC_NEW);
    contents = descOutcome.contents;
    if (descOutcome.changed) dirty = true;
    changes.push({ file: rel, rule: 'signed-description', status: descOutcome.status, count: descOutcome.count });
  }

  if (dirty) fs.writeFileSync(filePath, contents, 'utf8');
  return dirty;
}

// Applies a find->replace; if find is absent but replace is already present,
// treats the rule as already-correct (idempotent re-run); if neither is
// present, flags UNEXPECTED without touching the file (refuse blind edit).
function applyOne(contents, find, replace, alreadyCorrectMarker) {
  if (contents.includes(find)) {
    const { result, count } = replaceAllCount(contents, find, replace);
    return { contents: result, changed: true, status: 'CHANGED', count };
  }
  if (contents.includes(alreadyCorrectMarker)) {
    return { contents, changed: false, status: 'ALREADY_CORRECT', count: 0 };
  }
  return { contents, changed: false, status: 'UNEXPECTED_NOT_FOUND', count: 0 };
}

function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  CLOSE-GAP-13 — Manifest Truth Pass                  ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');

  const changes = [];
  let anyDirty = false;
  let anyUnexpected = false;

  for (const f of MANIFEST_FILES) {
    if (processManifest(f, changes)) anyDirty = true;
  }
  for (const f of README_FILES) {
    if (processReadme(f, changes)) anyDirty = true;
  }

  // ─── PER-FILE REPORT ────────────────────────────────────────────────────
  const byFile = new Map();
  for (const c of changes) {
    if (!byFile.has(c.file)) byFile.set(c.file, []);
    byFile.get(c.file).push(c);
  }

  for (const [file, rules] of byFile) {
    console.log(`${file}`);
    for (const r of rules) {
      if (r.status === 'ABORT') {
        console.log(`  ✗ ${r.rule}: ${r.detail}`);
        anyUnexpected = true;
      } else if (r.status === 'CHANGED') {
        console.log(`  ✓ ${r.rule}: changed (${r.count} occurrence${r.count === 1 ? '' : 's'})`);
      } else if (r.status === 'ALREADY_CORRECT') {
        console.log(`  · ${r.rule}: already correct — no-op`);
      } else {
        console.log(`  ⚠ ${r.rule}: expected text not found (neither old nor corrected form) — left untouched, needs manual review`);
        anyUnexpected = true;
      }
    }
  }
  console.log('');

  if (anyUnexpected) {
    console.error('✗ One or more files had unexpected content — see ⚠/✗ lines above. Refusing to run build on an inconsistent result. Manual review required.');
    process.exit(1);
  }

  if (!anyDirty) {
    console.log('✓ CLOSE-GAP-13 already fully applied across all files — no-op.');
    return;
  }

  console.log('✓ CLOSE-GAP-13 applied.');
  console.log('\nRunning npm run build...');
  execSync('npm run build', { cwd: REPO_ROOT, stdio: 'inherit' });
}

main();
