#!/usr/bin/env node
/**
 * CLOSE-GAP-28 (Phase 3.4, part 4): two general validator rules, requested
 * after CLOSE-GAP-24/25 (manifest false-capability claims) and CLOSE-
 * GAP-27 (kyc_verification's blocklist bug) turned out to be instances of
 * a general pattern rather than one-off bugs.
 *
 * 2.6 Manifest external-source truth — any agent manifest/description
 *     that claims an external data source (API, watchlist, SDN, etc.)
 *     the agent's own code never actually calls, fails. Sentence-level,
 *     negation-aware (an agent explicitly documenting that it does NOT
 *     call an external source, like ofac-screening now does, must not
 *     trip this).
 *
 * 2.7 Gate allowlist/blocklist pattern — any GATE_REQUIREMENTS checker
 *     that enumerates bad values and passes everything else by omission
 *     fails. Detects direct `if (<expr> === 'literal>') errors.push(...)`
 *     conditions not wrapped in a negated/flag-guarded form. Count-based
 *     and truthy-negation checks are not flagged (0 is unambiguously bad
 *     for a count; there's no "unknown future good count" risk the way
 *     there is for a status enum).
 *
 * Run against this repo before writing: kyc_verification (just fixed in
 * CLOSE-GAP-27) correctly reports allowlist; appraisal_review reports
 * blocklist on two conditions (val_status === 'failed',
 * integrityStatus === 'blocked') -- a real, second instance of the same
 * defect class, not fixed by this script. Flagged for Phase 6 follow-up,
 * consistent with how this scrub has surfaced findings via the validator
 * without always fixing them same-session.
 *
 * No database access. Idempotent (detects the CLOSE-GAP-28 marker).
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const TARGET    = path.join(REPO_ROOT, 'scripts', 'validate-agents.js');

const MARKER = 'CLOSE-GAP-28';

const NEW_CHECKS = `
// ═════════════════════════════════════════════════════════════════════════
// 2.6 — MANIFEST EXTERNAL-SOURCE TRUTH (CLOSE-GAP-28)
// ═════════════════════════════════════════════════════════════════════════
//
// General form of CLOSE-GAP-24 (deletion-certification's manifest claimed
// it executes deletion; it doesn't) and CLOSE-GAP-25 (ofac-screening's
// manifest claimed a third-party API call; it's hardcoded regex). Any
// agent whose manifest description implies an authoritative external data
// source it does not actually consult is asserting a capability it does
// not have.
const EXTERNAL_CLAIM_PATTERNS = [
  /third-party\\s+api/i, /third-party\\s+service/i, /\\bwatchlist\\b/i,
  /external\\s+(service|api|data\\s+source)/i, /\\bSDN\\b/, /\\bvia\\s+api\\b/i,
];
const EXTERNAL_CLAIM_NEGATION = /\\b(does not|do not|doesn't|don't|never|no external|without calling|not currently|not itself)\\b/i;
const CODE_EXTERNAL_EVIDENCE = [
  /require\\(\\s*['"](?:axios|node-fetch|https?)['"]\\s*\\)/, /\\bfetch\\(/,
  /\\baxios\\s*\\./, /\\bhttps?\\.request\\(/, /\\bhttps?\\.get\\(/,
];

function check2_6() {
  for (const agent of REQUIRED_AGENTS) {
    const manifestPath = path.join(AGENTS_DIR, agent, 'manifest.json');
    const indexPath    = path.join(AGENTS_DIR, agent, 'index.js');
    if (!fs.existsSync(manifestPath) || !fs.existsSync(indexPath)) continue;

    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
    catch (e) { record('2.6', 'fail', \`\${agent}: manifest.json parse error — \${e.message}\`); continue; }

    const desc = manifest.description || '';
    // Sentence-level so a negated claim ("Does NOT call any external...
    // API or watchlist") doesn't trip the same trigger words it's using
    // to honestly document the absence of that capability.
    const sentences = desc.split(/(?<=[.!?])\\s+/);
    const claimingSentences = sentences.filter(s =>
      EXTERNAL_CLAIM_PATTERNS.some(p => p.test(s)) && !EXTERNAL_CLAIM_NEGATION.test(s)
    );

    if (claimingSentences.length === 0) {
      record('2.6', 'pass', \`\${agent}: manifest makes no unverified external-data-source claim\`);
      continue;
    }

    const code = fs.readFileSync(indexPath, 'utf8');
    const hasExternalCall = CODE_EXTERNAL_EVIDENCE.some(p => p.test(code));
    if (hasExternalCall) {
      record('2.6', 'pass', \`\${agent}: manifest claims an external source and index.js actually calls out (fetch/axios/http)\`);
    } else {
      record('2.6', 'fail', \`\${agent}: manifest claims an external data source ("\${claimingSentences[0].trim()}") but index.js contains no external HTTP call — general form of CLOSE-GAP-24/25\`);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════
// 2.7 — GATE ALLOWLIST/BLOCKLIST PATTERN (CLOSE-GAP-28)
// ═════════════════════════════════════════════════════════════════════════
//
// General form of CLOSE-GAP-27 (kyc_verification's OFAC check enumerated
// bad statuses and passed everything else, including 'clear', by
// omission). A gate checker that names only the bad value(s) trusts every
// unknown/future value by default; one that names the good value(s) and
// blocks everything else does not. Count-based checks (=== 0) and truthy
// negations (!x) are inherently allowlist-shaped and not flagged --
// there's no "unknown future good count" the way there is for a status
// enum gaining a new value nobody taught the gate about.
function check2_7() {
  const src = readIfExists(SERVICES_PIPELINE_FILE);
  if (!src) { record('2.7', 'warn', 'Could not read pipeline.js — gate pattern check skipped'); return; }

  const startMarker = 'const GATE_REQUIREMENTS = {';
  const start = src.indexOf(startMarker);
  if (start === -1) { record('2.7', 'warn', 'GATE_REQUIREMENTS not found — gate pattern check skipped'); return; }
  let depth = 0, i = start + startMarker.length - 1, end = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const body = src.slice(start, end + 1);

  // Split into per-gate blocks: \`name: async (...) => { ... }\`. Gates
  // written as \`name: async () => []\` (rejected/on_hold -- no data
  // precondition, checkRoleAuthority is the real control) have no brace
  // body and are intentionally not matched here; there is nothing in them
  // to classify.
  const gateStartPattern = /(\\w+):\\s*async\\s*\\([^)]*\\)\\s*=>\\s*\\{/g;
  const starts = [];
  let gm;
  while ((gm = gateStartPattern.exec(body)) !== null) {
    starts.push({ name: gm[1], bodyStart: gm.index + gm[0].length - 1 });
  }

  for (const { name, bodyStart } of starts) {
    let d = 0, j = bodyStart, gEnd = -1;
    for (; j < body.length; j++) {
      if (body[j] === '{') d++;
      if (body[j] === '}') { d--; if (d === 0) { gEnd = j; break; } }
    }
    const text = body.slice(bodyStart, gEnd + 1);

    // Direct, brace-less \`if (<cond>) errors.push(\` -- the shape a
    // one-line blocklist condition takes in this codebase. Conditions
    // wrapped in a block (multi-condition \`if (...) { errors.push(...); }\`
    // or a satisfied-flag guard like \`if (!satisfied) { errors.push(...); }\`)
    // are deliberately not matched by this brace-less pattern -- the flag-
    // guard idiom is exactly the allowlist shape CLOSE-GAP-27 introduced,
    // and is correctly invisible to a check looking for direct pushes.
    const directPushes = [...text.matchAll(/if\\s*\\(([^)]*?)\\)\\s*errors\\.push/g)].map(m => m[1].trim());

    const blocklistHits = [];
    for (const cond of directPushes) {
      if (/!==/.test(cond)) continue;                 // negated equality: allowlist-shaped
      if (/!\\s*[\\w.]/.test(cond)) continue;            // truthy negation: allowlist-shaped
      if (/===\\s*0\\b/.test(cond)) continue;            // count-based: not a status field
      const eqMatch = cond.match(/[\\w.\\[\\]?]+\\s*===\\s*'[^']*'/);
      if (eqMatch) blocklistHits.push(cond);
    }

    if (blocklistHits.length > 0) {
      record('2.7', 'fail', \`\${name}: blocklist pattern — enumerates bad value(s) (\${blocklistHits.join('; ')}) and passes any other value by omission, including unknown/future values. Rewrite as an allowlist: name the good value(s) explicitly and block everything else by default.\`);
    } else {
      record('2.7', 'pass', \`\${name}: allowlist pattern (or no status-literal comparisons to evaluate)\`);
    }
  }
}
`;

function patchValidator() {
  let contents = fs.readFileSync(TARGET, 'utf8');
  if (contents.includes(MARKER)) {
    console.log('✓ CLOSE-GAP-28 already applied to validate-agents.js — no-op.');
    return;
  }

  const MAIN_ANCHOR = `// ═════════════════════════════════════════════════════════════════════════
// MAIN
// ═════════════════════════════════════════════════════════════════════════`;
  if (!contents.includes(MAIN_ANCHOR)) {
    console.error('✗ MAIN section anchor not found — file may have changed.');
    process.exit(1);
  }
  contents = contents.replace(MAIN_ANCHOR, NEW_CHECKS + '\n' + MAIN_ANCHOR);

  const OLD_CALLS = `  console.log('\\n── 2.5 Deployment drift (advisory) ─────────────────────');
  check2_5();

  for (const r of results) {`;
  const NEW_CALLS = `  console.log('\\n── 2.5 Deployment drift (advisory) ─────────────────────');
  check2_5();
  console.log('\\n── 2.6 Manifest external-source truth ──────────────────');
  check2_6();
  console.log('\\n── 2.7 Gate allowlist/blocklist pattern ────────────────');
  check2_7();

  for (const r of results) {`;
  if (!contents.includes(OLD_CALLS)) {
    console.error('✗ main() check-call block not found — file may have changed.');
    process.exit(1);
  }
  contents = contents.replace(OLD_CALLS, NEW_CALLS);

  // Add the CLOSE-GAP-26 exemption entries for the new attestation write
  // sites (documentation completeness -- the existing whole-file match
  // already passes these, but each write site deserves its own named
  // exemption rather than free-riding on an unrelated one's presence in
  // the same file).
  const OLD_EXEMPT = `  { file: 'api/routes/clients.js', col: 'ofac_status',    match: "SET ofac_status = 'manual_review'", reason: 'CLOSE-GAP-19a dual-control override endpoint; sets status only after two-principal confirmation, verified independently by the KYC gate' },
  { file: 'api/routes/clients.js', col: 'review_outcome', match: "review_outcome = 'MANUAL_OVERRIDE_CONFIRMED'", reason: 'CLOSE-GAP-19a countersign step; the KYC gate independently re-verifies this value against pcm_ofac_results rather than trusting the flag' },`;
  const NEW_EXEMPT = `  { file: 'api/routes/clients.js', col: 'ofac_status',    match: "SET ofac_status = 'manual_review'", reason: 'CLOSE-GAP-19a dual-control override endpoint; sets status only after two-principal confirmation, verified independently by the KYC gate' },
  { file: 'api/routes/clients.js', col: 'review_outcome', match: "review_outcome = 'MANUAL_OVERRIDE_CONFIRMED'", reason: 'CLOSE-GAP-19a countersign step; the KYC gate independently re-verifies this value against pcm_ofac_results rather than trusting the flag' },
  // CLOSE-GAP-28: named exemptions for the CLOSE-GAP-26 attestation
  // write sites, distinct from the MANUAL_OVERRIDE entries above even
  // though the current whole-file check already passes them by
  // coincidence (same file, different literal).
  { file: 'api/routes/clients.js', col: 'ofac_status',    match: "SET ofac_status = 'attested_out_of_band'", reason: 'CLOSE-GAP-26 out-of-band attestation confirm step; sets status only after two-principal confirmation, verified independently by the KYC gate exactly like the manual_review path' },
  { file: 'api/routes/clients.js', col: 'review_outcome', match: "review_outcome = 'ATTESTATION_CONFIRMED'", reason: 'CLOSE-GAP-26 attestation confirm step; the KYC gate independently re-verifies this value against pcm_ofac_results rather than trusting the flag' },`;
  if (contents.includes(OLD_EXEMPT)) {
    contents = contents.replace(OLD_EXEMPT, NEW_EXEMPT);
  }

  fs.writeFileSync(TARGET, contents, 'utf8');
  console.log('✓ Added 2.6 (manifest external-source truth) and 2.7 (gate allowlist/blocklist pattern) to validate-agents.js.');
}

function main() {
  patchValidator();
  console.log('\nRunning npm run build...');
  execSync('npm run build', { cwd: REPO_ROOT, stdio: 'inherit' });
}

main();
