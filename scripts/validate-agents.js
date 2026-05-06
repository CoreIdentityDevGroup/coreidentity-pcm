#!/usr/bin/env node
/**
 * CoreIdentity PCM — Agent Validator
 * Validates all 11 PCM agent scaffolds are present and correctly structured.
 * Called by: npm run build
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const AGENTS_DIR = path.join(__dirname, '..', 'agents');

const REQUIRED_AGENTS = [
  'intake-parser',
  'asset-classifier',
  'document-date-validator',
  'pof-verifier',
  'ofac-screening',
  'valuation-parser',
  'bank-routing',
  'token-minting',
  'deletion-certification',
  'contract-monitoring',
  'transaction-monitoring',
];

const REQUIRED_FILES = ['index.js', 'manifest.json'];

async function validateAgents() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  CoreIdentity PCM — Agent Validation                 ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');

  const errors = [];

  if (!fs.existsSync(AGENTS_DIR)) {
    console.error(`✗ Agents directory missing: ${AGENTS_DIR}`);
    process.exit(1);
  }

  for (const agent of REQUIRED_AGENTS) {
    const agentDir = path.join(AGENTS_DIR, agent);

    if (!fs.existsSync(agentDir)) {
      errors.push(`Agent directory missing: agents/${agent}`);
      console.log(`  ✗ ${agent} — DIRECTORY MISSING`);
      continue;
    }

    const missingFiles = REQUIRED_FILES.filter(
      f => !fs.existsSync(path.join(agentDir, f))
    );

    if (missingFiles.length > 0) {
      errors.push(`${agent}: missing files [${missingFiles.join(', ')}]`);
      console.log(`  ✗ ${agent} — MISSING: ${missingFiles.join(', ')}`);
      continue;
    }

    // Validate manifest structure
    try {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(agentDir, 'manifest.json'), 'utf8')
      );
      const requiredManifestFields = [
        'agent_id', 'name', 'vertical', 'trigger', 'ais_required',
        'sal_logging', 'version', 'description'
      ];
      const missingManifestFields = requiredManifestFields.filter(
        f => manifest[f] === undefined
      );
      if (missingManifestFields.length > 0) {
        errors.push(`${agent}/manifest.json: missing fields [${missingManifestFields.join(', ')}]`);
        console.log(`  ✗ ${agent} — MANIFEST INCOMPLETE: ${missingManifestFields.join(', ')}`);
      } else {
        console.log(`  ✓ ${agent} — v${manifest.version} [AIS: ${manifest.ais_required ? 'required' : 'optional'}, SAL: ${manifest.sal_logging}]`);
      }
    } catch (e) {
      errors.push(`${agent}/manifest.json: parse error — ${e.message}`);
      console.log(`  ✗ ${agent} — MANIFEST PARSE ERROR`);
    }
  }

  console.log('');

  if (errors.length > 0) {
    console.error('╔══════════════════════════════════════════════════════╗');
    console.error('║  AGENT VALIDATION FAILED                             ║');
    console.error('╠══════════════════════════════════════════════════════╣');
    errors.forEach(e => console.error(`║  ✗ ${e.substring(0, 50).padEnd(50)} ║`));
    console.error('╚══════════════════════════════════════════════════════╝');
    process.exit(1);
  }

  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  AGENT VALIDATION PASSED                             ║');
  console.log(`║  ${REQUIRED_AGENTS.length} agents verified — all manifests valid`.padEnd(54) + '║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');
}

validateAgents();
