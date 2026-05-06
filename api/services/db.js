'use strict';

const { Pool } = require('pg');

const sslConfig = process.env.NODE_ENV === 'production'
  ? { rejectUnauthorized: false }
  : false;

const pools = {
  clients: new Pool({
    host:     process.env.PCM_DB_CLIENT_HOST,
    database: process.env.PCM_DB_CLIENT_NAME,
    user:     process.env.PCM_DB_CLIENT_USER,
    password: process.env.PCM_DB_CLIENT_PASSWORD,
    port:     parseInt(process.env.PCM_DB_CLIENT_PORT || '5432'),
    ssl:      sslConfig,
    max:      10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
  }),
  assets: new Pool({
    host:     process.env.PCM_DB_ASSET_HOST,
    database: process.env.PCM_DB_ASSET_NAME,
    user:     process.env.PCM_DB_ASSET_USER,
    password: process.env.PCM_DB_ASSET_PASSWORD,
    port:     parseInt(process.env.PCM_DB_ASSET_PORT || '5432'),
    ssl:      sslConfig,
    max:      10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
  }),
  pehf: new Pool({
    host:     process.env.PCM_DB_PEHF_HOST,
    database: process.env.PCM_DB_PEHF_NAME,
    user:     process.env.PCM_DB_PEHF_USER,
    password: process.env.PCM_DB_PEHF_PASSWORD,
    port:     parseInt(process.env.PCM_DB_PEHF_PORT || '5432'),
    ssl:      sslConfig,
    max:      10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
  }),
  forms: new Pool({
    host:     process.env.PCM_DB_FORMS_HOST,
    database: process.env.PCM_DB_FORMS_NAME,
    user:     process.env.PCM_DB_FORMS_USER,
    password: process.env.PCM_DB_FORMS_PASSWORD,
    port:     parseInt(process.env.PCM_DB_FORMS_PORT || '5432'),
    ssl:      sslConfig,
    max:      10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
  })
};

// Verify all pools on startup
async function verifyConnections() {
  for (const [name, pool] of Object.entries(pools)) {
    try {
      const client = await pool.connect();
      await client.query('SELECT 1');
      client.release();
      console.log(JSON.stringify({ level: 'info', message: `DB connected: ${name}`, timestamp: new Date().toISOString() }));
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', message: `DB connection failed: ${name}`, error: err.message, timestamp: new Date().toISOString() }));
    }
  }
}

verifyConnections();

module.exports = pools;
