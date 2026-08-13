#!/usr/bin/env node
/**
 * CLOSE-GAP-18: POST /api/v1/agents/run permits any authenticated role to
 * invoke any agent by name, bypassing every gate
 *
 * Finding: the route had no authorize() call at all (only the mount-level
 * `authenticate` in api/app.js), so any authenticated user regardless of
 * role could invoke any of the 12 agents directly, including agents whose
 * writes are gate-bound.
 *
 * Determined from code, not guessed, which agents are gate-bound /
 * write-consequential by reading every agent's own source for direct
 * database writes and cross-referencing against GATE_REQUIREMENTS
 * (api/services/pipeline.js) and the rest of the schema:
 *
 *   - ofac-screening writes pcm_clients.ofac_status directly -- the exact
 *     column the kyc_verification gate checker reads.
 *   - instrument-integrity writes pcm_assets.instrument_integrity_status
 *     directly, with an unconditional UPDATE (no WHERE guard excluding
 *     already-verified assets). It never sets 'verified' itself (only
 *     'blocked' / 'pending_human_verification'), but running it again
 *     after a human has verified an asset via POST /verify-instrument
 *     would silently revert that attestation back to blocked/pending --
 *     this is the exact attestation-control bypass named in the task.
 *   - token-minting writes a 'governance_token' row to
 *     pcm_asset_documents with its own independently-generated token_id
 *     scheme (TKN-...), distinct from and not synchronized with
 *     pipeline.js's real triggerTokenization() (which writes
 *     pcm_classification_tokens and sets pcm_assets.token_id -- the
 *     column the 'completed' gate actually reads). Direct invocation
 *     doesn't satisfy that gate, but does create a permanent, misleading
 *     "token minted" document record under a token_id that doesn't match
 *     any Real token.
 *   - deletion-certification writes a permanent pcm_deletion_certificates
 *     row asserting documents were deleted (retention_period:
 *     'permanent', per-document certified_deleted_at timestamps) -- but
 *     contains no DELETE statement anywhere in the file. It certifies
 *     deletion of documents it never deletes, regardless of invocation
 *     path. Flagged separately as its own finding; not fixed here, but
 *     this alone is reason enough that direct, low-friction invocation
 *     must not be allowed.
 *   - contract-monitoring writes to pcm_monitoring_log, a table that does
 *     not exist in the live schema (the real table is
 *     pcm_contract_monitoring_log -- see CLAIMS-INVENTORY.txt). Currently
 *     errors if run, but excluded here on the write-consequential
 *     classification, not on "it happens to be broken right now."
 *
 * The other 7 agents (intake-parser, asset-classifier,
 * document-date-validator, pof-verifier, valuation-parser, bank-routing,
 * transaction-monitoring) were read in full: none perform any database
 * write at all -- each returns an advisory result object only, logged to
 * pcm_agent_activity by the orchestrator, nothing else. Direct invocation
 * of these has no write side effect beyond that activity-log entry.
 *
 * Fix: restrict POST /run to trade_group_owner (PCM's top role --
 * ROLE_HIERARCHY has no separate ADMIN tier) and block the five
 * gate-bound / write-consequential agents by name regardless of role,
 * with a 403 naming the reason and (for the two directly gate-tied ones)
 * the correct path. The route is not removed: the remaining 7 agents are
 * genuinely side-effect-free to invoke directly and this is a reasonable
 * diagnostic surface for them, restricted to the top role.
 *
 * No database access of any kind -- this script only edits source files
 * and runs `npm run build`.
 *
 * Idempotent: detects the existing GATE_BOUND_AGENTS block before
 * writing; no-ops cleanly on re-run.
 *
 * Run: node scripts/close-gap-18-restrict-agent-run.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const TARGET    = path.join(REPO_ROOT, 'api', 'routes', 'agents.js');

const OLD_HEADER = `'use strict';
const governance = require('../services/governance');
const express      = require('express');
const { runAgent, runMonitoringCycle } = require('../../agent-orchestrator');
const router       = express.Router();

// POST /api/v1/agents/run
// Body: { agent_name, context }
router.post('/run', async (req, res) => {
  const { agent_name, context } = req.body;
  if (!agent_name) return res.status(400).json({ error: 'agent_name required' });

  try {`;

const NEW_HEADER = `'use strict';
const governance = require('../services/governance');
const express      = require('express');
const { authorize } = require('../middleware/authorize');
const { runAgent, runMonitoringCycle } = require('../../agent-orchestrator');
const router       = express.Router();

// CLOSE-GAP-18: agents whose own execution writes a gate-bound column, or
// whose write is otherwise consequential enough that it must not be
// reachable outside its intended flow. See this script's header comment
// for the source-level justification for each. Blocked regardless of
// caller role -- this is not a role-escalation gap, it's a
// wrong-entry-point gap.
const GATE_BOUND_AGENTS = {
  'ofac-screening': 'writes pcm_clients.ofac_status directly, read by the kyc_verification gate. Use the normal client-creation flow.',
  'instrument-integrity': 'writes pcm_assets.instrument_integrity_status with no guard against overwriting a human-set \\'verified\\' status. Re-verification must go through POST /verify-instrument, never this agent directly.',
  'token-minting': 'writes a governance_token record with its own token_id scheme, independent of and not synchronized with the real minting path in advancePipeline(). Token minting happens automatically on advance to the tokenization stage.',
  'deletion-certification': 'writes a permanent pcm_deletion_certificates record asserting deletion occurred. Not invocable directly pending review of what this agent actually does (see CLOSE-GAP-18 commit).',
  'contract-monitoring': 'writes to the monitoring/alerting log. Runs on schedule via runMonitoringCycle(), not on demand per-agent.'
};

// POST /api/v1/agents/run
// Body: { agent_name, context }
router.post('/run', authorize('trade_group_owner'), async (req, res) => {
  const { agent_name, context } = req.body;
  if (!agent_name) return res.status(400).json({ error: 'agent_name required' });

  if (GATE_BOUND_AGENTS[agent_name]) {
    return res.status(403).json({
      error: 'Agent not directly invocable',
      agent_name,
      reason: GATE_BOUND_AGENTS[agent_name]
    });
  }

  try {`;

function main() {
  if (!fs.existsSync(TARGET)) {
    console.error(`✗ Target file not found: ${TARGET}`);
    process.exit(1);
  }

  const contents = fs.readFileSync(TARGET, 'utf8');

  if (contents.includes('GATE_BOUND_AGENTS')) {
    console.log('✓ CLOSE-GAP-18 already applied — no-op.');
    return;
  }

  if (!contents.includes(OLD_HEADER)) {
    console.error('✗ Expected route header not found — file may have changed since this script was written.');
    console.error('  Refusing to apply blind edit. Manual review required.');
    process.exit(1);
  }

  fs.writeFileSync(TARGET, contents.replace(OLD_HEADER, NEW_HEADER), 'utf8');
  console.log('✓ CLOSE-GAP-18 applied: POST /api/v1/agents/run restricted to trade_group_owner,');
  console.log('  and blocks 5 gate-bound/write-consequential agents by name regardless of role.');

  console.log('\nRunning npm run build...');
  execSync('npm run build', { cwd: REPO_ROOT, stdio: 'inherit' });
}

main();
