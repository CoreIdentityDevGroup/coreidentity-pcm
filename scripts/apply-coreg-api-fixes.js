#!/usr/bin/env node
/**
 * apply-coreg-api-fixes.js — idempotent transforms for CoreG PCM API
 *
 * FIX 2  GET /api/v1/health   (no auth) -> {status,service,timestamp,uptime}
 *        - adds coregHealth handler to api/routes/health.js
 *        - registers app.get('/api/v1/health', ...) in api/app.js
 *
 * FIX 3  GET /api/v1/pipeline (auth)    -> pipeline summary from
 *        pcm_client_pipeline_audit (count by status + recent entries)
 *        - adds router.get('/') to api/routes/pipeline.js
 *          (already mounted at /api/v1/pipeline with authenticate in app.js)
 *
 * FIX 4  agents/shared/ais-client.js — wire the real AIS call to
 *        process.env.AIS_API_URL (https://api.agentidentity.systems)
 *
 * Safe to run repeatedly — each step is guarded. Ends with `npm run build`.
 */
'use strict';
const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const read  = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const write = (rel, c) => { fs.writeFileSync(path.join(REPO, rel), c, 'utf8'); console.log(`  ✓ wrote ${rel}`); };

// ─── FIX 2: health.js — coregHealth handler ──────────────────────────────────
console.log('\n── Fix 2: api/routes/health.js (/api/v1/health handler) ──────────────');
let health = read('api/routes/health.js');
if (!health.includes('function coregHealth')) {
  const handler = `
// GET /api/v1/health — lightweight liveness probe (no auth, no DB dependency)
function coregHealth(_req, res) {
  res.status(200).json({
    status:    'ok',
    service:   'coreg-pcm-api',
    timestamp: new Date().toISOString(),
    uptime:    process.uptime()
  });
}
router.coregHealth = coregHealth;
`;
  health = health.replace(
    'module.exports = router;',
    `${handler}\nmodule.exports = router;`
  );
  write('api/routes/health.js', health);
} else {
  console.log('  • coregHealth already present');
}

// ─── FIX 2 (cont): register in app.js ────────────────────────────────────────
console.log('\n── Fix 2: register /api/v1/health in api/app.js ──────────────────────');
let app = read('api/app.js');
if (!app.includes("app.get('/api/v1/health'")) {
  // place it next to the existing /health mount
  app = app.replace(
    "app.use('/health',    healthRouter);",
    "app.use('/health',    healthRouter);\napp.get('/api/v1/health', healthRouter.coregHealth); // no auth — liveness probe"
  );
  write('api/app.js', app);
} else {
  console.log('  • /api/v1/health already registered');
}

// ─── FIX 3: pipeline.js — GET / summary handler ──────────────────────────────
console.log('\n── Fix 3: api/routes/pipeline.js (GET /api/v1/pipeline summary) ──────');
let pipeline = read('api/routes/pipeline.js');
if (!pipeline.includes('fix-pipeline-summary')) {
  const handler = `
// ─── GET PIPELINE SUMMARY (count by status + recent entries) ──────────────────
// GET /api/v1/pipeline  — mounted with authenticate in app.js   /* fix-pipeline-summary */
router.get('/', async (_req, res, next) => {
  try {
    const db = require('../services/db');
    const byStatus = await db.clients.query(
      \`SELECT to_stage AS status, COUNT(*)::int AS count
         FROM pcm_client_pipeline_audit
        GROUP BY to_stage
        ORDER BY count DESC\`
    );
    const recent = await db.clients.query(
      \`SELECT client_id, from_stage, to_stage, transitioned_by,
              transition_role, reason, notes, created_at
         FROM pcm_client_pipeline_audit
        ORDER BY created_at DESC
        LIMIT 20\`
    );
    const total = byStatus.rows.reduce((sum, r) => sum + Number(r.count), 0);
    res.json({
      total,
      by_status: byStatus.rows,
      recent:    recent.rows,
      generated_at: new Date().toISOString()
    });
  } catch (err) { next(err); }
});
`;
  // insert right after the router is created
  pipeline = pipeline.replace(
    'const router = express.Router();',
    `const router = express.Router();\n${handler}`
  );
  write('api/routes/pipeline.js', pipeline);
} else {
  console.log('  • pipeline summary handler already present');
}

// ─── FIX 4: ais-client.js — wire real AIS call ───────────────────────────────
console.log('\n── Fix 4: agents/shared/ais-client.js (wire real AIS call) ───────────');
let ais = read('agents/shared/ais-client.js');
if (!ais.includes('Phase 2: wired')) {
  write('agents/shared/ais-client.js', `/**
 * CoreIdentity PCM — AIS Client
 * Verifies agent identity via Agent Identity Systems (AIS).
 * Phase 2: wired to AIS_API_URL (default https://api.agentidentity.systems).
 */
const AIS_BASE = (typeof process !== 'undefined' && process.env.AIS_API_URL)
  ? process.env.AIS_API_URL.replace(/\\/$/, '')
  : 'https://api.agentidentity.systems';

export async function aisVerify(agentId, context) {
  if (!agentId || !context?.trace_id) {
    throw new Error('AIS verification failed — missing agent_id or trace_id');
  }

  // Identity assertion (always logged for audit)
  console.log(JSON.stringify({
    type:      'AIS_ASSERTION',
    agent_id:  agentId,
    trace_id:  context.trace_id,
    ais_url:   AIS_BASE,
    timestamp: new Date().toISOString()
  }));

  // Phase 2 — verify against the AIS API
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(AIS_BASE + '/verify', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        agent_id: agentId,
        trace_id: context.trace_id,
        context
      }),
      signal: controller.signal
    });
    if (!res.ok) {
      throw new Error(\`AIS verify returned HTTP \${res.status}\`);
    }
    const data = await res.json();
    return {
      verified: data.verified !== false,
      mode:     'live',
      ais_url:  AIS_BASE,
      ...data
    };
  } catch (err) {
    console.error(JSON.stringify({
      type:     'AIS_VERIFY_ERROR',
      agent_id: agentId,
      trace_id: context.trace_id,
      error:    String(err && err.message ? err.message : err)
    }));
    // Fail-close: governance requires a positive identity assertion.
    throw new Error(\`AIS verification failed — \${err && err.message ? err.message : err}\`);
  } finally {
    clearTimeout(timer);
  }
}
`);
} else {
  console.log('  • ais-client already wired');
}

// ─── Validate syntax ─────────────────────────────────────────────────────────
console.log('\n── Syntax checks ─────────────────────────────────────────────────────');
for (const f of ['api/routes/health.js', 'api/routes/pipeline.js', 'api/app.js']) {
  execSync(`node --check ${path.join(REPO, f)}`, { stdio: 'inherit' });
  console.log(`  ✓ ${f} parses`);
}
// ais-client.js is ESM — validate via a temporary .mjs copy
{
  const tmp = path.join(REPO, 'agents/shared/.ais-client.check.mjs');
  fs.copyFileSync(path.join(REPO, 'agents/shared/ais-client.js'), tmp);
  try {
    execSync(`node --check ${tmp}`, { stdio: 'inherit' });
    console.log('  ✓ agents/shared/ais-client.js parses (ESM)');
  } finally {
    fs.unlinkSync(tmp);
  }
}

// ─── Build / validate ────────────────────────────────────────────────────────
console.log('\n── npm run build ─────────────────────────────────────────────────────');
execSync('npm run build', { cwd: REPO, stdio: 'inherit' });

console.log('\n✅ CoreG API fixes applied (Fix 2 health, Fix 3 pipeline, Fix 4 AIS).');
