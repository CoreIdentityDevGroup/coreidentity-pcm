/**
 * CoreIdentity PCM — Transaction Monitoring Agent
 * Vertical: Private Capital Markets
 * Trigger:  stage_6_gate
 * Stage:    monetization
 *
 * Monitors fund deployment at Stage 6. Tracks disbursement, flags anomalies, and logs transaction events to audit trail.
 *
 * AIS Identity: Required — register with AIS before deployment.
 * SAL Logging:  Full — every decision logged to audit trail.
 * Sentinel:     Enforced — policy set: pcm-default.
 */

'use strict';

import { loadManifest } from '../shared/agent-base.js';
import { salLog }       from '../shared/sal-client.js';
import { aisVerify }    from '../shared/ais-client.js';

const MANIFEST = loadManifest(import.meta.url);

/**
 * Agent entry point.
 * @param {Object} event   - Trigger event payload
 * @param {Object} context - Execution context (agent_id, trace_id, etc.)
 * @returns {Promise<Object>} Agent result
 */
export async function run(event, context) {
  await aisVerify(MANIFEST.agent_id, context);

  await salLog({
    agentId:    MANIFEST.agent_id,
    eventType:  'agent_started',
    traceId:    context.trace_id,
    payload:    { trigger: event.trigger, pipeline_reference: event.pipeline_reference }
  });

  try {
    const result = await execute(event, context);

    await salLog({
      agentId:    MANIFEST.agent_id,
      eventType:  'agent_completed',
      traceId:    context.trace_id,
      payload:    result
    });

    return { success: true, agent_id: MANIFEST.agent_id, ...result };

  } catch (err) {
    await salLog({
      agentId:   MANIFEST.agent_id,
      eventType: 'agent_failed',
      traceId:   context.trace_id,
      payload:   { error: err.message }
    });
    throw err;
  }
}

/**
 * Core agent logic — implement here.
 * @param {Object} event
 * @param {Object} context
 * @returns {Promise<Object>}
 */
async function execute(event, context) {
  // TODO: Implement Transaction Monitoring Agent logic
  // Input schema: see manifest.json inputs[]
  // Output schema: see manifest.json outputs[]
  throw new Error('Transaction Monitoring Agent: execute() not yet implemented');
}
