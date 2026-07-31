#!/usr/bin/env node
/**
 * CLOSE-GAP-01: Remove asset-classifier value-based auto-PROCEED fallback
 *
 * Finding: any submission with no keyword match and declared_value >= $50M
 * was auto-classified as 'sblc' with action: 'PROCEED' — the exact mechanism
 * that would wave a fraudulent instrument through on size alone.
 *
 * Fix: no submission may reach PROCEED without a genuine keyword match.
 * Unmatched submissions always route to manual classification, regardless
 * of declared value.
 *
 * Idempotent: safe to run multiple times. Detects current state before
 * writing; no-ops cleanly if the fallback is already removed.
 *
 * Run: node scripts/close-gap-01-remove-classifier-fallback.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const TARGET = path.join(__dirname, '..', 'agents', 'asset-classifier', 'index.js');

const OLD_BLOCK = `  // Value-based classification hints
  const value = parseFloat(declared_value || 0);
  if (!best_match && value > 0) {
    if (value >= 50_000_000) best_match = 'sblc';
    else if (value >= 1_000_000) best_match = 'precious_metals';
    else best_match = 'real_estate';
  }

`;

const NEW_BLOCK = `  // CLOSE-GAP-01: value-based auto-classification removed.
  // Declared value alone must never route a submission to PROCEED.
  // Unmatched submissions always require manual classification.
  const value = parseFloat(declared_value || 0);

`;

function main() {
  if (!fs.existsSync(TARGET)) {
    console.error(`✗ Target file not found: ${TARGET}`);
    process.exit(1);
  }

  const contents = fs.readFileSync(TARGET, 'utf8');

  if (contents.includes('CLOSE-GAP-01')) {
    console.log('✓ CLOSE-GAP-01 already applied — no-op.');
    return;
  }

  if (!contents.includes(OLD_BLOCK)) {
    console.error('✗ Expected fallback block not found — file may have changed since this script was written.');
    console.error('  Refusing to apply blind edit. Manual review required.');
    process.exit(1);
  }

  const updated = contents.replace(OLD_BLOCK, NEW_BLOCK);

  // Also harden the terminal return: unmatched best_match must never say PROCEED
  const OLD_RETURN_ACTION = `    action:         best_match ? 'PROCEED' : 'REQUEST_MANUAL_CLASSIFICATION',`;
  const NEW_RETURN_ACTION = `    action:         best_match ? 'PROCEED' : 'REQUEST_MANUAL_CLASSIFICATION', // CLOSE-GAP-01: no value-based override`;

  const final = updated.includes(OLD_RETURN_ACTION)
    ? updated.replace(OLD_RETURN_ACTION, NEW_RETURN_ACTION)
    : updated;

  fs.writeFileSync(TARGET, final, 'utf8');
  console.log('✓ CLOSE-GAP-01 applied: asset-classifier no longer auto-PROCEEDs on declared value alone.');
}

main();
