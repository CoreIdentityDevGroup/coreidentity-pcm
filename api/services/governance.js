'use strict';

const https = require('https');
const http  = require('http');

const SAL_KERNEL_URL  = process.env.SAL_KERNEL_URL  || 'http://sal-kernel.coreidentitygroup.com:8443';
const SENTINEL_URL    = process.env.SENTINEL_URL    || 'https://api.coreidentitygroup.com';
const AGO_URL         = process.env.AGO_URL         || 'https://api.coreidentitygroup.com';
const COREIDENTITY_API_KEY = process.env.COREIDENTITY_API_KEY;

function makeRequest(urlStr, method, body, headers = {}) {
  return new Promise((resolve) => {
    const parsed  = new URL(urlStr);
    const lib     = parsed.protocol === 'https:' ? https : http;
    const payload = body ? JSON.stringify(body) : null;

    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(COREIDENTITY_API_KEY ? { 'X-API-Key': COREIDENTITY_API_KEY } : {}),
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers
      }
    };

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });

    req.on('error', (err) => {
      console.error(JSON.stringify({
        level: 'error', message: 'Governance request failed',
        error: err.message, url: urlStr
      }));
      resolve({ status: 500, body: { error: err.message } });
    });

    if (payload) req.write(payload);
    req.end();
  });
}

// ── SAL LOGGING ───────────────────────────────────────────────────────────────
async function salLog(event) {
  const payload = {
    agent_id:    event.agent_id   || 'coreg-pcm-platform',
    action:      event.action,
    resource:    event.resource,
    decision:    event.decision   || 'ALLOW',
    context:     event.context    || {},
    timestamp:   new Date().toISOString(),
    platform:    'CoreG-PCM',
    environment: process.env.NODE_ENV || 'production'
  };

  try {
    const result = await makeRequest(
      `${SAL_KERNEL_URL}/v1/arbitrate`,
      'POST',
      payload
    );

    if (result.status === 200 || result.status === 201) {
      console.log(JSON.stringify({
        level: 'info',
        message: 'SAL event logged',
        proof_pack: result.body?.proof_pack_id,
        action: event.action,
        timestamp: new Date().toISOString()
      }));
      return result.body;
    } else {
      console.warn(JSON.stringify({
        level: 'warn',
        message: 'SAL log non-200',
        status: result.status,
        action: event.action
      }));
      return null;
    }
  } catch (err) {
    console.error(JSON.stringify({
      level: 'error', message: 'SAL log failed', error: err.message
    }));
    return null;
  }
}

// ── SENTINEL ENFORCEMENT ──────────────────────────────────────────────────────
async function sentinelCheck(action, resource, context = {}) {
  try {
    const result = await makeRequest(
      `${SENTINEL_URL}/api/v1/sentinel/evaluate`,
      'POST',
      { action, resource, context, platform: 'CoreG-PCM' }
    );

    if (result.status === 200) {
      return {
        allowed:  result.body?.decision === 'ALLOW',
        decision: result.body?.decision || 'UNKNOWN',
        reason:   result.body?.reason   || null
      };
    }

    // If Sentinel unreachable — fail open with warning (governance-in-progress)
    console.warn(JSON.stringify({
      level: 'warn',
      message: 'Sentinel unreachable — failing open',
      action, resource, status: result.status
    }));
    return { allowed: true, decision: 'ALLOW_DEGRADED', reason: 'Sentinel unavailable' };

  } catch (err) {
    console.error(JSON.stringify({
      level: 'error', message: 'Sentinel check failed', error: err.message
    }));
    return { allowed: true, decision: 'ALLOW_ERROR', reason: err.message };
  }
}

// ── AGO ORCHESTRATION ─────────────────────────────────────────────────────────
async function agoDispatch(task) {
  try {
    const result = await makeRequest(
      `${AGO_URL}/api/v1/ago/dispatch`,
      'POST',
      {
        task_type:   task.type,
        payload:     task.payload,
        platform:    'CoreG-PCM',
        priority:    task.priority || 'normal',
        callback_url: task.callback_url || null
      }
    );

    if (result.status === 200 || result.status === 202) {
      console.log(JSON.stringify({
        level: 'info',
        message: 'AGO task dispatched',
        task_id: result.body?.task_id,
        type: task.type
      }));
      return result.body;
    }

    console.warn(JSON.stringify({
      level: 'warn', message: 'AGO dispatch non-200',
      status: result.status, type: task.type
    }));
    return null;
  } catch (err) {
    console.error(JSON.stringify({
      level: 'error', message: 'AGO dispatch failed', error: err.message
    }));
    return null;
  }
}

// ── HIGH-LEVEL GOVERNANCE EVENTS ──────────────────────────────────────────────

async function onPipelineAdvance(data) {
  const { asset_id, client_id, pipeline_reference,
          from_stage, to_stage, transitioned_by } = data;

  // Log to SAL
  await salLog({
    action:   `PIPELINE_ADVANCE.${to_stage.toUpperCase()}`,
    resource: `pcm:asset:${asset_id}`,
    decision: 'ALLOW',
    context: {
      client_id, pipeline_reference,
      from_stage, to_stage, transitioned_by,
      platform: 'CoreG-PCM'
    }
  });

  // Dispatch AGO task for high-value stage transitions
  const HIGH_VALUE_STAGES = ['bank_assignment','monetization','securitization','tokenization'];
  if (HIGH_VALUE_STAGES.includes(to_stage)) {
    await agoDispatch({
      type:    'GOVERNANCE_REVIEW',
      payload: { asset_id, client_id, pipeline_reference, stage: to_stage },
      priority: to_stage === 'tokenization' ? 'high' : 'normal'
    });
  }
}

async function onDocumentUpload(data) {
  const { client_id, asset_id, doc_type, file_name, uploaded_by } = data;

  await salLog({
    action:   `DOCUMENT_UPLOAD.${doc_type?.toUpperCase()}`,
    resource: `pcm:document:${client_id}`,
    decision: 'ALLOW',
    context:  { client_id, asset_id, doc_type, file_name, uploaded_by }
  });
}

async function onOFACScreening(data) {
  const { client_id, status, flags } = data;

  await salLog({
    action:   'OFAC_SCREENING',
    resource: `pcm:client:${client_id}`,
    decision: status === 'flagged' ? 'BLOCK' : 'ALLOW',
    context:  { client_id, status, flags }
  });

  if (status === 'flagged') {
    await agoDispatch({
      type:     'COMPLIANCE_ALERT',
      payload:  { client_id, status, flags },
      priority: 'high'
    });
  }
}

async function onAgentAction(data) {
  const { agent_name, agent_id, action, status, resource, context } = data;

  await salLog({
    agent_id: agent_id || agent_name,
    action:   `AGENT.${action}`,
    resource: resource || `pcm:agent:${agent_name}`,
    decision: status === 'error' ? 'ERROR' : 'ALLOW',
    context:  { agent_name, action, status, ...context }
  });
}

async function onClientCreated(data) {
  const { client_id, email, created_by } = data;

  await salLog({
    action:   'CLIENT_CREATED',
    resource: `pcm:client:${client_id}`,
    decision: 'ALLOW',
    context:  { client_id, email, created_by }
  });
}

async function onAuthEvent(data) {
  const { email, role, success, ip } = data;

  await salLog({
    action:   success ? 'AUTH_SUCCESS' : 'AUTH_FAILURE',
    resource: `pcm:auth:${email}`,
    decision: success ? 'ALLOW' : 'BLOCK',
    context:  { email, role, ip }
  });
}

module.exports = {
  salLog,
  sentinelCheck,
  agoDispatch,
  onPipelineAdvance,
  onDocumentUpload,
  onOFACScreening,
  onAgentAction,
  onClientCreated,
  onAuthEvent
};
