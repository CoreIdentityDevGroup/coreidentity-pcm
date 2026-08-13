#!/usr/bin/env node
/**
 * CLOSE-GAP-14: sentinelCheck() sends no Authorization header
 *
 * Finding (Phase 1 of the SCRUB spec, 2026-08-13): Sentinel's
 * /api/sentinel/evaluate route is mounted behind coreidentity-dashboard's
 * `authenticate` middleware (api/src/routes/sentinel.js:
 * `app.use('/api/sentinel', authenticate, sentinelRouter)` in server.js),
 * which requires `Authorization: Bearer <JWT>` verified with
 * `jwt.verify(token, process.env.JWT_SECRET, {algorithms:['HS256']})`.
 * sentinelCheck() (this file) sends no Authorization header at all -- only
 * a conditional X-API-Key that the endpoint doesn't recognize. Confirmed
 * live: an unauthenticated POST to the real endpoint returns 401 in 79ms.
 *
 * Scope requirement, read directly from source, not guessed: the /evaluate
 * route itself (coreidentity-dashboard api/src/routes/sentinel.js) has no
 * role or scope check beyond `authenticate` -- no requireAdmin, no scope
 * claim inspection. Any validly-signed token is sufficient. The signing
 * secret must match whatever Sentinel's own JWT_SECRET resolves to --
 * confirmed via its live task definition, that's ops-jwt-secret. pcm-api's
 * shared IAM role (ecsTaskExecutionRole) already has secretsmanager:
 * GetSecretValue on ops-jwt-secret (aws-infrastructure/environments/prod/
 * iam.tf, SecretsStartupRead statement) -- this is a task-definition wiring
 * gap, not an IAM gap. Deploying this requires adding a SENTINEL_JWT_SECRET
 * entry (valueFrom ops-jwt-secret) to pcm-api's task definition; that
 * happens at deploy time, not in this script (no AWS calls here).
 *
 * Fix: mint a short-lived (60s) HS256 token signed with SENTINEL_JWT_SECRET
 * for each sentinelCheck() call and attach it as a Bearer token. If the
 * secret isn't configured, fail closed immediately (same BLOCK_SENTINEL_
 * UNAVAILABLE decision already used for network failure) rather than
 * sending an unauthenticated request that will predictably 401.
 *
 * No timeout changes here -- that's CLOSE-GAP-15, kept separate so each
 * script's diff maps to exactly one reviewed step.
 *
 * No database access of any kind -- this script only edits source files and
 * runs `npm run build`.
 *
 * Idempotent: detects the existing SENTINEL_JWT_SECRET/mintSentinelToken
 * addition before writing; no-ops cleanly on re-run.
 *
 * Run: node scripts/close-gap-14-sentinel-auth.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const TARGET    = path.join(REPO_ROOT, 'api', 'services', 'governance.js');

const OLD_HEADER = `'use strict';
const notifier = require('./notifier');

const https = require('https');
const http  = require('http');

const SAL_KERNEL_URL  = process.env.SAL_KERNEL_URL  || 'http://sal-kernel.coreidentitygroup.com:8443';
const SENTINEL_URL    = process.env.SENTINEL_URL    || 'https://api.coreidentitygroup.com';
const AGO_URL         = process.env.AGO_URL         || 'https://api.coreidentitygroup.com';
const COREIDENTITY_API_KEY = process.env.COREIDENTITY_API_KEY;`;

const NEW_HEADER = `'use strict';
const notifier = require('./notifier');
const jwt      = require('jsonwebtoken');

const https = require('https');
const http  = require('http');

const SAL_KERNEL_URL  = process.env.SAL_KERNEL_URL  || 'http://sal-kernel.coreidentitygroup.com:8443';
const SENTINEL_URL    = process.env.SENTINEL_URL    || 'https://api.coreidentitygroup.com';
const AGO_URL         = process.env.AGO_URL         || 'https://api.coreidentitygroup.com';
const COREIDENTITY_API_KEY = process.env.COREIDENTITY_API_KEY;

// CLOSE-GAP-14: Sentinel's /api/sentinel/evaluate requires an authenticated
// bearer JWT (coreidentity-dashboard's shared \`authenticate\` middleware,
// HS256, verified against its own JWT_SECRET -- currently ops-jwt-secret).
// The route itself has no additional scope/role requirement beyond a valid
// signature (read directly from api/src/routes/sentinel.js -- no
// requireAdmin, no scope claim check on /evaluate). SENTINEL_JWT_SECRET
// must be provisioned as the same value Sentinel's own JWT_SECRET resolves
// to, or every call will 401.
const SENTINEL_JWT_SECRET = process.env.SENTINEL_JWT_SECRET;

function mintSentinelToken() {
  if (!SENTINEL_JWT_SECRET) {
    throw new Error('SENTINEL_JWT_SECRET not configured');
  }
  return jwt.sign(
    { sub: 'pcm-api', role: 'service', aud: 'sentinel', iss: 'coreg-pcm' },
    SENTINEL_JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '60s' }
  );
}`;

const OLD_CHECK = `// ── SENTINEL ENFORCEMENT ──────────────────────────────────────────────────────
async function sentinelCheck(action, resource, context = {}) {
  try {
    const result = await makeRequest(
      \`\${SENTINEL_URL}/api/sentinel/evaluate\`,
      'POST',
      { action, resource, context, platform: 'CoreG-PCM' }
    );`;

const NEW_CHECK = `// ── SENTINEL ENFORCEMENT ──────────────────────────────────────────────────────
async function sentinelCheck(action, resource, context = {}) {
  let authHeaders;
  try {
    authHeaders = { Authorization: \`Bearer \${mintSentinelToken()}\` };
  } catch (err) {
    console.error(JSON.stringify({
      level: 'error',
      message: 'Sentinel token mint failed — FAIL CLOSE — action blocked',
      action, resource, error: err.message,
      timestamp: new Date().toISOString()
    }));
    return { allowed: false, decision: 'BLOCK_SENTINEL_UNAVAILABLE', reason: \`Cannot authenticate to Sentinel: \${err.message}\` };
  }

  try {
    const result = await makeRequest(
      \`\${SENTINEL_URL}/api/sentinel/evaluate\`,
      'POST',
      { action, resource, context, platform: 'CoreG-PCM' },
      authHeaders
    );`;

function main() {
  if (!fs.existsSync(TARGET)) {
    console.error(`✗ Target file not found: ${TARGET}`);
    process.exit(1);
  }

  let contents = fs.readFileSync(TARGET, 'utf8');

  if (contents.includes('CLOSE-GAP-14')) {
    console.log('✓ CLOSE-GAP-14 already applied — no-op.');
    return;
  }

  if (!contents.includes(OLD_HEADER)) {
    console.error('✗ Expected file header not found — file may have changed since this script was written.');
    console.error('  Refusing to apply blind edit. Manual review required.');
    process.exit(1);
  }
  if (!contents.includes(OLD_CHECK)) {
    console.error('✗ Expected sentinelCheck() opening not found — file may have changed since this script was written.');
    console.error('  Refusing to apply blind edit. Manual review required.');
    process.exit(1);
  }

  contents = contents.replace(OLD_HEADER, NEW_HEADER);
  contents = contents.replace(OLD_CHECK, NEW_CHECK);

  fs.writeFileSync(TARGET, contents, 'utf8');
  console.log('✓ CLOSE-GAP-14 applied: sentinelCheck() now mints and sends a Bearer token.');
  console.log('  Fails closed (BLOCK_SENTINEL_UNAVAILABLE) if SENTINEL_JWT_SECRET is unset.');
  console.log('  Deploy-time requirement (not done by this script): wire SENTINEL_JWT_SECRET');
  console.log("  into pcm-api's task definition as valueFrom ops-jwt-secret.");

  console.log('\nRunning npm run build...');
  execSync('npm run build', { cwd: REPO_ROOT, stdio: 'inherit' });
}

main();
