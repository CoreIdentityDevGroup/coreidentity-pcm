'use strict';

const express = require('express');
const db      = require('../services/db');
const { authenticateScheduler } = require('../middleware/authenticateScheduler');
const { runMonitoringCycle }    = require('../../agent-orchestrator');

const router = express.Router();
router.use(authenticateScheduler);

let cloudwatch = null;
function getCloudWatchClient() {
  if (cloudwatch) return cloudwatch;
  const { CloudWatchClient } = require('@aws-sdk/client-cloudwatch');
  cloudwatch = new CloudWatchClient({ region: process.env.AWS_REGION || 'us-east-2' });
  return cloudwatch;
}

// Emits a real success signal for the staleness alarm to watch for. Best
// effort and non-fatal: the IAM permission for this is provisioned in a
// separate, not-yet-applied Terraform change (see aws-infrastructure
// pcm-monitoring-schedule.tf) -- until that lands, this call fails
// AccessDenied and is logged, but does not affect the HTTP response or
// the monitoring cycle's own success/failure.
async function emitSuccessMetric() {
  try {
    const { PutMetricDataCommand } = require('@aws-sdk/client-cloudwatch');
    const client = getCloudWatchClient();
    await client.send(new PutMetricDataCommand({
      Namespace: 'CoreIdentity/PCM',
      MetricData: [{
        MetricName: 'MonitoringCycleSuccess',
        Value: 1,
        Unit: 'Count',
        Dimensions: [{ Name: 'Service', Value: 'pcm-api' }],
        Timestamp: new Date()
      }]
    }));
  } catch (err) {
    console.warn(JSON.stringify({
      level: 'warn',
      message: 'Failed to emit MonitoringCycleSuccess metric — staleness alarm depends on this once provisioned',
      error: err.message
    }));
  }
}

// POST /api/v1/scheduled/monitoring
// External-scheduler target for the contract/transaction monitoring
// cycle. Replaces the Phase 3.1-rejected setInterval design (in-process
// timer state, reset on every deploy -- this session alone triggered
// enough deploys to make that "recurring" cadence unreliable even at
// desiredCount=1).
//
// Idempotency: a duplicate invocation with the same key returns the
// cached result instead of re-running the cycle. A key currently mid-run
// (status 'running', not yet 'success'/'error') returns 409 rather than
// allowing a second concurrent execution.
//
// The key is NOT required from the caller. EventBridge Scheduler targets
// have static input/headers per schedule -- there is no verified way to
// have it inject a fresh value on every firing, so requiring an
// externally-supplied key would make every firing after the first a
// permanent no-op replay of whatever ran first. Default: derive the key
// server-side as a time bucket matching the schedule's own cadence
// (PCM_MONITORING_INTERVAL_MS, default 15 min) -- retries WITHIN one
// cycle naturally dedupe against each other, and the next scheduled
// firing lands in a new bucket and actually runs. An explicit
// Idempotency-Key header is still honored if a caller supplies one (manual
// testing, or a future scheduler that does support per-firing values).
router.post('/monitoring', async (req, res, next) => {
  const intervalMs = parseInt(process.env.PCM_MONITORING_INTERVAL_MS || '900000', 10);
  const idempotencyKey = req.headers['idempotency-key']
    || `scheduled-${Math.floor(Date.now() / intervalMs)}`;

  try {
    const existing = await db.clients.query(
      `SELECT status, results FROM pcm_monitoring_runs WHERE idempotency_key = $1`,
      [idempotencyKey]
    );
    if (existing.rows.length) {
      const row = existing.rows[0];
      if (row.status === 'running') {
        return res.status(409).json({ error: 'A run with this idempotency key is already in progress' });
      }
      return res.status(200).json({ status: row.status, results: row.results, replayed: true });
    }

    await db.clients.query(
      `INSERT INTO pcm_monitoring_runs (idempotency_key, status) VALUES ($1, 'running')`,
      [idempotencyKey]
    );

    const results = await runMonitoringCycle();
    // For a `continuous`-trigger agent, silence reading as health is a
    // fail-open -- only emit the success metric when both sub-agents
    // actually completed without error, not just because the HTTP
    // request itself didn't throw.
    const allOk = Object.values(results).every(r => r.status !== 'error');
    const finalStatus = allOk ? 'success' : 'error';

    await db.clients.query(
      `UPDATE pcm_monitoring_runs SET status = $1, results = $2, completed_at = NOW() WHERE idempotency_key = $3`,
      [finalStatus, JSON.stringify(results), idempotencyKey]
    );

    if (allOk) await emitSuccessMetric();

    res.status(200).json({ status: finalStatus, results });
  } catch (err) {
    await db.clients.query(
      `UPDATE pcm_monitoring_runs SET status = 'error', results = $1, completed_at = NOW() WHERE idempotency_key = $2`,
      [JSON.stringify({ error: err.message }), idempotencyKey]
    ).catch(() => {});
    next(err);
  }
});

module.exports = router;
