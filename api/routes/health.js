'use strict';
const express = require('express');
const db      = require('../services/db');
const router  = express.Router();

router.get('/', async (_req, res) => {
  const checks = {};

  const results = await Promise.allSettled(
    Object.entries(db).map(async ([name, pool]) => {
      const client = await pool.connect();
      await client.query('SELECT 1');
      client.release();
      return name;
    })
  );

  let i = 0;
  for (const [name] of Object.entries(db)) {
    checks[name] = results[i].status === 'fulfilled' ? 'ok' : 'error';
    i++;
  }

  res.status(200).json({
    status:    'healthy',
    service:   'pcm-api',
    version:   '1.0.0',
    timestamp: new Date().toISOString(),
    databases: checks
  });
});


// GET /api/v1/health — lightweight liveness probe (no auth, no DB dependency)
function coregHealth(_req, res) {
  res.status(200).json({
    status:    'ok',
    service:   'coreg-pcm-api',
    timestamp: new Date().toISOString(),
    uptime:    process.uptime()
  });
}
router.coregHealth = coregHealth;

module.exports = router;
