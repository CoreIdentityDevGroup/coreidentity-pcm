'use strict';

async function execute(context) {
  const { db } = context;

  const anomalies = [];

  // Check for assets stuck in same stage > 30 days
  const stuck = await db.clients.query(
    `SELECT a.asset_id, a.pipeline_reference, a.pipeline_stage,
            a.last_transition, c.full_name as client_name
     FROM pcm_assets a
     JOIN pcm_clients c ON c.client_id = a.client_id
     WHERE a.pipeline_stage NOT IN ('completed','rejected')
       AND a.last_transition < NOW() - INTERVAL '30 days'`
  );

  for (const asset of stuck.rows) {
    const days_stuck = Math.floor(
      (new Date() - new Date(asset.last_transition)) / (1000 * 60 * 60 * 24)
    );
    anomalies.push({
      type:               'stuck_pipeline',
      asset_id:           asset.asset_id,
      pipeline_reference: asset.pipeline_reference,
      pipeline_stage:     asset.pipeline_stage,
      client_name:        asset.client_name,
      days_stuck,
      severity:           days_stuck > 60 ? 'critical' : 'warning',
      message:            `Asset ${asset.pipeline_reference} stuck in ${asset.pipeline_stage} for ${days_stuck} days`
    });
  }

  // Check for clients with OFAC flagged status still in active pipeline
  const ofac_flagged = await db.clients.query(
    `SELECT c.client_id, c.full_name, c.ofac_status, c.pipeline_stage
     FROM pcm_clients c
     WHERE c.ofac_status = 'flagged'
       AND c.pipeline_stage NOT IN ('completed','rejected')`
  );

  for (const client of ofac_flagged.rows) {
    anomalies.push({
      type:           'ofac_active',
      client_id:      client.client_id,
      client_name:    client.full_name,
      pipeline_stage: client.pipeline_stage,
      severity:       'critical',
      message:        `OFAC-flagged client ${client.full_name} still active in pipeline at ${client.pipeline_stage}`
    });
  }

  return {
    status:           'complete',
    anomalies_found:  anomalies.length,
    critical:         anomalies.filter(a => a.severity === 'critical').length,
    warning:          anomalies.filter(a => a.severity === 'warning').length,
    anomalies,
    action:           anomalies.length > 0 ? 'ALERT_TRADE_GROUP_OWNER' : 'NO_ACTION',
    message:          `Transaction monitoring complete — ${anomalies.length} anomaly(s) found`
  };
}

module.exports = { execute };
