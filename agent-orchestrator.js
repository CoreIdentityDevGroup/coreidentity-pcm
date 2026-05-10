'use strict';

const db = require('./api/services/db');

// Load all agents
const agents = {
  'intake-parser':            require('./agents/intake-parser'),
  'asset-classifier':         require('./agents/asset-classifier'),
  'document-date-validator':  require('./agents/document-date-validator'),
  'pof-verifier':             require('./agents/pof-verifier'),
  'ofac-screening':           require('./agents/ofac-screening'),
  'valuation-parser':         require('./agents/valuation-parser'),
  'bank-routing':             require('./agents/bank-routing'),
  'token-minting':            require('./agents/token-minting'),
  'deletion-certification':   require('./agents/deletion-certification'),
  'contract-monitoring':      require('./agents/contract-monitoring'),
  'transaction-monitoring':   require('./agents/transaction-monitoring')
};

async function runAgent(name, context) {
  const agent = agents[name];
  if (!agent) throw new Error(`Agent not found: ${name}`);
  
  const start = Date.now();
  console.log(JSON.stringify({
    level: 'info',
    message: `Agent executing`,
    agent: name,
    timestamp: new Date().toISOString()
  }));

  try {
    const result = await agent.execute({ ...context, db });
    console.log(JSON.stringify({
      level: 'info',
      message: `Agent complete`,
      agent: name,
      status: result.status,
      action: result.action,
      duration_ms: Date.now() - start,
      timestamp: new Date().toISOString()
    }));
    return result;
  } catch (err) {
    console.error(JSON.stringify({
      level: 'error',
      message: `Agent failed`,
      agent: name,
      error: err.message,
      duration_ms: Date.now() - start,
      timestamp: new Date().toISOString()
    }));
    throw err;
  }
}

// Run monitoring agents on a schedule
async function runMonitoringCycle() {
  console.log(JSON.stringify({
    level: 'info',
    message: 'Monitoring cycle started',
    timestamp: new Date().toISOString()
  }));

  const results = {};

  try {
    results.contract_monitoring    = await runAgent('contract-monitoring', {});
  } catch (err) {
    results.contract_monitoring    = { status: 'error', error: err.message };
  }

  try {
    results.transaction_monitoring = await runAgent('transaction-monitoring', {});
  } catch (err) {
    results.transaction_monitoring = { status: 'error', error: err.message };
  }

  console.log(JSON.stringify({
    level: 'info',
    message: 'Monitoring cycle complete',
    results,
    timestamp: new Date().toISOString()
  }));

  return results;
}

module.exports = { runAgent, runMonitoringCycle };
