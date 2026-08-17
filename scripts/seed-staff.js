#!/usr/bin/env node
/**
 * SEED: pcm_staff account (email, name, role, password).
 *
 * General-purpose successor to the original founder-only seed script (see
 * git history — this file was seed-founder-staff.js). Same rationale: fixes
 * the "invisible to repo" gap where staff login rows previously existed
 * only as hand-run INSERTs with no trace anywhere (see
 * coreidentity-infrastructure REBUILD.md, "Config Drift Invisible to
 * Terraform"). Any new staff account — founder or otherwise — should be
 * created by running this script, not a manual INSERT.
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
 *   STAFF_EMAIL, STAFF_NAME, STAFF_ROLE, STAFF_PASSWORD
 *
 * STAFF_ROLE must be one of the values pcm_staff_role_check allows:
 *   administrator, program_manager, intake_officer
 *
 * Run: node scripts/seed-staff.js
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

// Mirrors the pcm_staff_role_check constraint in the schema.
const ALLOWED_ROLES = ['administrator', 'program_manager', 'intake_officer'];

async function main() {
  const email = process.env.STAFF_EMAIL;
  const name = process.env.STAFF_NAME;
  const role = process.env.STAFF_ROLE;
  const password = process.env.STAFF_PASSWORD;

  if (!email || !name || !role || !password) {
    console.error('✗ STAFF_EMAIL, STAFF_NAME, STAFF_ROLE, and STAFF_PASSWORD must all be set.');
    process.exit(1);
  }

  if (!ALLOWED_ROLES.includes(role)) {
    console.error(`✗ STAFF_ROLE must be one of: ${ALLOWED_ROLES.join(', ')} (got "${role}")`);
    process.exit(1);
  }

  console.log(`SEED: staff account (${role})`);
  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');

    const result = await pool.query(
      `INSERT INTO pcm_staff (email, name, role, password_hash, active)
       VALUES ($1, $2, $3, crypt($4, gen_salt('bf', 12)), true)
       ON CONFLICT (email) DO NOTHING
       RETURNING staff_id`,
      [email, name, role, password]
    );

    if (result.rows.length) {
      console.log(`  ✓ Created ${email} as ${role} (staff_id ${result.rows[0].staff_id})`);
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
