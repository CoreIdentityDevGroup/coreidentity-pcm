'use strict';

// Phase 3.6: separate auth path for machine callers (an external scheduler
// hitting the monitoring endpoint on a timer), distinct from the JWT-based
// `authenticate` used everywhere else. Not layered onto the existing
// /api/v1/agents router (which is globally gated by JWT authenticate
// before its own routes run) -- a new route is mounted outside that
// prefix instead, so this is the only auth check it goes through.
//
// Fails closed: if PCM_MONITORING_SCHEDULER_KEY isn't configured, no key
// can ever match (undefined !== anything the caller sends), so the
// endpoint is unreachable until the secret is actually provisioned,
// rather than silently open.
function authenticateScheduler(req, res, next) {
  const configured = process.env.PCM_MONITORING_SCHEDULER_KEY;
  const provided    = req.headers['x-scheduler-api-key'];
  if (!configured || !provided || provided !== configured) {
    return res.status(401).json({ error: 'Missing or invalid X-Scheduler-Api-Key' });
  }
  req.schedulerAuthenticated = true;
  next();
}

module.exports = { authenticateScheduler };
