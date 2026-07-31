#!/usr/bin/env node
/**
 * CLOSE-GAP-02b: Wire instrument_integrity_status into the appraisal_review gate
 *
 * Must ship together with:
 *   - close-gap-02a (schema migration — adds the column this reads)
 *   - agents/instrument-integrity (the agent that writes non-'pending' values)
 * Shipping this gate alone, without the agent, hard-blocks every asset at
 * appraisal_review forever. That sequencing risk is intentional and documented
 * in the spec (section 8) — do not deploy this script without the agent.
 *
 * Idempotent: detects existing gate condition before writing; no-ops cleanly.
 *
 * Run: node scripts/close-gap-02b-wire-integrity-gate.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const TARGET = path.join(__dirname, '..', 'api', 'services', 'pipeline.js');

const OLD_BLOCK = `  appraisal_review: async (asset_id, client_id) => {
    const val = await db.assets.query(
      \`SELECT COUNT(*), MAX(date_validation_status) as val_status
       FROM pcm_valuations WHERE asset_id = $1\`, [asset_id]
    );
    const docs = await db.assets.query(
      \`SELECT COUNT(*) FROM pcm_asset_documents
       WHERE asset_id = $1 AND vault_status = 'active'\`, [asset_id]
    );
    const errors = [];
    if (parseInt(val.rows[0].count) === 0) errors.push('No valuation or appraisal submitted');
    if (val.rows[0].val_status === 'failed') errors.push('Same-date validation failed — document dates do not match');
    if (parseInt(docs.rows[0].count) === 0) errors.push('No supporting documents on file');
    return errors;
  },`;

const NEW_BLOCK = `  appraisal_review: async (asset_id, client_id) => {
    const val = await db.assets.query(
      \`SELECT COUNT(*), MAX(date_validation_status) as val_status
       FROM pcm_valuations WHERE asset_id = $1\`, [asset_id]
    );
    const docs = await db.assets.query(
      \`SELECT COUNT(*) FROM pcm_asset_documents
       WHERE asset_id = $1 AND vault_status = 'active'\`, [asset_id]
    );
    // CLOSE-GAP-02b: instrument authenticity/fraud-typology gate.
    // Blocks progression until the instrument-integrity agent has cleared
    // this asset. 'pending' (default) and 'blocked' both fail the gate —
    // only 'verified' (set exclusively via human-confirmed independent-channel
    // review, never by the agent alone) passes.
    const integrity = await db.assets.query(
      \`SELECT instrument_integrity_status FROM pcm_assets WHERE asset_id = $1\`, [asset_id]
    );
    const errors = [];
    if (parseInt(val.rows[0].count) === 0) errors.push('No valuation or appraisal submitted');
    if (val.rows[0].val_status === 'failed') errors.push('Same-date validation failed — document dates do not match');
    if (parseInt(docs.rows[0].count) === 0) errors.push('No supporting documents on file');
    const integrityStatus = integrity.rows[0]?.instrument_integrity_status;
    if (integrityStatus === 'blocked') errors.push('Instrument integrity screening BLOCKED this asset — see pcm_instrument_integrity_results');
    if (integrityStatus === 'pending' || integrityStatus === 'pending_human_verification' || !integrityStatus) {
      errors.push('Instrument integrity screening not yet cleared — independent-channel counterparty verification required');
    }
    return errors;
  },`;

function main() {
  if (!fs.existsSync(TARGET)) {
    console.error(`✗ Target file not found: ${TARGET}`);
    process.exit(1);
  }

  const contents = fs.readFileSync(TARGET, 'utf8');

  if (contents.includes('CLOSE-GAP-02b')) {
    console.log('✓ CLOSE-GAP-02b already applied — no-op.');
    return;
  }

  if (!contents.includes(OLD_BLOCK)) {
    console.error('✗ Expected appraisal_review gate block not found — file may have changed since this script was written.');
    console.error('  Refusing to apply blind edit. Manual review required.');
    process.exit(1);
  }

  const updated = contents.replace(OLD_BLOCK, NEW_BLOCK);
  fs.writeFileSync(TARGET, updated, 'utf8');
  console.log('✓ CLOSE-GAP-02b applied: appraisal_review gate now enforces instrument_integrity_status.');
}

main();
