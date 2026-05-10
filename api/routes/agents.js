'use strict';
const express      = require('express');
const { runAgent, runMonitoringCycle } = require('../../agent-orchestrator');
const router       = express.Router();

// POST /api/v1/agents/run
// Body: { agent_name, context }
router.post('/run', async (req, res) => {
  const { agent_name, context } = req.body;
  if (!agent_name) return res.status(400).json({ error: 'agent_name required' });

  try {
    const result = await runAgent(agent_name, context || {});
    res.json({ agent: agent_name, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/agents/monitoring
// Runs contract + transaction monitoring cycle
router.post('/monitoring', async (req, res) => {
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
    'transaction-monitoring'
  ];
  res.json({ agents, count: agents.length });
});

module.exports = router;
