#!/usr/bin/env node
/**
 * SEED: founder/owner staff account for pcm_staff.
 *
 * Fixes a gap in the "invisible to repo" pattern (see coreidentity-infrastructure
 * REBUILD.md, "Config Drift Invisible to Terraform"): the founder's pcm_staff
 * login row previously existed only as a hand-run INSERT with no trace in any
 * repo, so it came back empty when pcm_clients was restored from a schema-only
 * dump after the 2026-08-11 rebuild. This script is the reproducible substitute.
 *
 * Role: trade_group_owner — the highest tier in api/middleware/authorize.js's
 * ROLE_HIERARCHY (3, vs program_manager=2, intake_officer=1/system=0) and the
 * only role listed on every authorize() call in the API, including the
 * endpoints scoped to it alone (client deletion, pipeline rejection,
 * reference-data and rules management).
 *
 * Idempotent: ON CONFLICT (email) DO NOTHING — re-running this script never
 * overwrites a password that's since been changed through the app.
 *
 * Uses the same pg Pool / PCM_DB_CLIENT_* env vars as api/services/db.js
 * (pools.clients) — no new connection config invented.
 *
 * Required env vars:
 *   PCM_DB_CLIENT_HOST, PCM_DB_CLIENT_NAME, PCM_DB_CLIENT_USER,
 *   PCM_DB_CLIENT_PASSWORD, PCM_DB_CLIENT_PORT
 *   FOUNDER_EMAIL, FOUNDER_NAME, FOUNDER_PASSWORD
 *
 * Run: node scripts/seed-founder-staff.js
 */

'use strict';

const { Pool } = require('pg');

const sslConfig = process.env.NODE_ENV === 'production'
  ? { rejectUnauthorized: false }
  : false;

const pool = new Pool({
  host:     process.env.PCM_DB_CLIENT_HOST,
  database: process.env.PCM_DB_CLIENT_NAME,
  user:     process.env.PCM_DB_CLIENT_USER,
  password: process.env.PCM_DB_CLIENT_PASSWORD,
  port:     parseInt(process.env.PCM_DB_CLIENT_PORT || '5432'),
  ssl:      sslConfig
});

const ROLE = 'trade_group_owner';

async function main() {
  const email = process.env.FOUNDER_EMAIL;
  const name = process.env.FOUNDER_NAME;
  const password = process.env.FOUNDER_PASSWORD;

  if (!email || !name || !password) {
    console.error('✗ FOUNDER_EMAIL, FOUNDER_NAME, and FOUNDER_PASSWORD must all be set.');
    process.exit(1);
  }

  console.log('SEED: founder staff account');
  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');

    const result = await pool.query(
      `INSERT INTO pcm_staff (email, name, role, password_hash, active)
       VALUES ($1, $2, $3, crypt($4, gen_salt('bf', 12)), true)
       ON CONFLICT (email) DO NOTHING
       RETURNING staff_id`,
      [email, name, ROLE, password]
    );

    if (result.rows.length) {
      console.log(`  ✓ Created ${email} as ${ROLE} (staff_id ${result.rows[0].staff_id})`);
    } else {
      console.log(`  = ${email} already exists — left untouched (idempotent, not overwriting an existing password).`);
    }
    console.log('✓ Seed complete (idempotent — safe to re-run).');
  } catch (err) {
    console.error(`✗ Seed failed: ${err.message}`);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
