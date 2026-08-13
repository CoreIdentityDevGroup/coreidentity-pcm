#!/usr/bin/env node
/**
 * CoreIdentity PCM — Reachability Validator (Phase 2 of the SCRUB)
 *
 * This replaces the prior scaffold check (file/field presence only). It
 * encodes what this scrub actually found by direct source reading this
 * session, and re-verifies each finding against the live source tree and
 * (where available) the live database on every run — it does not just
 * print a frozen answer key.
 *
 * Phase 6.2: ENFORCE is now the default. All findings live at the time
 * this flipped were either fixed for real (CLOSE-GAP-31's appraisal_review
 * allowlist rewrite) or reclassified from fail to warn with a documented
 * reason (token-minting/deletion-certification's confirmed-dead state --
 * a permanent, reviewed Phase 3.3 decision, not an outstanding defect;
 * see check2_1's comments). Set VALIDATE_AGENTS_ENFORCE=false to drop
 * back to WARN mode for local iteration -- default WARN behavior no
 * longer ships silently.
 *
 * Eight checks, run in order:
 *   2.1 Manifest truth        — declared trigger vs. traced real call site
 *   2.2 Gate-bound column guard — derived from GATE_REQUIREMENTS itself
 *   2.3 Declared property reachability — sentinel_enforced, pq_signing
 *   2.4 Schema truth          — every referenced table/column exists live
 *   2.5 Deployment drift      — running image SHA vs. git HEAD (advisory)
 *   2.6 Manifest external-source truth — claimed vs. actual external calls
 *   2.7 Gate allowlist/blocklist pattern
 *   2.8 State-machine adjacency (CLOSE-GAP-30 regression guard)
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO_ROOT   = path.join(__dirname, '..');
const AGENTS_DIR   = path.join(REPO_ROOT, 'agents');
const ROUTES_DIR    = path.join(REPO_ROOT, 'api', 'routes');
const ORCH_FILE      = path.join(REPO_ROOT, 'agent-orchestrator.js');
const SERVICES_PIPELINE_FILE = path.join(REPO_ROOT, 'api', 'services', 'pipeline.js');

const ENFORCE = process.env.VALIDATE_AGENTS_ENFORCE !== 'false';

const REQUIRED_AGENTS = [
  'intake-parser', 'asset-classifier', 'document-date-validator',
  'pof-verifier', 'ofac-screening', 'valuation-parser', 'bank-routing',
  'token-minting', 'deletion-certification', 'contract-monitoring',
  'transaction-monitoring', 'instrument-integrity',
];

let results = []; // { section, level: 'pass'|'warn'|'fail', message }

function record(section, level, message) {
  results.push({ section, level, message });
}

function readIfExists(p) {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

function readAllRouteFiles() {
  return fs.readdirSync(ROUTES_DIR)
    .filter(f => f.endsWith('.js'))
    .map(f => ({ file: `api/routes/${f}`, text: fs.readFileSync(path.join(ROUTES_DIR, f), 'utf8') }));
}

// ═════════════════════════════════════════════════════════════════════════
// 2.1 — MANIFEST TRUTH
// ═════════════════════════════════════════════════════════════════════════
//
// AGENT_TRACE encodes the real invocation site for each agent, established
// by direct source reading this session (the "4c trace"). Each entry is
// re-verified against the live source below, not just asserted — if the
// call-site pattern moves or disappears, this check fails loudly rather
// than silently trusting stale metadata.
const AGENT_TRACE = {
  'intake-parser': {
    realSite: 'api/routes/clients.js — fire-and-forget at client creation (POST /)',
    file: 'api/routes/clients.js', pattern: "runAgent('intake-parser'", reachable: true,
  },
  'ofac-screening': {
    realSite: 'api/routes/clients.js — fire-and-forget at client creation (POST /), NOT at the KYC gate its manifest names',
    file: 'api/routes/clients.js', pattern: "runAgent('ofac-screening'", reachable: true,
  },
  'pof-verifier': {
    realSite: 'api/routes/clients.js — fire-and-forget at POF submission (POST /:id/pof)',
    file: 'api/routes/clients.js', pattern: "runAgent('pof-verifier'", reachable: true,
  },
  'asset-classifier': {
    realSite: 'api/routes/assets.js — fire-and-forget at asset creation (POST /)',
    file: 'api/routes/assets.js', pattern: "runAgent('asset-classifier'", reachable: true,
  },
  'bank-routing': {
    realSite: 'api/routes/assets.js — fire-and-forget at asset creation (POST /), advisory; the bank_assignment gate never reads its output',
    file: 'api/routes/assets.js', pattern: "runAgent('bank-routing'", reachable: true,
  },
  'instrument-integrity': {
    realSite: 'api/routes/assets.js — fire-and-forget at asset creation (POST /); its output IS read later by the appraisal_review gate',
    file: 'api/routes/assets.js', pattern: "runAgent('instrument-integrity'", reachable: true,
  },
  'valuation-parser': {
    realSite: 'api/routes/assets.js — fire-and-forget at valuation submission (POST /:id/valuations)',
    file: 'api/routes/assets.js', pattern: "runAgent('valuation-parser'", reachable: true,
  },
  'document-date-validator': {
    realSite: 'api/routes/assets.js — fire-and-forget at valuation submission (POST /:id/valuations)',
    file: 'api/routes/assets.js', pattern: "runAgent('document-date-validator'", reachable: true,
  },
  'contract-monitoring': {
    realSite: 'agent-orchestrator.js — runMonitoringCycle(), scheduled/manual only, not tied to any stage',
    file: 'agent-orchestrator.js', pattern: "runAgent('contract-monitoring'", reachable: true,
  },
  'transaction-monitoring': {
    realSite: 'agent-orchestrator.js — runMonitoringCycle(), scheduled/manual only, not tied to any stage despite manifest naming stage_6_gate',
    file: 'agent-orchestrator.js', pattern: "runAgent('transaction-monitoring'", reachable: true,
  },
  'token-minting': {
    realSite: 'DEAD — CLOSE-GAP-23 removed the only (already-unreachable) call site entirely, so there is no longer any pattern to re-verify against api/routes/assets.js. Confirmed instead via the manifest.json superseded marker. Real tokenization runs through a hand-duplicated inline function (pipeline.js triggerTokenization()), a different implementation entirely.',
    confirmedDead: true, manifestMarker: '[SUPERSEDED',
  },
  'deletion-certification': {
    realSite: 'DEAD — only call site is _unwiredStageAdvanceTriggers(), which has zero callers. No inline substitute exists either; advancing to completed triggers nothing.',
    file: 'api/routes/assets.js', pattern: "runAgent('deletion-certification'", reachable: false,
  },
};

function countFunctionCallers(sourceText, fnName) {
  // Crude but effective for this codebase's style: count occurrences of
  // `fnName(` that are not the `function fnName(` or `async function
  // fnName(` definition itself.
  const all = (sourceText.match(new RegExp(`\\b${fnName}\\s*\\(`, 'g')) || []).length;
  const isDefined = new RegExp(`function\\s+${fnName}\\s*\\(`).test(sourceText);
  return isDefined ? all - 1 : all;
}

function check2_1() {
  const routeFiles = readAllRouteFiles();
  const orchText = readIfExists(ORCH_FILE) || '';

  for (const agent of REQUIRED_AGENTS) {
    const manifestPath = path.join(AGENTS_DIR, agent, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      record('2.1', 'fail', `${agent}: manifest.json missing`);
      continue;
    }
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (e) {
      record('2.1', 'fail', `${agent}: manifest.json parse error — ${e.message}`);
      continue;
    }

    const trace = AGENT_TRACE[agent];
    if (!trace) {
      record('2.1', 'fail', `${agent}: no trace entry recorded — this validator does not know this agent's real call site`);
      continue;
    }

    if (trace.confirmedDead) {
      // No call-site pattern to re-verify — the agent has no reference
      // anywhere in the route/orchestrator source at all. Re-verify the
      // weaker claim that's still checkable: the manifest carries its
      // superseded marker (i.e. this wasn't silently reverted).
      //
      // WARN, not FAIL (Phase 6.2): this is a deliberate, reviewed,
      // permanent decision (Phase 3.3/CLOSE-GAP-23), not an outstanding
      // defect -- token-minting's real implementation is
      // pipeline.js's triggerTokenization(), and re-wiring this module
      // would not satisfy the completed-stage gate even if done, since
      // it never sets pcm_assets.token_id. A build that can never go
      // green again for an intentionally-retired module defeats the
      // purpose of enforce mode; the marker-integrity check below still
      // catches a real regression (someone silently reverting the
      // superseded state) at fail severity.
      if (manifest.description.startsWith(trace.manifestMarker)) {
        record('2.1', 'warn', `${agent}: confirmed dead as designed (Phase 3.3) — ${trace.realSite}. Manifest trigger '${manifest.trigger}' remains asserted but is understood to be historical, not a live claim.`);
      } else {
        record('2.1', 'fail', `${agent}: manifest superseded-marker missing or changed — re-verify this agent is still actually dead, not just re-flagged`);
      }
      continue;
    }

    const traceFileText = trace.file === 'agent-orchestrator.js'
      ? orchText
      : (routeFiles.find(r => r.file === trace.file) || {}).text || '';

    const patternFound = traceFileText.includes(trace.pattern);
    if (!patternFound) {
      record('2.1', 'fail', `${agent}: expected call-site pattern "${trace.pattern}" not found in ${trace.file} — trace is stale, re-verify manually`);
      continue;
    }

    if (!trace.reachable) {
      // Confirm the dead-function claim is still true, don't just trust it.
      const allSourceText = routeFiles.map(r => r.text).join('\n') + orchText;
      const callers = countFunctionCallers(allSourceText, '_unwiredStageAdvanceTriggers');
      if (callers > 0) {
        // A real regression signal (something re-wired a call site this
        // agent depends on) -- kept at fail severity.
        record('2.1', 'fail', `${agent}: previously dead call site (_unwiredStageAdvanceTriggers) now has ${callers} caller(s) — re-investigate, this may have been wired up since the trace was recorded`);
      } else {
        // WARN, not FAIL (Phase 6.2): deletion-certification staying
        // unreachable is a deliberate, reviewed decision (Phase 3.3/
        // CLOSE-GAP-24) -- wiring it as-is would generate a false
        // compliance certificate (no DELETE statement exists anywhere in
        // it), not close a gap. Real deletion logic is an out-of-scope
        // product/legal decision, not assumed here. The caller-count
        // check above still catches an actual regression at fail
        // severity if this ever gets silently re-wired.
        record('2.1', 'warn', `${agent}: confirmed dead as designed (Phase 3.3) — ${trace.realSite}. Manifest trigger '${manifest.trigger}' remains asserted but is understood to be historical, not a live claim.`);
      }
      continue;
    }

    // Reachable agent: declared trigger almost never matches real invocation
    // timing in this codebase (most agents are fire-and-forget at intake,
    // not gated at the stage their manifest names) — that mismatch itself
    // is the finding this check exists to surface, not an error in the
    // validator.
    record('2.1', 'warn', `${agent}: manifest trigger '${manifest.trigger}' does not describe the real invocation site. Real: ${trace.realSite}`);
  }
}

// ═════════════════════════════════════════════════════════════════════════
// 2.2 — GATE-BOUND COLUMN GUARD (derived from GATE_REQUIREMENTS itself)
// ═════════════════════════════════════════════════════════════════════════

function deriveGateBoundColumns() {
  const src = readIfExists(SERVICES_PIPELINE_FILE);
  if (!src) return [];

  const startMarker = 'const GATE_REQUIREMENTS = {';
  const start = src.indexOf(startMarker);
  if (start === -1) return [];
  // Find the matching close of this top-level object literal by brace counting.
  let depth = 0, i = start + startMarker.length - 1, end = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const body = src.slice(start, end + 1);

  // Parse each individual backtick-delimited SQL query on its own -- pairing
  // columns with tables per-query, not per-stage-block, avoids cross-query
  // contamination when a single gate checker runs more than one query
  // against different tables (e.g. collateralization checks pcm_assets AND
  // pcm_agreements in the same function).
  const queryPattern = /`([^`]*SELECT[\s\S]*?FROM[\s\S]*?)`/g;
  const pairs = new Set();
  let m;
  while ((m = queryPattern.exec(body)) !== null) {
    const query = m[1];
    const fromMatch = query.match(/FROM\s+(pcm_\w+)/);
    if (!fromMatch) continue;
    const table = fromMatch[1];

    // SELECT-list columns (skip * and COUNT(*); unwrap MAX(x) to its real
    // inner column since that's what gate checkers actually consult, e.g.
    // `MAX(date_validation_status) as val_status`).
    const selectMatch = query.match(/SELECT\s+([\s\S]*?)\s+FROM/);
    if (selectMatch) {
      const cols = selectMatch[1].split(',').map(c => c.trim());
      for (const col of cols) {
        if (/^\*$/.test(col)) continue;
        const maxMatch = col.match(/^MAX\(\s*(\w+)\s*\)/i);
        if (maxMatch) { pairs.add(`${table}.${maxMatch[1]}`); continue; }
        if (/^COUNT\(/i.test(col)) continue;
        if (/^[a-z_][a-z0-9_]*$/i.test(col)) pairs.add(`${table}.${col}`);
      }
    }

    // WHERE-clause equality against a string literal -- this is where
    // status-machine gate conditions actually live (e.g.
    // `status = 'fully_executed'`), not in a COUNT(*) SELECT list.
    for (const w of query.matchAll(/(\w+)\s*=\s*'[^']*'/g)) {
      pairs.add(`${table}.${w[1]}`);
    }
  }
  return [...pairs];
}

// Routes that legitimately write a gate-bound column WITHOUT calling
// advancePipeline() -- they are evidence-input endpoints (recording KYC
// docs, POF, valuations, bank assignment, signatures), not stage
// transitions. Each entry documents why. Anything writing a gate-bound
// column that is NOT here and NOT routed through advancePipeline() fails.
const EXEMPT_GATE_COLUMN_WRITES = [
  { file: 'api/routes/assets.js',  col: 'bank_assignment',        match: "bank_assignment = $1", reason: 'records bank assignment data; the collateralization gate reads it later, this route does not transition a stage' },
  { file: 'api/routes/assets.js',  col: 'date_validation_status', match: "date_validation_status = 'passed'", reason: 'computed inline from real same-date enforcement logic in the same handler, not accepted as a client-supplied value' },
  { file: 'api/routes/clients.js', col: 'ofac_status',    match: "SET ofac_status = 'manual_review'", reason: 'CLOSE-GAP-19a dual-control override endpoint; sets status only after two-principal confirmation, verified independently by the KYC gate' },
  { file: 'api/routes/clients.js', col: 'review_outcome', match: "review_outcome = 'MANUAL_OVERRIDE_CONFIRMED'", reason: 'CLOSE-GAP-19a countersign step; the KYC gate independently re-verifies this value against pcm_ofac_results rather than trusting the flag' },
  // CLOSE-GAP-28: named exemptions for the CLOSE-GAP-26 attestation
  // write sites, distinct from the MANUAL_OVERRIDE entries above even
  // though the current whole-file check already passes them by
  // coincidence (same file, different literal).
  { file: 'api/routes/clients.js', col: 'ofac_status',    match: "SET ofac_status = 'attested_out_of_band'", reason: 'CLOSE-GAP-26 out-of-band attestation confirm step; sets status only after two-principal confirmation, verified independently by the KYC gate exactly like the manual_review path' },
  { file: 'api/routes/clients.js', col: 'review_outcome', match: "review_outcome = 'ATTESTATION_CONFIRMED'", reason: 'CLOSE-GAP-26 attestation confirm step; the KYC gate independently re-verifies this value against pcm_ofac_results rather than trusting the flag' },
  { file: 'api/routes/clients.js', col: 'provider',       match: "provider, status, raw_response_summary, reviewed_by", reason: "CLOSE-GAP-19a override record — provider is hardcoded literal 'MANUAL_OVERRIDE', not client-supplied" },
  { file: 'api/routes/forms.js',   col: 'status',         match: "SET status = 'fully_executed'", reason: 'computed from actual signature count in the sign flow itself (parties/:party_id/sign), not an unverified assertion' },
  { file: 'api/routes/forms.js',   col: 'agreement_type', match: "INSERT INTO pcm_agreements", reason: 'set once at agreement creation, never mutated afterward — not a stage-transition bypass' },
];

function check2_2() {
  const columns = deriveGateBoundColumns();
  if (columns.length === 0) {
    record('2.2', 'fail', 'Could not derive any gate-bound columns from GATE_REQUIREMENTS — parser may be broken, or the source moved. This check is non-functional until fixed.');
    return;
  }
  record('2.2', 'pass', `Derived ${columns.length} gate-bound column(s) from GATE_REQUIREMENTS: ${columns.join(', ')}`);

  const routeFiles = readAllRouteFiles();
  for (const pair of columns) {
    const [table, col] = pair.split('.');
    for (const { file, text } of routeFiles) {
      // Look for UPDATE/INSERT touching this table and mentioning this column.
      const writePattern = new RegExp(`(UPDATE\\s+${table}\\s+SET[^;]*\\b${col}\\b|INSERT INTO\\s+${table}\\s*\\([^)]*\\b${col}\\b)`, 'i');
      if (!writePattern.test(text)) continue;

      const exempt = EXEMPT_GATE_COLUMN_WRITES.find(e => e.file === file && e.col === col && text.includes(e.match));
      if (exempt) {
        record('2.2', 'pass', `${file} writes ${pair} — exempt (${exempt.reason})`);
        continue;
      }

      // Require an actual call, not just the identifier appearing in a
      // comment (e.g. explaining why a route does NOT use it).
      const callsAdvancePipeline = /(?:await\s+advancePipeline\(|=\s*advancePipeline\()/.test(text);
      if (callsAdvancePipeline) {
        record('2.2', 'pass', `${file} writes ${pair} via advancePipeline() (role + gate + Sentinel checks apply)`);
        continue;
      }

      record('2.2', 'fail', `${file} writes ${pair} without routing through advancePipeline() and without a documented exemption in this validator — unguarded gate-bound write`);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════
// 2.3 — DECLARED PROPERTY REACHABILITY
// ═════════════════════════════════════════════════════════════════════════

function check2_3() {
  for (const agent of REQUIRED_AGENTS) {
    const manifestPath = path.join(AGENTS_DIR, agent, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { continue; }

    const gov = manifest.governance || {};

    // sentinel_enforced: true requires the agent's real call site to reach
    // advancePipeline() (the only place sentinelCheck() is wired, as of
    // CLOSE-GAP-16). None currently do — see 2.1's trace.
    if (gov.sentinel_enforced === true) {
      const trace = AGENT_TRACE[agent];
      const reachesAdvancePipeline = false; // true for zero agents as of this scrub; see 4c trace
      if (!reachesAdvancePipeline) {
        record('2.3', 'fail', `${agent}: manifest declares sentinel_enforced:true but its call site (${trace ? trace.realSite : 'unknown'}) does not reach advancePipeline() / sentinelCheck()`);
      }
    } else if (gov.sentinel_enforced === undefined) {
      record('2.3', 'warn', `${agent}: governance.sentinel_enforced is unset — no assertion possible, property is unverifiable as written`);
    }

    // pq_signing: any value other than an explicit "unsigned" label is
    // asserting real post-quantum signing exists. This repo has no PQ
    // signing backend anywhere (confirmed: CLOSE-GAP-18 investigation,
    // deletion-certification's own UNSIGNED-NO-PQ-BACKEND-V1 label).
    const pq = gov.pq_signing;
    if (pq && pq !== 'UNSIGNED-NO-PQ-BACKEND-V1' && !/unsigned/i.test(pq)) {
      record('2.3', 'fail', `${agent}: governance.pq_signing = '${pq}' asserts real PQ signing; no signing backend exists in this repo for any agent`);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════
// 2.4 — SCHEMA TRUTH
// ═════════════════════════════════════════════════════════════════════════

async function fetchLiveSchema() {
  // Best-effort: only runs if PCM_DB_*_HOST env vars are present (as they
  // are in the real deployed container). Degrades gracefully otherwise --
  // this check must not make `npm run build` require database access in
  // every context it might run in.
  const hosts = {
    clients: process.env.PCM_DB_CLIENT_HOST,
    assets:  process.env.PCM_DB_ASSET_HOST,
    forms:   process.env.PCM_DB_FORMS_HOST,
    pehf:    process.env.PCM_DB_PEHF_HOST,
  };
  if (!hosts.clients) return null; // no DB env at all — skip, don't fail

  let Client;
  try { Client = require('pg').Client; } catch { return null; }

  const schema = {}; // { pcm_table: Set(columns) }
  const dbs = [
    { key: 'clients', name: process.env.PCM_DB_CLIENT_NAME, user: process.env.PCM_DB_CLIENT_USER, pass: process.env.PCM_DB_CLIENT_PASSWORD, host: hosts.clients, port: process.env.PCM_DB_CLIENT_PORT },
    { key: 'assets',  name: process.env.PCM_DB_ASSET_NAME,  user: process.env.PCM_DB_ASSET_USER,  pass: process.env.PCM_DB_ASSET_PASSWORD,  host: hosts.assets,  port: process.env.PCM_DB_ASSET_PORT },
    { key: 'forms',   name: process.env.PCM_DB_FORMS_NAME,  user: process.env.PCM_DB_FORMS_USER,  pass: process.env.PCM_DB_FORMS_PASSWORD,  host: hosts.forms,   port: process.env.PCM_DB_FORMS_PORT },
    { key: 'pehf',    name: process.env.PCM_DB_PEHF_NAME,   user: process.env.PCM_DB_PEHF_USER,   pass: process.env.PCM_DB_PEHF_PASSWORD,   host: hosts.pehf,    port: process.env.PCM_DB_PEHF_PORT },
  ];

  for (const db of dbs) {
    if (!db.host || !db.name) continue;
    const client = new Client({ host: db.host, port: db.port || 5432, database: db.name, user: db.user, password: db.pass, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 5000 });
    try {
      await client.connect();
      const res = await client.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`);
      for (const row of res.rows) {
        if (!schema[row.table_name]) schema[row.table_name] = new Set();
        schema[row.table_name].add(row.column_name);
      }
    } catch (err) {
      return { error: `${db.key}: ${err.message}` };
    } finally {
      await client.end().catch(() => {});
    }
  }
  return { schema };
}

async function check2_4() {
  const live = await fetchLiveSchema();
  if (!live) {
    record('2.4', 'warn', 'No PCM_DB_*_HOST env vars present — schema-truth check skipped (needs live DB access, not available in this run context)');
    return;
  }
  if (live.error) {
    record('2.4', 'warn', `Could not connect to live database to verify schema: ${live.error}`);
    return;
  }
  const schema = live.schema;

  // Scan every agent + every route + pipeline.js/governance.js for
  // `FROM pcm_x` / `INTO pcm_x` / `UPDATE pcm_x` references and the
  // columns named alongside them, then check existence.
  const filesToScan = [
    ...fs.readdirSync(AGENTS_DIR).map(a => path.join(AGENTS_DIR, a, 'index.js')).filter(fs.existsSync),
    ...readAllRouteFiles().map(r => path.join(REPO_ROOT, r.file)),
    SERVICES_PIPELINE_FILE,
    path.join(REPO_ROOT, 'api', 'services', 'governance.js'),
    ORCH_FILE,
  ];

  let dynamicQueryFlags = [];

  for (const filePath of filesToScan) {
    if (!fs.existsSync(filePath)) continue;
    const text = fs.readFileSync(filePath, 'utf8');
    const rel = path.relative(REPO_ROOT, filePath);

    // Flag dynamic query construction explicitly rather than silently
    // passing it — e.g. template-built table/column names.
    if (/\$\{[^}]*(table|column|meta\.)/i.test(text)) {
      dynamicQueryFlags.push(rel);
    }

    const tableMatches = [...text.matchAll(/\b(?:FROM|INTO|UPDATE)\s+(pcm_\w+)/g)];
    for (const m of tableMatches) {
      const table = m[1];
      if (!schema[table]) {
        record('2.4', 'fail', `${rel}: references table '${table}' which does not exist in the live schema`);
      }
    }
  }

  for (const flagged of dynamicQueryFlags) {
    record('2.4', 'warn', `${flagged}: dynamic query construction detected — table/column names built from variables, static extraction unreliable, not exhaustively checked`);
  }

  // Specific, known-important checks confirmed by hand this scrub —
  // re-verified live here rather than only asserted.
  if (schema['pcm_monitoring_log']) {
    record('2.4', 'warn', 'pcm_monitoring_log exists live — contract-monitoring/index.js may no longer be referencing a nonexistent table; re-check CLOSE-GAP status');
  } else if (!schema['pcm_contract_monitoring_log']) {
    record('2.4', 'fail', 'Neither pcm_monitoring_log nor pcm_contract_monitoring_log exists live — contract-monitoring cannot write anywhere');
  } else {
    const contractMonitoringSrc = readIfExists(path.join(AGENTS_DIR, 'contract-monitoring', 'index.js')) || '';
    if (/pcm_monitoring_log/.test(contractMonitoringSrc)) {
      record('2.4', 'fail', "contract-monitoring/index.js still references pcm_monitoring_log, which does not exist live. Real table: pcm_contract_monitoring_log");
    } else {
      record('2.4', 'pass', 'contract-monitoring/index.js references the correct live table');
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════
// 2.5 — DEPLOYMENT DRIFT (advisory)
// ═════════════════════════════════════════════════════════════════════════

function check2_5() {
  let gitHead;
  try {
    gitHead = execSync('git rev-parse HEAD', { cwd: REPO_ROOT }).toString().trim();
  } catch (e) {
    record('2.5', 'warn', `Could not determine git HEAD: ${e.message}`);
    return;
  }

  let liveImage;
  try {
    const out = execSync(
      'aws ecs describe-tasks --cluster coreidentity-prod ' +
      '--tasks $(aws ecs list-tasks --cluster coreidentity-prod --service-name pcm-api --region us-east-2 --query "taskArns[0]" --output text) ' +
      '--region us-east-2 --query "tasks[0].containers[0].image" --output text',
      { shell: '/bin/bash', stdio: ['pipe', 'pipe', 'pipe'] }
    ).toString().trim();
    liveImage = out;
  } catch (e) {
    record('2.5', 'warn', 'Could not query live ECS task (no AWS access in this run context, or not running on the ops box) — deployment drift not checked');
    return;
  }

  if (!liveImage || liveImage === 'None') {
    record('2.5', 'warn', 'No running pcm-api task found — cannot check deployment drift');
    return;
  }

  const liveSha = liveImage.split(':').pop();
  if (liveSha === gitHead) {
    record('2.5', 'pass', `Running image SHA matches git HEAD (${gitHead})`);
  } else {
    record('2.5', 'warn', `DEPLOYMENT DRIFT: running image is ${liveSha}, git HEAD is ${gitHead} — ${gitHead === liveSha ? '' : 'undeployed commits exist'}`);
  }
}


// ═════════════════════════════════════════════════════════════════════════
// 2.6 — MANIFEST EXTERNAL-SOURCE TRUTH (CLOSE-GAP-28)
// ═════════════════════════════════════════════════════════════════════════
//
// General form of CLOSE-GAP-24 (deletion-certification's manifest claimed
// it executes deletion; it doesn't) and CLOSE-GAP-25 (ofac-screening's
// manifest claimed a third-party API call; it's hardcoded regex). Any
// agent whose manifest description implies an authoritative external data
// source it does not actually consult is asserting a capability it does
// not have.
const EXTERNAL_CLAIM_PATTERNS = [
  /third-party\s+api/i, /third-party\s+service/i, /\bwatchlist\b/i,
  /external\s+(service|api|data\s+source)/i, /\bSDN\b/, /\bvia\s+api\b/i,
];
const EXTERNAL_CLAIM_NEGATION = /\b(does not|do not|doesn't|don't|never|no external|without calling|not currently|not itself)\b/i;
const CODE_EXTERNAL_EVIDENCE = [
  /require\(\s*['"](?:axios|node-fetch|https?)['"]\s*\)/, /\bfetch\(/,
  /\baxios\s*\./, /\bhttps?\.request\(/, /\bhttps?\.get\(/,
];

function check2_6() {
  for (const agent of REQUIRED_AGENTS) {
    const manifestPath = path.join(AGENTS_DIR, agent, 'manifest.json');
    const indexPath    = path.join(AGENTS_DIR, agent, 'index.js');
    if (!fs.existsSync(manifestPath) || !fs.existsSync(indexPath)) continue;

    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
    catch (e) { record('2.6', 'fail', `${agent}: manifest.json parse error — ${e.message}`); continue; }

    const desc = manifest.description || '';
    // Sentence-level so a negated claim ("Does NOT call any external...
    // API or watchlist") doesn't trip the same trigger words it's using
    // to honestly document the absence of that capability.
    const sentences = desc.split(/(?<=[.!?])\s+/);
    const claimingSentences = sentences.filter(s =>
      EXTERNAL_CLAIM_PATTERNS.some(p => p.test(s)) && !EXTERNAL_CLAIM_NEGATION.test(s)
    );

    if (claimingSentences.length === 0) {
      record('2.6', 'pass', `${agent}: manifest makes no unverified external-data-source claim`);
      continue;
    }

    const code = fs.readFileSync(indexPath, 'utf8');
    const hasExternalCall = CODE_EXTERNAL_EVIDENCE.some(p => p.test(code));
    if (hasExternalCall) {
      record('2.6', 'pass', `${agent}: manifest claims an external source and index.js actually calls out (fetch/axios/http)`);
    } else {
      record('2.6', 'fail', `${agent}: manifest claims an external data source ("${claimingSentences[0].trim()}") but index.js contains no external HTTP call — general form of CLOSE-GAP-24/25`);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════
// 2.7 — GATE ALLOWLIST/BLOCKLIST PATTERN (CLOSE-GAP-28)
// ═════════════════════════════════════════════════════════════════════════
//
// General form of CLOSE-GAP-27 (kyc_verification's OFAC check enumerated
// bad statuses and passed everything else, including 'clear', by
// omission). A gate checker that names only the bad value(s) trusts every
// unknown/future value by default; one that names the good value(s) and
// blocks everything else does not. Count-based checks (=== 0) and truthy
// negations (!x) are inherently allowlist-shaped and not flagged --
// there's no "unknown future good count" the way there is for a status
// enum gaining a new value nobody taught the gate about.
function check2_7() {
  const src = readIfExists(SERVICES_PIPELINE_FILE);
  if (!src) { record('2.7', 'warn', 'Could not read pipeline.js — gate pattern check skipped'); return; }

  const startMarker = 'const GATE_REQUIREMENTS = {';
  const start = src.indexOf(startMarker);
  if (start === -1) { record('2.7', 'warn', 'GATE_REQUIREMENTS not found — gate pattern check skipped'); return; }
  let depth = 0, i = start + startMarker.length - 1, end = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const body = src.slice(start, end + 1);

  // Split into per-gate blocks: `name: async (...) => { ... }`. Gates
  // written as `name: async () => []` (rejected/on_hold -- no data
  // precondition, checkRoleAuthority is the real control) have no brace
  // body and are intentionally not matched here; there is nothing in them
  // to classify.
  const gateStartPattern = /(\w+):\s*async\s*\([^)]*\)\s*=>\s*\{/g;
  const starts = [];
  let gm;
  while ((gm = gateStartPattern.exec(body)) !== null) {
    starts.push({ name: gm[1], bodyStart: gm.index + gm[0].length - 1 });
  }

  for (const { name, bodyStart } of starts) {
    let d = 0, j = bodyStart, gEnd = -1;
    for (; j < body.length; j++) {
      if (body[j] === '{') d++;
      if (body[j] === '}') { d--; if (d === 0) { gEnd = j; break; } }
    }
    const text = body.slice(bodyStart, gEnd + 1);

    // Direct, brace-less `if (<cond>) errors.push(` -- the shape a
    // one-line blocklist condition takes in this codebase. Conditions
    // wrapped in a block (multi-condition `if (...) { errors.push(...); }`
    // or a satisfied-flag guard like `if (!satisfied) { errors.push(...); }`)
    // are deliberately not matched by this brace-less pattern -- the flag-
    // guard idiom is exactly the allowlist shape CLOSE-GAP-27 introduced,
    // and is correctly invisible to a check looking for direct pushes.
    const directPushes = [...text.matchAll(/if\s*\(([^)]*?)\)\s*errors\.push/g)].map(m => m[1].trim());

    const blocklistHits = [];
    for (const cond of directPushes) {
      if (/!==/.test(cond)) continue;                 // negated equality: allowlist-shaped
      if (/!\s*[\w.]/.test(cond)) continue;            // truthy negation: allowlist-shaped
      if (/===\s*0\b/.test(cond)) continue;            // count-based: not a status field
      const eqMatch = cond.match(/[\w.\[\]?]+\s*===\s*'[^']*'/);
      if (eqMatch) blocklistHits.push(cond);
    }

    if (blocklistHits.length > 0) {
      record('2.7', 'fail', `${name}: blocklist pattern — enumerates bad value(s) (${blocklistHits.join('; ')}) and passes any other value by omission, including unknown/future values. Rewrite as an allowlist: name the good value(s) explicitly and block everything else by default.`);
    } else {
      record('2.7', 'pass', `${name}: allowlist pattern (or no status-literal comparisons to evaluate)`);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════
// 2.8 — GATE-BEARING STATE MACHINE ADJACENCY (CLOSE-GAP-30)
// ═════════════════════════════════════════════════════════════════════════
//
// General form: advancePipeline() previously checked role authority and
// the TARGET stage's own GATE_REQUIREMENTS entry, but never verified
// to_stage was actually reachable from from_stage -- an asset could jump
// directly from intake to tokenization, skipping every intermediate
// gate, as long as the target's own narrow condition happened to be
// satisfiable (confirmed live by a test before the fix -- see
// tests/gates.stagejump.test.js history). Any gate-bearing state machine
// with per-stage checks but no adjacency constraint has the same shape
// of bug: stage-local correctness does not imply sequence-level
// correctness.
//
// This codebase has exactly one such state machine (STAGES/
// GATE_REQUIREMENTS/advancePipeline() in api/services/pipeline.js), so
// this check is necessarily specific to it rather than a generic
// state-machine-detector across arbitrary source -- flagged honestly
// rather than overclaiming broader coverage. It verifies the actual fix
// is present and hasn't regressed: advancePipeline() must call an
// isValidTransition()-shaped guard, using from_stage, before the DB
// mutation that writes pipeline_stage.
function check2_8() {
  const src = readIfExists(SERVICES_PIPELINE_FILE);
  if (!src) { record('2.8', 'warn', 'Could not read pipeline.js — state-machine adjacency check skipped'); return; }

  const fnMatch = src.match(/async function advancePipeline\([^)]*\)\s*\{([\s\S]*?)\n\}/);
  if (!fnMatch) { record('2.8', 'fail', 'advancePipeline() not found — cannot verify adjacency enforcement is present'); return; }
  const body = fnMatch[1];

  const callsGuard = /isValidTransition\s*\(\s*from_stage/.test(body);
  const guardDefined = /function\s+isValidTransition\s*\(/.test(src);
  const mutatesBeforeGuard = (() => {
    const guardIdx = body.search(/isValidTransition\s*\(/);
    const mutateIdx = body.search(/UPDATE\s+pcm_assets\s+SET\s+pipeline_stage/i);
    if (guardIdx === -1 || mutateIdx === -1) return mutateIdx !== -1; // mutation with no guard at all -> true (bad)
    return mutateIdx < guardIdx;
  })();

  if (guardDefined && callsGuard && !mutatesBeforeGuard) {
    record('2.8', 'pass', 'advancePipeline() calls isValidTransition(from_stage, ...) before mutating pipeline_stage — sequential adjacency enforced');
  } else {
    record('2.8', 'fail', `advancePipeline() does not verifiably enforce stage adjacency before mutation (guardDefined=${guardDefined}, callsGuard=${callsGuard}, mutatesBeforeGuard=${mutatesBeforeGuard}) — a direct multi-stage jump may be reachable again. See CLOSE-GAP-30.`);
  }
}

// ═════════════════════════════════════════════════════════════════════════
// MAIN
// ═════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  CoreIdentity PCM — Reachability Validator            ║');
  console.log(`║  Mode: ${ENFORCE ? 'ENFORCE' : 'WARN'}`.padEnd(56) + '║');
  console.log('╚══════════════════════════════════════════════════════╝');

  // Basic scaffold presence, kept from the original check — still a real
  // precondition for everything below.
  for (const agent of REQUIRED_AGENTS) {
    const dir = path.join(AGENTS_DIR, agent);
    if (!fs.existsSync(path.join(dir, 'index.js')) || !fs.existsSync(path.join(dir, 'manifest.json'))) {
      record('scaffold', 'fail', `${agent}: index.js or manifest.json missing`);
    }
  }

  console.log('\n── 2.1 Manifest truth ──────────────────────────────────');
  check2_1();
  console.log('\n── 2.2 Gate-bound column guard ─────────────────────────');
  check2_2();
  console.log('\n── 2.3 Declared property reachability ──────────────────');
  check2_3();
  console.log('\n── 2.4 Schema truth ─────────────────────────────────────');
  await check2_4();
  console.log('\n── 2.5 Deployment drift (advisory) ─────────────────────');
  check2_5();
  console.log('\n── 2.6 Manifest external-source truth ──────────────────');
  check2_6();
  console.log('\n── 2.7 Gate allowlist/blocklist pattern ────────────────');
  check2_7();
  console.log('\n── 2.8 State-machine adjacency (CLOSE-GAP-30) ──────────');
  check2_8();

  for (const r of results) {
    const icon = r.level === 'pass' ? '✓' : r.level === 'warn' ? '⚠' : '✗';
    console.log(`  [${r.section}] ${icon} ${r.message}`);
  }

  const fails = results.filter(r => r.level === 'fail');
  const warns = results.filter(r => r.level === 'warn');
  const passes = results.filter(r => r.level === 'pass');

  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log(`║  ${passes.length} pass, ${warns.length} warn, ${fails.length} fail`.padEnd(56) + '║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');

  if (ENFORCE && fails.length > 0) {
    console.error(`ENFORCE mode: ${fails.length} failure(s) — build failed.`);
    process.exit(1);
  }
  if (!ENFORCE && fails.length > 0) {
    console.warn(`WARN mode: ${fails.length} finding(s) would fail the build once VALIDATE_AGENTS_ENFORCE=true is set (Phase 6.2). Not failing the build now.`);
  }
}

main().catch(err => {
  console.error('Validator crashed:', err);
  process.exit(ENFORCE ? 1 : 0);
});
