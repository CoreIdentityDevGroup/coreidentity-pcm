'use strict';

// Phase 3.6: separate auth path for machine callers (an external scheduler
// hitting a route on a timer), distinct from the JWT-based `authenticate`
// used everywhere else. Not layered onto the existing /api/v1/agents
// router (which is globally gated by JWT authenticate before its own
// routes run) -- a new route is mounted outside that prefix instead, so
// this is the only auth check it goes through.
//
// SDN screening design: originally a single shared key
// (PCM_MONITORING_SCHEDULER_KEY) applied to every route under
// /api/v1/scheduled via router.use(). That meant provisioning a key for
// ANY one scheduled route made every other route under that router
// callable too -- an accidental shared blast radius, not a deliberate
// design choice (discovered when wiring the SDN ingest schedule; see
// docs/SDN-Sanctions-Screening-Design.md). Now a factory: each route gets
// its own dedicated env var, applied per-route in scheduled.js, so
// provisioning one route's key has zero effect on any other route's
// reachability.
//
// Fails closed per key: if the named env var isn't configured, no key can
// ever match (undefined !== anything the caller sends), so a route stays
// unreachable until its own secret is actually provisioned, rather than
// silently open or riding on a different route's key.
function authenticateScheduler(envVarName) {
  return function (req, res, next) {
    const configured = process.env[envVarName];
    const provided    = req.headers['x-scheduler-api-key'];
    if (!configured || !provided || provided !== configured) {
      return res.status(401).json({ error: 'Missing or invalid X-Scheduler-Api-Key' });
    }
    req.schedulerAuthenticated = true;
    next();
  };
}

module.exports = { authenticateScheduler };
