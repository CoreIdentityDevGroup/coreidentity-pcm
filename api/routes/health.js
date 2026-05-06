'use strict';

const express = require('express');
const db      = require('../services/db');
const router  = express.Router();

router.get('/', async (_req, res) => {
  const checks = {};
  let healthy = true;

  for (const [name, pool] of Object.entries(db)) {
    try {
      const client = await pool.connect();
      await client.query('SELECT 1');
      client.release();
      checks[name] = 'ok';
    } catch (err) {
      checks[name] = `error: ${err.message}`;
      healthy = false;
    }
  }

  res.status(healthy ? 200 : 503).json({
    status:    healthy ? 'healthy' : 'degraded',
    service:   'pcm-api',
    version:   '1.0.0',
    timestamp: new Date().toISOString(),
    databases: checks
  });
});

module.exports = router;
