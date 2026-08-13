#!/usr/bin/env node
/**
 * CLOSE-GAP-20: POST /api/v1/agents/monitoring has no authorize() at all
 *
 * Any authenticated user, any role, could trigger the full monitoring
 * cycle (contract-monitoring + transaction-monitoring). Matches
 * CLOSE-GAP-18's scoping exactly: trade_group_owner.
 *
 * No database access of any kind -- this script only edits source files
 * and runs `npm run build`.
 *
 * Idempotent: detects the existing authorize() call before writing;
 * no-ops cleanly on re-run.
 *
 * Run: node scripts/close-gap-20-authorize-agent-monitoring.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const TARGET    = path.join(REPO_ROOT, 'api', 'routes', 'agents.js');

const OLD_BLOCK = `// POST /api/v1/agents/monitoring
// Runs contract + transaction monitoring cycle
router.post('/monitoring', async (req, res) => {`;

const NEW_BLOCK = `// POST /api/v1/agents/monitoring
// Runs contract + transaction monitoring cycle
// CLOSE-GAP-20: previously had no authorize() at all.
router.post('/monitoring', authorize('trade_group_owner'), async (req, res) => {`;

function main() {
  if (!fs.existsSync(TARGET)) {
    console.error(`✗ Target file not found: ${TARGET}`);
    process.exit(1);
  }

  const contents = fs.readFileSync(TARGET, 'utf8');

  if (contents.includes('CLOSE-GAP-20')) {
    console.log('✓ CLOSE-GAP-20 already applied — no-op.');
    return;
  }

  if (!contents.includes(OLD_BLOCK)) {
    console.error('✗ Expected POST /monitoring handler not found — file may have changed since this script was written.');
    console.error('  Refusing to apply blind edit. Manual review required.');
    process.exit(1);
  }
  if (!contents.includes("const { authorize } = require('../middleware/authorize');")) {
    console.error('✗ Expected authorize import not found (added by CLOSE-GAP-18) — refusing to apply blind edit.');
    process.exit(1);
  }

  fs.writeFileSync(TARGET, contents.replace(OLD_BLOCK, NEW_BLOCK), 'utf8');
  console.log('✓ CLOSE-GAP-20 applied: POST /api/v1/agents/monitoring now requires trade_group_owner.');

  console.log('\nRunning npm run build...');
  execSync('npm run build', { cwd: REPO_ROOT, stdio: 'inherit' });
}

main();
