#!/usr/bin/env node
/**
 * CLOSE-GAP-03: Register instrument-integrity in scripts/validate-agents.js
 * so `npm run build` actually validates it like the other 11 agents.
 *
 * Idempotent: checks for existing entry before writing.
 * Run: node scripts/close-gap-03-register-agent-in-build.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const TARGET = path.join(__dirname, 'validate-agents.js');

const OLD_LIST = `const REQUIRED_AGENTS = [
  'intake-parser',
  'asset-classifier',
  'document-date-validator',
  'pof-verifier',
  'ofac-screening',
  'valuation-parser',
  'bank-routing',
  'token-minting',
  'deletion-certification',
  'contract-monitoring',
  'transaction-monitoring',
];`;

const NEW_LIST = `const REQUIRED_AGENTS = [
  'intake-parser',
  'asset-classifier',
  'document-date-validator',
  'pof-verifier',
  'ofac-screening',
  'valuation-parser',
  'bank-routing',
  'token-minting',
  'deletion-certification',
  'contract-monitoring',
  'transaction-monitoring',
  'instrument-integrity', // CLOSE-GAP-03
];`;

function main() {
  if (!fs.existsSync(TARGET)) {
    console.error(`✗ Target file not found: ${TARGET}`);
    process.exit(1);
  }

  const contents = fs.readFileSync(TARGET, 'utf8');

  if (contents.includes(`'instrument-integrity'`)) {
    console.log('✓ CLOSE-GAP-03 already applied — no-op.');
    return;
  }

  if (!contents.includes(OLD_LIST)) {
    console.error('✗ Expected REQUIRED_AGENTS block not found — file may have changed since this script was written.');
    process.exit(1);
  }

  fs.writeFileSync(TARGET, contents.replace(OLD_LIST, NEW_LIST), 'utf8');
  console.log('✓ CLOSE-GAP-03 applied: instrument-integrity now required by npm run build.');
}

main();
