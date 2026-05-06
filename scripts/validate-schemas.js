#!/usr/bin/env node
'use strict';

require('dotenv').config();
const { Client } = require('pg');

const DATABASES = {
  'pcm_clients': {
    host: process.env.PCM_DB_CLIENT_HOST || process.env.PCM_DB_HOST,
    database: 'pcm_clients',
    user: process.env.PCM_DB_CLIENT_USER || process.env.PCM_DB_USER,
    password: process.env.PCM_DB_CLIENT_PASSWORD || process.env.PCM_DB_PASSWORD,
    port: parseInt(process.env.PCM_DB_CLIENT_PORT || process.env.PCM_DB_PORT || '5432'),
    ssl: { rejectUnauthorized: false },
    tables: ['pcm_clients','pcm_kyc_documents','pcm_pof_records','pcm_ofac_results','pcm_client_pipeline_audit','pcm_deletion_certificates','pcm_schema_versions']
  },
  'pcm_assets': {
    host: process.env.PCM_DB_ASSET_HOST || process.env.PCM_DB_HOST,
    database: 'pcm_assets',
    user: process.env.PCM_DB_ASSET_USER || process.env.PCM_DB_USER,
    password: process.env.PCM_DB_ASSET_PASSWORD || process.env.PCM_DB_PASSWORD,
    port: parseInt(process.env.PCM_DB_ASSET_PORT || process.env.PCM_DB_PORT || '5432'),
    ssl: { rejectUnauthorized: false },
    tables: ['pcm_assets','pcm_valuations','pcm_asset_documents','pcm_pipeline_history','pcm_classification_tokens','pcm_bank_assignments','pcm_schema_versions']
  },
  'pcm_pehf': {
    host: process.env.PCM_DB_PEHF_HOST || process.env.PCM_DB_HOST,
    database: 'pcm_pehf',
    user: process.env.PCM_DB_PEHF_USER || process.env.PCM_DB_USER,
    password: process.env.PCM_DB_PEHF_PASSWORD || process.env.PCM_DB_PASSWORD,
    port: parseInt(process.env.PCM_DB_PEHF_PORT || process.env.PCM_DB_PORT || '5432'),
    ssl: { rejectUnauthorized: false },
    tables: ['pcm_funds','pcm_fund_contacts','pcm_trader_bank_relationships','pcm_deal_links','pcm_schema_versions']
  },
  'pcm_forms': {
    host: process.env.PCM_DB_FORMS_HOST || process.env.PCM_DB_HOST,
    database: 'pcm_forms',
    user: process.env.PCM_DB_FORMS_USER || process.env.PCM_DB_USER,
    password: process.env.PCM_DB_FORMS_PASSWORD || process.env.PCM_DB_PASSWORD,
    port: parseInt(process.env.PCM_DB_FORMS_PORT || process.env.PCM_DB_PORT || '5432'),
    ssl: { rejectUnauthorized: false },
    tables: ['pcm_agreements','pcm_agreement_parties','pcm_agreement_versions','pcm_contract_monitoring_log','pcm_agreement_type_reference','pcm_schema_versions']
  }
};

async function validateDatabase(dbName, config) {
  const { tables, ...connConfig } = config;
  const client = new Client(connConfig);
  const errors = [];

  try {
    await client.connect();
    console.log(`\n  ✅ Connected: ${dbName}`);

    for (const table of tables) {
      const res = await client.query(
        `SELECT COUNT(*) FROM information_schema.tables
         WHERE table_schema='public' AND table_name=$1`, [table]
      );
      if (res.rows[0].count === '0') {
        errors.push(`${dbName}: table missing — ${table}`);
        console.log(`    ✗ ${table} — MISSING`);
      } else {
        const cols = await client.query(
          `SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema='public' AND table_name=$1`, [table]
        );
        console.log(`    ✓ ${table} — ${cols.rows[0].count} columns`);
      }
    }
  } catch (err) {
    errors.push(`${dbName}: connection failed — ${err.message}`);
    console.log(`  ✗ ${dbName} — CONNECTION FAILED: ${err.message}`);
  } finally {
    await client.end();
  }

  return errors;
}

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║  CoreIdentity PCM — Schema Validation                ║');
  console.log('╚══════════════════════════════════════════════════════╝');

  const allErrors = [];

  for (const [dbName, config] of Object.entries(DATABASES)) {
    const errors = await validateDatabase(dbName, config);
    allErrors.push(...errors);
  }

  console.log('');

  if (allErrors.length > 0) {
    console.error('╔══════════════════════════════════════════════════════╗');
    console.error('║  SCHEMA VALIDATION FAILED                            ║');
    console.error('╠══════════════════════════════════════════════════════╣');
    allErrors.forEach(e => console.error(`║  ✗ ${e.substring(0,50).padEnd(50)} ║`));
    console.error('╚══════════════════════════════════════════════════════╝');
    process.exit(1);
  }

  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  SCHEMA VALIDATION PASSED — 4 databases verified     ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');
}

main();
