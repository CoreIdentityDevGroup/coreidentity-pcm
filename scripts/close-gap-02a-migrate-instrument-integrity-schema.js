#!/usr/bin/env node
/**
 * CLOSE-GAP-02a: Migration — instrument integrity schema
 *
 * Adds:
 *   - pcm_assets.instrument_integrity_status (default 'pending')
 *   - pcm_instrument_integrity_results table (audit trail per screening run)
 *
 * Idempotent: uses IF NOT EXISTS throughout. Safe to run repeatedly.
 * Uses the same pg Pool pattern as api/services/db.js — reads the same
 * PCM_DB_ASSET_* environment variables, no new connection config invented.
 *
 * Run: node scripts/close-gap-02a-migrate-instrument-integrity-schema.js
 */

'use strict';

const { Pool } = require('pg');

const sslConfig = process.env.NODE_ENV === 'production'
  ? { rejectUnauthorized: false }
  : false;

const pool = new Pool({
  host:     process.env.PCM_DB_ASSET_HOST,
  database: process.env.PCM_DB_ASSET_NAME,
  user:     process.env.PCM_DB_ASSET_USER,
  password: process.env.PCM_DB_ASSET_PASSWORD,
  port:     parseInt(process.env.PCM_DB_ASSET_PORT || '5432'),
  ssl:      sslConfig
});

const STATEMENTS = [
  {
    label: 'pcm_assets.instrument_integrity_status column',
    sql: `ALTER TABLE pcm_assets
          ADD COLUMN IF NOT EXISTS instrument_integrity_status VARCHAR(40) NOT NULL DEFAULT 'pending'`
  },
  {
    label: 'pcm_instrument_integrity_results table',
    sql: `CREATE TABLE IF NOT EXISTS pcm_instrument_integrity_results (
            id                    SERIAL PRIMARY KEY,
            asset_id              UUID NOT NULL,
            client_id             UUID,
            status                VARCHAR(40) NOT NULL,
            fraud_risk_score      INTEGER NOT NULL,
            typology_version      VARCHAR(20),
            matched_pattern_ids   JSONB,
            structural_failures   JSONB,
            screened_by_agent     VARCHAR(80),
            reviewed_by           VARCHAR(120),
            reviewed_at           TIMESTAMPTZ,
            verification_channel_note TEXT,
            created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )`
  },
  {
    label: 'index on pcm_instrument_integrity_results.asset_id',
    sql: `CREATE INDEX IF NOT EXISTS idx_pcm_instrument_integrity_asset_id
          ON pcm_instrument_integrity_results (asset_id)`
  }
];

async function main() {
  console.log('CLOSE-GAP-02a: instrument integrity schema migration');
  try {
    for (const stmt of STATEMENTS) {
      await pool.query(stmt.sql);
      console.log(`  ✓ ${stmt.label}`);
    }
    console.log('✓ Migration complete (idempotent — safe to re-run).');
  } catch (err) {
    console.error(`✗ Migration failed: ${err.message}`);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
