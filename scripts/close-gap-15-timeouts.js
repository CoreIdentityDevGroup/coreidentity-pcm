#!/usr/bin/env node
/**
 * CLOSE-GAP-15: no timeout on sentinelCheck() or agent-orchestrator's runAgent()
 *
 * Finding (Phase 1 of the SCRUB spec, 2026-08-13): governance.js's
 * makeRequest() has no socket timeout and no AbortController -- a
 * connection that succeeds but never responds hangs the returned Promise
 * forever. sentinelCheck() only handles the 'error' event (DNS failure,
 * ECONNREFUSED, etc.), which is a different failure mode than a stalled
 * response. Separately, agent-orchestrator.js's runAgent() re-throws on a
 * rejected agent.execute() (fail-loud, confirmed in Phase 1), but has no
 * timeout around that await -- a stuck agent (stuck query, stuck outbound
 * call) hangs runAgent() the same way. A wedged request is worse than
 * fail-open or fail-closed: the caller never gets a definite outcome, so
 * transaction state stays indeterminate instead of being decided either
 * way.
 *
 * Fix:
 * - makeRequest() takes a timeoutMs option, sets it as the HTTP request's
 *   socket timeout, and on the 'timeout' event destroys the request and
 *   resolves with a distinguishable { timedOut: true } result rather than
 *   leaving the Promise pending. This is a genuine socket-level timeout
 *   (Node's req.setTimeout equivalent via the `timeout` request option),
 *   not just a race against a separate clock -- the underlying connection
 *   is actually torn down.
 * - sentinelCheck() passes SENTINEL_TIMEOUT_MS (default 3000) and, on
 *   result.timedOut, returns a decision distinct from both a real Sentinel
 *   BLOCK and the existing BLOCK_SENTINEL_UNAVAILABLE (connection-level
 *   failure) -- BLOCK_SENTINEL_TIMEOUT. Three different decision strings
 *   for three different failure shapes; CLOSE-GAP-16 (not this script)
 *   is where the gap-12 status model gets a matching third state.
 * - runAgent()'s await on agent.execute() is wrapped with a
 *   Promise.race() against PCM_AGENT_TIMEOUT_MS (default 15000). Honest
 *   limitation, stated here rather than glossed over: Node has no general
 *   cancellation for arbitrary in-flight async work (no AbortSignal
 *   plumbed through agent.execute() implementations) -- this bounds how
 *   long runAgent() itself can hang, it does not kill a still-running
 *   query or outbound call inside the agent. That in-flight work keeps
 *   running in the background after runAgent() has already rejected and
 *   the caller has moved on. This is still strictly better than the
 *   status quo (indefinite hang, no caller-visible outcome ever), but it
 *   is not full cancellation and shouldn't be described as such.
 *
 * No database access of any kind -- this script only edits source files and
 * runs `npm run build`.
 *
 * Idempotent: detects the existing timeout additions before writing;
 * no-ops cleanly on re-run.
 *
 * Run: node scripts/close-gap-15-timeouts.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const GOV_TARGET  = path.join(REPO_ROOT, 'api', 'services', 'governance.js');
const ORCH_TARGET = path.join(REPO_ROOT, 'agent-orchestrator.js');

// ─────────────────────────────────────────────────────────────────────────────
// governance.js changes
// ─────────────────────────────────────────────────────────────────────────────

const OLD_MAKE_REQUEST = `function makeRequest(urlStr, method, body, headers = {}) {
  return new Promise((resolve) => {
    const parsed  = new URL(urlStr);
    const lib     = parsed.protocol === 'https:' ? https : http;
    const payload = body ? JSON.stringify(body) : null;

    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(COREIDENTITY_API_KEY ? { 'X-API-Key': COREIDENTITY_API_KEY } : {}),
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers
      }
    };

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });

    req.on('error', (err) => {
      console.error(JSON.stringify({
        level: 'error', message: 'Governance request failed',
        error: err.message, url: urlStr
      }));
      resolve({ status: 500, body: { error: err.message } });
    });

    if (payload) req.write(payload);
    req.end();
  });
}`;

const NEW_MAKE_REQUEST = `function makeRequest(urlStr, method, body, headers = {}, timeoutMs = 0) {
  return new Promise((resolve) => {
    const parsed  = new URL(urlStr);
    const lib     = parsed.protocol === 'https:' ? https : http;
    const payload = body ? JSON.stringify(body) : null;

    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method,
      ...(timeoutMs > 0 ? { timeout: timeoutMs } : {}),
      headers: {
        'Content-Type': 'application/json',
        ...(COREIDENTITY_API_KEY ? { 'X-API-Key': COREIDENTITY_API_KEY } : {}),
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers
      }
    };

    let settled = false;

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (settled) return;
        settled = true;
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });

    // CLOSE-GAP-15: Node's \`timeout\` request option fires this event on
    // socket inactivity but does NOT itself abort the request -- req.destroy()
    // is required, or the socket (and this Promise) would otherwise still
    // resolve/hang on whatever happens next. timedOut:true is the signal
    // callers use to distinguish "no response in time" from a connection
    // error or a real non-200 response.
    req.on('timeout', () => {
      if (settled) return;
      settled = true;
      req.destroy(new Error('request timed out'));
      console.error(JSON.stringify({
        level: 'error', message: 'Governance request timed out',
        url: urlStr, timeoutMs
      }));
      resolve({ status: 0, body: { error: 'timeout' }, timedOut: true });
    });

    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      console.error(JSON.stringify({
        level: 'error', message: 'Governance request failed',
        error: err.message, url: urlStr
      }));
      resolve({ status: 500, body: { error: err.message } });
    });

    if (payload) req.write(payload);
    req.end();
  });
}`;

const OLD_SENTINEL_CALL = `  try {
    const result = await makeRequest(
      \`\${SENTINEL_URL}/api/sentinel/evaluate\`,
      'POST',
      { action, resource, context, platform: 'CoreG-PCM' },
      authHeaders
    );

    if (result.status === 200) {
      return {
        allowed:  result.body?.decision === 'ALLOW',
        decision: result.body?.decision || 'UNKNOWN',
        reason:   result.body?.reason   || null
      };
    }

    // Sentinel unreachable — FAIL CLOSE — block action
    console.error(JSON.stringify({
      level: 'error',
      message: 'Sentinel unreachable — FAIL CLOSE — action blocked',
      action, resource, status: result.status,
      timestamp: new Date().toISOString()
    }));
    return { allowed: false, decision: 'BLOCK_SENTINEL_UNAVAILABLE', reason: 'Sentinel enforcement unavailable — action blocked per fail-close policy' };`;

const NEW_SENTINEL_CALL = `  try {
    const result = await makeRequest(
      \`\${SENTINEL_URL}/api/sentinel/evaluate\`,
      'POST',
      { action, resource, context, platform: 'CoreG-PCM' },
      authHeaders,
      SENTINEL_TIMEOUT_MS
    );

    if (result.status === 200) {
      return {
        allowed:  result.body?.decision === 'ALLOW',
        decision: result.body?.decision || 'UNKNOWN',
        reason:   result.body?.reason   || null
      };
    }

    if (result.timedOut) {
      // CLOSE-GAP-15: distinguishable from BLOCK_SENTINEL_UNAVAILABLE below --
      // this is "Sentinel didn't answer in time," not "the connection failed."
      console.error(JSON.stringify({
        level: 'error',
        message: 'Sentinel timed out — FAIL CLOSE — action blocked',
        action, resource, timeout_ms: SENTINEL_TIMEOUT_MS,
        timestamp: new Date().toISOString()
      }));
      return { allowed: false, decision: 'BLOCK_SENTINEL_TIMEOUT', reason: \`Sentinel did not respond within \${SENTINEL_TIMEOUT_MS}ms — action blocked per fail-close policy\` };
    }

    // Sentinel unreachable — FAIL CLOSE — block action
    console.error(JSON.stringify({
      level: 'error',
      message: 'Sentinel unreachable — FAIL CLOSE — action blocked',
      action, resource, status: result.status,
      timestamp: new Date().toISOString()
    }));
    return { allowed: false, decision: 'BLOCK_SENTINEL_UNAVAILABLE', reason: 'Sentinel enforcement unavailable — action blocked per fail-close policy' };`;

const OLD_SENTINEL_CONST = `const SENTINEL_JWT_SECRET = process.env.SENTINEL_JWT_SECRET;`;
const NEW_SENTINEL_CONST = `const SENTINEL_JWT_SECRET = process.env.SENTINEL_JWT_SECRET;
// CLOSE-GAP-15: hard timeout for the Sentinel call specifically. Default 3s --
// short enough that a stalled dependency can't wedge a pipeline-advance
// request behind it, long enough to not misfire against normal network jitter.
const SENTINEL_TIMEOUT_MS = parseInt(process.env.SENTINEL_TIMEOUT_MS, 10) || 3000;`;

// ─────────────────────────────────────────────────────────────────────────────
// agent-orchestrator.js changes
// ─────────────────────────────────────────────────────────────────────────────

const OLD_ORCH_HEADER = `'use strict';

const { execSync } = require('child_process');`;

const NEW_ORCH_HEADER = `'use strict';

const { execSync } = require('child_process');

// CLOSE-GAP-15: runAgent() previously had no timeout around
// agent.execute() -- an agent stuck on a query or outbound call hung
// runAgent() forever instead of producing a definite error. Promise.race()
// bounds how long runAgent() itself can hang; it does not cancel the
// agent's in-flight work (Node has no general cancellation for arbitrary
// async code, and no AbortSignal is threaded through agent.execute()
// implementations) -- that work keeps running in the background after
// this rejects. Still strictly better than an indefinite hang with no
// caller-visible outcome at all.
const AGENT_TIMEOUT_MS = parseInt(process.env.PCM_AGENT_TIMEOUT_MS, 10) || 15000;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(\`\${label} timed out after \${ms}ms\`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}`;

const OLD_RUN_AGENT_CALL = `  try {
    const result = await agent.execute({ ...context, db });`;
const NEW_RUN_AGENT_CALL = `  try {
    const result = await withTimeout(agent.execute({ ...context, db }), AGENT_TIMEOUT_MS, \`Agent \${name}\`);`;

function applyTo(targetPath, replacements, label) {
  if (!fs.existsSync(targetPath)) {
    console.error(`✗ Target file not found: ${targetPath}`);
    process.exit(1);
  }
  let contents = fs.readFileSync(targetPath, 'utf8');

  if (contents.includes('CLOSE-GAP-15')) {
    console.log(`✓ CLOSE-GAP-15 already applied to ${label} — no-op.`);
    return false;
  }

  for (const [oldBlock, newBlock] of replacements) {
    if (!contents.includes(oldBlock)) {
      console.error(`✗ Expected block not found in ${label} — file may have changed since this script was written.`);
      console.error('  Refusing to apply blind edit. Manual review required.');
      process.exit(1);
    }
    contents = contents.replace(oldBlock, newBlock);
  }

  fs.writeFileSync(targetPath, contents, 'utf8');
  return true;
}

function main() {
  const govChanged = applyTo(GOV_TARGET, [
    [OLD_MAKE_REQUEST, NEW_MAKE_REQUEST],
    [OLD_SENTINEL_CONST, NEW_SENTINEL_CONST],
    [OLD_SENTINEL_CALL, NEW_SENTINEL_CALL],
  ], 'api/services/governance.js');

  const orchChanged = applyTo(ORCH_TARGET, [
    [OLD_ORCH_HEADER, NEW_ORCH_HEADER],
    [OLD_RUN_AGENT_CALL, NEW_RUN_AGENT_CALL],
  ], 'agent-orchestrator.js');

  if (!govChanged && !orchChanged) {
    return;
  }

  console.log('✓ CLOSE-GAP-15 applied: makeRequest()/sentinelCheck() have a hard');
  console.log('  socket timeout (SENTINEL_TIMEOUT_MS, default 3000ms), distinguishable');
  console.log('  from a connection error via BLOCK_SENTINEL_TIMEOUT vs');
  console.log('  BLOCK_SENTINEL_UNAVAILABLE. runAgent() bounds its wait on');
  console.log('  agent.execute() via PCM_AGENT_TIMEOUT_MS (default 15000ms).');

  console.log('\nRunning npm run build...');
  execSync('npm run build', { cwd: REPO_ROOT, stdio: 'inherit' });
}

main();
