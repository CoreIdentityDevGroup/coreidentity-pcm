'use strict';

const { Pool } = require('pg');

const sslConfig = process.env.NODE_ENV === 'production'
  ? { rejectUnauthorized: false }
  : false;

const poolConfig = (host, database, user, password, port) => ({
  host, database, user, password,
  port: parseInt(port || '5432'),
  ssl: sslConfig,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

const pools = {
  clients: new Pool(poolConfig(
    process.env.PCM_DB_CLIENT_HOST,
    process.env.PCM_DB_CLIENT_NAME,
    process.env.PCM_DB_CLIENT_USER,
    process.env.PCM_DB_CLIENT_PASSWORD,
    process.env.PCM_DB_CLIENT_PORT
  )),
  assets: new Pool(poolConfig(
    process.env.PCM_DB_ASSET_HOST,
    process.env.PCM_DB_ASSET_NAME,
    process.env.PCM_DB_ASSET_USER,
    process.env.PCM_DB_ASSET_PASSWORD,
    process.env.PCM_DB_ASSET_PORT
  )),
  pehf: new Pool(poolConfig(
    process.env.PCM_DB_PEHF_HOST,
    process.env.PCM_DB_PEHF_NAME,
    process.env.PCM_DB_PEHF_USER,
    process.env.PCM_DB_PEHF_PASSWORD,
    process.env.PCM_DB_PEHF_PORT
  )),
  forms: new Pool(poolConfig(
    process.env.PCM_DB_FORMS_HOST,
    process.env.PCM_DB_FORMS_NAME,
    process.env.PCM_DB_FORMS_USER,
    process.env.PCM_DB_FORMS_PASSWORD,
    process.env.PCM_DB_FORMS_PORT
  ))
};

module.exports = pools;
