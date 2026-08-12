#!/usr/bin/env node
/**
 * SEED: static reference/lookup data for the PCM app — asset types, banks,
 * asset backings, securities instruments, pipeline stage definitions,
 * rules content, and agreement type reference.
 *
 * These are config tables the app depends on to function (populate UI
 * dropdowns, gate the client rules-acknowledgment flow, define pipeline
 * stages) — not tenant/transactional data. They came back empty after the
 * 2026-08-11 rebuild restored pcm_clients/pcm_forms from a schema-only
 * dump (see coreidentity-infrastructure REBUILD.md). Source of truth for
 * the values below: the July final snapshot
 * (final-coreidentity-pcm-20260704t135926z), extracted via a temporary RDS
 * restore on 2026-08-12 and hardcoded here so no future rebuild needs to
 * touch a snapshot again.
 *
 * pcm_funds (pcm_pehf) was checked and deliberately excluded: it was
 * already empty in the July snapshot, so there is no catalog to restore —
 * its emptiness is not a rebuild gap.
 *
 * NOTE on pcm_rules_content: the `content` values below are placeholder
 * text ("Replace with finalized copy") inherited as-is from the July
 * snapshot — never finalized before the snapshot was taken, not something
 * lost or broken by this script. Loaded anyway so the client
 * rules-acknowledgment gate is functional rather than broken, and so the
 * placeholder status stays visible instead of silently missing. Whoever
 * picks this up next: replace with real copy via the app's content path
 * (or a follow-up UPDATE) — this script will never touch it once a row
 * exists, by design.
 *
 * Idempotent: every insert is ON CONFLICT (<natural key>) DO NOTHING, so
 * re-running never overwrites a row that's since been edited (e.g. once
 * real rules_content copy is written).
 *
 * Required env vars:
 *   PCM_DB_CLIENT_HOST, PCM_DB_CLIENT_NAME, PCM_DB_CLIENT_USER, PCM_DB_CLIENT_PASSWORD, PCM_DB_CLIENT_PORT
 *   PCM_DB_FORMS_HOST,  PCM_DB_FORMS_NAME,  PCM_DB_FORMS_USER,  PCM_DB_FORMS_PASSWORD,  PCM_DB_FORMS_PORT
 *
 * Run: node scripts/seed-reference-data.js
 */

'use strict';

const { Pool } = require('pg');

const sslConfig = process.env.NODE_ENV === 'production'
  ? { rejectUnauthorized: false }
  : false;

const poolConfig = (host, database, user, password, port) => ({
  host, database, user, password,
  port: parseInt(port || '5432'),
  ssl: sslConfig
});

const clientsPool = new Pool(poolConfig(
  process.env.PCM_DB_CLIENT_HOST,
  process.env.PCM_DB_CLIENT_NAME,
  process.env.PCM_DB_CLIENT_USER,
  process.env.PCM_DB_CLIENT_PASSWORD,
  process.env.PCM_DB_CLIENT_PORT
));

const formsPool = new Pool(poolConfig(
  process.env.PCM_DB_FORMS_HOST,
  process.env.PCM_DB_FORMS_NAME,
  process.env.PCM_DB_FORMS_USER,
  process.env.PCM_DB_FORMS_PASSWORD,
  process.env.PCM_DB_FORMS_PORT
));

const SEED_GROUPS = [
  {
    pool: clientsPool,
    table: 'pcm_asset_backings',
    conflictColumn: 'name',
    columns: ['name', 'active', 'sort_order'],
    rows: [
      ['Valuation', true, 1],
      ['Appraisal', true, 2],
      ['SKR', true, 3],
      ['Bond Type', true, 4]
    ]
  },
  {
    pool: clientsPool,
    table: 'pcm_asset_types',
    conflictColumn: 'name',
    columns: ['name', 'requires_description', 'active', 'sort_order'],
    rows: [
      ['Art', false, true, 1],
      ['Gold', false, true, 2],
      ['Jewelry', false, true, 3],
      ['Real Estate', false, true, 4],
      ['Historical Asset', false, true, 5],
      ['Other', true, true, 6]
    ]
  },
  {
    pool: clientsPool,
    table: 'pcm_banks',
    conflictColumn: 'name',
    columns: ['name', 'active', 'sort_order'],
    rows: [
      ['Deutsche Bank', true, 1],
      ['HSBC', true, 2],
      ['Barclays', true, 3],
      ['UBS', true, 4],
      ['UOB', true, 5],
      ['DBS', true, 6],
      ['Chase', true, 7],
      ['JP Morgan', true, 8],
      ['Goldman Sachs', true, 9],
      ['WestPac', true, 10],
      ['Other', true, 99]
    ]
  },
  {
    pool: clientsPool,
    table: 'pcm_securities_instruments',
    conflictColumn: 'name',
    columns: ['name', 'requires_description', 'active', 'sort_order'],
    rows: [
      ['MTN', false, true, 1],
      ['SBLC', false, true, 2],
      ['144A', false, true, 3],
      ['Other', true, true, 4]
    ]
  },
  {
    pool: clientsPool,
    table: 'pcm_pipeline_stage_definitions',
    conflictColumn: 'stage_number',
    columns: ['stage_number', 'name', 'description', 'active'],
    rows: [
      [1, 'Intake', null, true],
      [2, 'KYC', null, true],
      [3, 'Asset/Collateral', null, true],
      [4, 'Appraisal/Valuation', null, true],
      [5, 'Monetization', null, true],
      [6, 'Securitization', null, true],
      [7, 'Tokenization', null, true],
      [8, 'Completed', null, true]
    ]
  },
  {
    pool: clientsPool,
    table: 'pcm_rules_content',
    conflictColumn: 'rule_type',
    columns: ['rule_type', 'title', 'content', 'version', 'active'],
    // PLACEHOLDER CONTENT — see file header. Not finalized legal/compliance copy.
    rows: [
      ['kyc_instructions', 'KYC Instructions', 'Placeholder content for KYC instructions. Replace with finalized copy.', 1, true],
      ['pof_instructions', 'Proof of Funds Instructions', 'Placeholder content for Proof of Funds (POF) instructions. Replace with finalized copy.', 1, true],
      ['rules_of_the_road', 'Rules of the Road', 'Placeholder content for Rules of the Road. Replace with finalized copy.', 1, true]
    ]
  },
  {
    pool: formsPool,
    table: 'pcm_agreement_type_reference',
    conflictColumn: 'agreement_type',
    columns: ['agreement_type', 'display_name', 'abbreviation', 'jurisdiction_type', 'pipeline_stage_required', 'pipeline_gate'],
    rows: [
      ['payment_guarantee_letter', 'Payment Guarantee Letter', 'PGL', 'both', 'collateralization', true],
      ['master_fee_agreement', 'Master Fee Agreement', 'MFA', 'both', 'kyc_verification', true],
      ['irrevocable_master_fee_protection_agreement', 'Irrevocable Master Fee Protection Agreement', 'IMFPA', 'international', 'kyc_verification', true],
      ['joint_venture_agreement', 'Joint Venture Agreement', 'JVA', 'both', 'collateralization', false],
      ['icc_agreement', 'ICC Agreement', 'ICC', 'international', 'securitization', true],
      ['joint_venture_partnership_agreement', 'Joint Venture Partnership Agreement', 'JVPA', 'both', 'collateralization', false]
    ]
  }
];

async function seedGroup(group) {
  const placeholders = group.columns.map((_, i) => `$${i + 1}`).join(', ');
  const sql = `INSERT INTO ${group.table} (${group.columns.join(', ')})
               VALUES (${placeholders})
               ON CONFLICT (${group.conflictColumn}) DO NOTHING`;

  let created = 0, skipped = 0;
  for (const row of group.rows) {
    const result = await group.pool.query(sql, row);
    if (result.rowCount) created++; else skipped++;
  }
  console.log(`  ${group.table}: ${created} created, ${skipped} already existed`);
}

async function main() {
  console.log('SEED: reference/lookup data');
  try {
    for (const group of SEED_GROUPS) {
      await seedGroup(group);
    }
    console.log('✓ Seed complete (idempotent — safe to re-run).');
  } catch (err) {
    console.error(`✗ Seed failed: ${err.message}`);
    process.exit(1);
  } finally {
    await clientsPool.end();
    await formsPool.end();
  }
}

main();
