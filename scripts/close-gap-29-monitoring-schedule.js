#!/usr/bin/env node
/**
 * CLOSE-GAP-29 (Phase 3.6): mount the new scheduled-monitoring route,
 * remove the dead setInterval scheduler machinery it replaces.
 *
 * api/routes/scheduled.js and api/middleware/authenticateScheduler.js
 * already exist (written directly, not via this script -- this script
 * only wires them in and removes now-fully-superseded code). The
 * setInterval call site itself was already rejected and never
 * committed in Phase 3.1; this removes the dead startMonitoringSchedule()
 * function and _monitoringTimer variable in agent-orchestrator.js that
 * were left behind with no caller, now that a real replacement exists.
 *
 * No database access. Idempotent.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const APP_FILE  = path.join(REPO_ROOT, 'api', 'app.js');
const ORCH_FILE = path.join(REPO_ROOT, 'agent-orchestrator.js');

const MARKER = 'CLOSE-GAP-29';

function patchApp() {
  let contents = fs.readFileSync(APP_FILE, 'utf8');
  if (contents.includes(MARKER)) {
    console.log('✓ CLOSE-GAP-29 already applied to app.js — no-op.');
    return;
  }

  const OLD_REQUIRE = `// ─── PHASE 2: COREG PORTAL EXPANSION ──────────────────────────────────────────`;
  if (!contents.includes(OLD_REQUIRE)) {
    console.error('✗ Phase 2 comment anchor not found in app.js.');
    process.exit(1);
  }

  // Add the require near the other router requires -- find any existing
  // `const ... Router = require(...)` line to anchor after.
  const REQUIRE_ANCHOR = `const rulesRouter`;
  const requireIdx = contents.indexOf(REQUIRE_ANCHOR);
  if (requireIdx === -1) {
    console.error('✗ rulesRouter require anchor not found in app.js.');
    process.exit(1);
  }
  const lineEnd = contents.indexOf('\n', requireIdx);
  contents = contents.slice(0, lineEnd + 1)
    + `const scheduledRouter    = require('./routes/scheduled'); // CLOSE-GAP-29: external-scheduler monitoring target\n`
    + contents.slice(lineEnd + 1);

  const OLD_MOUNT = `app.use('/api/v1/rules',         authenticate, rulesRouter);`;
  const NEW_MOUNT = `app.use('/api/v1/rules',         authenticate, rulesRouter);
// CLOSE-GAP-29 (Phase 3.6): no \`authenticate\` (JWT) here -- this is a
// machine target for an external scheduler, gated by its own
// X-Scheduler-Api-Key check inside the router instead.
app.use('/api/v1/scheduled',     scheduledRouter);`;
  if (!contents.includes(OLD_MOUNT)) {
    console.error('✗ rulesRouter mount line not found in app.js.');
    process.exit(1);
  }
  contents = contents.replace(OLD_MOUNT, NEW_MOUNT);

  fs.writeFileSync(APP_FILE, contents, 'utf8');
  console.log('✓ Mounted /api/v1/scheduled in app.js.');
}

function patchOrchestrator() {
  let contents = fs.readFileSync(ORCH_FILE, 'utf8');
  if (contents.includes(MARKER)) {
    console.log('✓ CLOSE-GAP-29 already applied to agent-orchestrator.js — no-op.');
    return;
  }

  const OLD = `// contract-monitoring ("continuous") and transaction-monitoring ("stage_6_gate")
// have no discrete route event to hook — they poll state instead. Without this,
// runMonitoringCycle is only reachable via the manual POST /api/v1/agents/monitoring
// endpoint and never fires on its own.
let _monitoringTimer = null;
function startMonitoringSchedule(intervalMs = parseInt(process.env.PCM_MONITORING_INTERVAL_MS || '900000', 10)) {
  if (_monitoringTimer) return _monitoringTimer;
  _monitoringTimer = setInterval(() => {
    runMonitoringCycle().catch(err => console.error(JSON.stringify({
      level: 'error', message: 'Scheduled monitoring cycle failed', error: err.message
    })));
  }, intervalMs);
  _monitoringTimer.unref();
  console.log(JSON.stringify({
    level: 'info', message: 'Monitoring cycle schedule started', interval_ms: intervalMs
  }));
  return _monitoringTimer;
}

module.exports = { runAgent, runMonitoringCycle, startMonitoringSchedule };`;

  const NEW = `// CLOSE-GAP-29 (Phase 3.6): the setInterval scheduler that used to live
// here was rejected in Phase 3.1 review and never wired up -- its state
// lived entirely in-process and reset on every deploy, making the
// "recurring" cadence unreliable even at a single replica. Replaced by
// an external scheduler calling POST /api/v1/scheduled/monitoring (see
// api/routes/scheduled.js): idempotency-key guarded, and its success
// emits a real CloudWatch metric a staleness alarm can watch for --
// contract-monitoring and transaction-monitoring have no discrete route
// event to hook, they poll state instead, so silence here must be
// detectable as unhealthy, not indistinguishable from "nothing to do."

module.exports = { runAgent, runMonitoringCycle };`;

  if (!contents.includes(OLD)) {
    console.error('✗ Expected startMonitoringSchedule block not found in agent-orchestrator.js.');
    process.exit(1);
  }
  contents = contents.replace(OLD, NEW);
  fs.writeFileSync(ORCH_FILE, contents, 'utf8');
  console.log('✓ Removed dead startMonitoringSchedule()/setInterval from agent-orchestrator.js.');
}

function main() {
  patchApp();
  patchOrchestrator();
  console.log('\nRunning npm run build...');
  execSync('npm run build', { cwd: REPO_ROOT, stdio: 'inherit' });
}

main();
