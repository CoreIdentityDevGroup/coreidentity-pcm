'use strict';
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
  'instrument-integrity': 'writes pcm_assets.instrument_integrity_status with no guard against overwriting a human-set \'verified\' status. Re-verification must go through POST /verify-instrument, never this agent directly.',
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

  try {
    const result = await runAgent(agent_name, context || {});
    // Log agent action to SAL
    governance.onAgentAction({
      agent_name,
      action: result.action || 'EXECUTE',
      status: result.status,
      resource: `pcm:agent:${agent_name}`,
      context: { ...context }
    }).catch(() => {});

    res.json({ agent: agent_name, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/agents/monitoring
// Runs contract + transaction monitoring cycle
// CLOSE-GAP-20: previously had no authorize() at all.
router.post('/monitoring', authorize('trade_group_owner'), async (req, res) => {
  try {
    const results = await runMonitoringCycle();
    res.json({ status: 'complete', results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/v1/agents/list
router.get('/list', (req, res) => {
  const agents = [
    'intake-parser','asset-classifier','document-date-validator',
    'pof-verifier','ofac-screening','valuation-parser','bank-routing',
    'token-minting','deletion-certification','contract-monitoring',
    'transaction-monitoring','instrument-integrity'
  ];
  res.json({ agents, count: agents.length });
});

module.exports = router;
