'use strict';

const { execSync } = require('child_process');

// Load AIS agent keys from Secrets Manager at startup
let aisKeys = null;
function getAisKeys() {
  if (aisKeys) return aisKeys;
  try {
    const result = execSync(
      'aws secretsmanager get-secret-value --region us-east-2 --secret-id coreidentity/coreg/ais-agent-keys --query SecretString --output text',
      { encoding: 'utf8', timeout: 5000 }
    );
    aisKeys = JSON.parse(result.trim());
    console.log(JSON.stringify({ level: 'info', message: 'AIS agent keys loaded', count: Object.keys(aisKeys).length }));
  } catch (err) {
    console.warn(JSON.stringify({ level: 'warn', message: 'AIS keys unavailable', error: err.message }));
    aisKeys = {};
  }
  return aisKeys;
}

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
  
  // Inject AIS identity for this agent
  const keys = getAisKeys();
  const agentKey = keys[name];
  if (agentKey) {
    context.ais_agent_id = agentKey.agent_id;
    context.ais_api_key  = agentKey.api_key;
  }

  const start = Date.now();
  console.log(JSON.stringify({
    level: 'info',
    message: `Agent executing`,
    agent: name,
    timestamp: new Date().toISOString()
  }));

  try {
    const result = await agent.execute({ ...context, db });
    const duration_ms = Date.now() - start;
    console.log(JSON.stringify({
      level: 'info',
      message: `Agent complete`,
      agent: name,
      status: result.status,
      action: result.action,
      duration_ms,
      timestamp: new Date().toISOString()
    }));

    // Write to agent activity feed — non-blocking
    db.clients.query(
      `INSERT INTO pcm_agent_activity
         (agent_name, agent_id, client_id, asset_id, action, status,
          decision, proof_pack_id, duration_ms, result_summary, triggered_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        name,
        context.ais_agent_id || null,
        context.client_id   || null,
        context.asset_id    || null,
        result.action       || null,
        result.status       || null,
        result.decision     || null,
        context.proof_pack_id || null,
        duration_ms,
        JSON.stringify({
          message: result.message,
          flags:   result.flags,
          confidence: result.confidence
        }),
        context.triggered_by || 'auto'
      ]
    ).catch(err => console.error(JSON.stringify({
      level: 'error', message: 'Activity log failed', error: err.message
    })));

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
