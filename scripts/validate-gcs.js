#!/usr/bin/env node
/**
 * CoreIdentity PCM — GCS Bucket Validator
 * Validates all required GCS buckets exist with correct configuration.
 * Called by: npm run build
 */

'use strict';

require('dotenv').config();
const { Storage } = require('@google-cloud/storage');

const REQUIRED_BUCKETS = [
  {
    name: () => `${process.env.GCP_PROJECT_ID}-pcm-kyc-vault`,
    purpose: 'KYC/CIS documents — lifecycle managed',
    lifecycle: true,
    versioning: true,
  },
  {
    name: () => `${process.env.GCP_PROJECT_ID}-pcm-forms-agreements`,
    purpose: 'Forms and agreements — permanent retention',
    lifecycle: false,
    versioning: true,
  },
  {
    name: () => `${process.env.GCP_PROJECT_ID}-pcm-deletion-certs`,
    purpose: 'Deletion certificates — permanent, immutable',
    lifecycle: false,
    versioning: false,
  },
  {
    name: () => `${process.env.GCP_PROJECT_ID}-pcm-asset-docs`,
    purpose: 'Asset supporting documents — lifecycle managed',
    lifecycle: true,
    versioning: true,
  },
];

async function validateGCS() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  CoreIdentity PCM — GCS Bucket Validation            ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');

  if (!process.env.GCP_PROJECT_ID) {
    console.warn('  ⚠  GCP_PROJECT_ID not set — skipping GCS validation');
    console.log('');
    return;
  }

  const storage = new Storage({ projectId: process.env.GCP_PROJECT_ID });
  const errors = [];

  for (const bucketDef of REQUIRED_BUCKETS) {
    const bucketName = bucketDef.name();
    try {
      const [exists] = await storage.bucket(bucketName).exists();
      if (!exists) {
        errors.push(`Bucket missing: ${bucketName}`);
        console.log(`  ✗ ${bucketName} — MISSING`);
      } else {
        console.log(`  ✓ ${bucketName} — ${bucketDef.purpose}`);
      }
    } catch (err) {
      errors.push(`${bucketName}: ${err.message}`);
      console.log(`  ✗ ${bucketName} — ERROR: ${err.message}`);
    }
  }

  console.log('');

  if (errors.length > 0) {
    console.error('╔══════════════════════════════════════════════════════╗');
    console.error('║  GCS VALIDATION FAILED                               ║');
    errors.forEach(e => console.error(`║  ✗ ${e.substring(0, 50).padEnd(50)} ║`));
    console.error('╚══════════════════════════════════════════════════════╝');
    process.exit(1);
  }

  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  GCS VALIDATION PASSED                               ║');
  console.log(`║  ${REQUIRED_BUCKETS.length} buckets verified`.padEnd(54) + '║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');
}

validateGCS();
