#!/usr/bin/env node
/**
 * CLOSE-GAP-12: Gate completeness — default-deny, missing entries, system
 * gate_role stops meaning auto-authorize, fail-closed error semantics
 *
 * Target: api/services/pipeline.js only.
 *
 * Four independent changes, each idempotent on its own marker:
 *
 *   Change 1 (marker CLOSE-GAP-12-C1): validateGate() throws when
 *   GATE_REQUIREMENTS has no entry for the target stage, instead of
 *   returning []. Absence of a gate requirement is never a pass.
 *
 *   Change 2 (marker CLOSE-GAP-12-C2): adds GATE_REQUIREMENTS entries for
 *   'tokenization' and 'completed' — the two stages that previously had
 *   none. Conditions are reused verbatim from existing patterns, not
 *   invented:
 *     - tokenization: same query + condition shape as the existing
 *       bank_assignment checker (valuation must exist with
 *       date_validation_status = 'passed'). This is not a new rule — it is
 *       the precondition triggerTokenization() already silently requires
 *       today (it no-ops if no passed valuation exists); this makes that
 *       existing requirement an explicit, enforced gate instead of a
 *       silent skip.
 *     - completed: same "asset column must be set" shape as the existing
 *       collateralization checker's bank_assignment check, applied to
 *       pcm_assets.token_id (set by triggerTokenization() when a token is
 *       actually minted).
 *
 *   Change 3 (marker CLOSE-GAP-12-C3): checkRoleAuthority() no longer
 *   auto-authorizes gate_role === 'system'. It now requires a systemCheck
 *   argument evidencing a recorded, passed result; no argument or an
 *   unevaluated/failed result blocks. Human-role hierarchy logic is
 *   untouched — same lines, same order, same outcomes.
 *
 *   Change 4 (marker CLOSE-GAP-12-C4): advancePipeline() evaluates the
 *   gate first (in a try/catch), builds the systemCheck evidence for
 *   system-gated stages from that same evaluation (no duplicate query),
 *   and every error path returns a block_reason of 'blocked_error'
 *   (the check itself failed/threw) or 'blocked_pending' (the check ran
 *   and found unmet conditions) — no log-and-continue anywhere on this
 *   path.
 *
 * Known side effect, not fixed here (out of scope for this script — this
 * script touches api/services/pipeline.js only): validateGate() is also
 * called from api/routes/pipeline.js's POST /validate preflight route and
 * from getPipelineStatus()'s next-stage preview. After Change 1, either of
 * those will throw (surfacing as a route-level 500 via next(err)) if ever
 * asked to evaluate a stage with no GATE_REQUIREMENTS entry. After Change 2
 * this cannot happen for any stage reachable in normal forward progression
 * (all of intake through completed now have entries); it would only occur
 * for a genuinely unknown/typo'd stage string, which is the correct
 * failure mode to surface loudly rather than mask.
 *
 * No database access of any kind — this script only edits a source file
 * and runs `npm run build` (validate-agents.js, which does not touch a
 * database). No git push.
 *
 * Idempotent: each of the four changes is detected independently by its
 * own marker. Re-running after a full apply reports all four as
 * already-applied and exits 0 without touching the file or running the
 * build. A partially-applied file (some markers present, some not) is
 * treated as an inconsistent state and aborts rather than guessing.
 *
 * Preconditions (checked before any write; any failure aborts with no
 * changes made):
 *   1. CLOSE-GAP-11 is applied (api/routes/assets.js POST /:id/advance
 *      returns 410) — the unguarded second advance path must already be
 *      closed before tightening the guarded one.
 *   2. api/services/pipeline.js still has the GATE_REQUIREMENTS /
 *      checkRoleAuthority / validateGate / advancePipeline shapes Phase 0
 *      documented (checked structurally, not by requiring the specific
 *      lines this script itself removes — so a prior partial or full
 *      application of this same script does not fail this check).
 *   3. Only evaluated when a write is actually about to happen (i.e. not
 *      all four markers are already present): api/services/pipeline.js has
 *      no unstaged git changes. It is not one of the files with known
 *      prior-session hunks, so any diff here means something unexpected
 *      touched it and this script refuses to write on top of it.
 *
 * Ends with: npm run build
 *
 * Run: node scripts/close-gap-12-gate-completeness.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO_ROOT     = path.join(__dirname, '..');
const ASSETS_ROUTE  = path.join(REPO_ROOT, 'api', 'routes', 'assets.js');
const TARGET        = path.join(REPO_ROOT, 'api', 'services', 'pipeline.js');

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

// ─── PRECONDITIONS ─────────────────────────────────────────────────────────

function checkPrecondition1_gap11Applied() {
  if (!fs.existsSync(ASSETS_ROUTE)) {
    fail(`Precondition 1 failed: ${ASSETS_ROUTE} not found.`);
  }
  const contents = fs.readFileSync(ASSETS_ROUTE, 'utf8');
  if (!contents.includes('CLOSE-GAP-11')) {
    fail(
      'Precondition 1 failed: CLOSE-GAP-11 does not appear applied in ' +
      'api/routes/assets.js — POST /:id/advance must already return 410 ' +
      'before this script tightens the guarded advance path. Run ' +
      'scripts/close-gap-11-remove-unguarded-advance.js first.'
    );
  }
  console.log('  ✓ Precondition 1: CLOSE-GAP-11 applied (api/routes/assets.js returns 410)');
}

function checkPrecondition2_shape(contents) {
  const required = [
    'const GATE_REQUIREMENTS = {',
    'kyc_verification: async (asset_id, client_id) => {',
    'appraisal_review: async (asset_id, client_id) => {',
    'bank_assignment: async (asset_id, client_id) => {',
    'collateralization: async (asset_id, client_id) => {',
    'monetization: async (asset_id, client_id) => {',
    'securitization: async (asset_id, client_id) => {',
    'function checkRoleAuthority(to_stage, user_role',
    'async function validateGate(to_stage, asset_id, client_id) {',
    'async function advancePipeline({ asset_id, client_id, to_stage, user, notes }) {',
    "tokenization:     { order: 8, gate_role: 'system',            label: 'Tokenization' },",
    "completed:        { order: 9, gate_role: 'system',            label: 'Completed' },"
  ];
  const missing = required.filter(s => !contents.includes(s));
  if (missing.length > 0) {
    fail(
      'Precondition 2 failed: api/services/pipeline.js does not match the ' +
      'GATE_REQUIREMENTS / checkRoleAuthority / validateGate / ' +
      'advancePipeline / STAGES shapes Phase 0 documented. Missing:\n' +
      missing.map(s => `      - ${s}`).join('\n') +
      '\n  File may have changed since this script was written. Manual review required.'
    );
  }
  console.log('  ✓ Precondition 2: api/services/pipeline.js matches the documented Phase 0 shape');
}

function checkPrecondition3_cleanWorkingTree() {
  let statusOut;
  try {
    statusOut = execSync(
      `git status --porcelain -- ${JSON.stringify(path.relative(REPO_ROOT, TARGET))}`,
      { cwd: REPO_ROOT, encoding: 'utf8' }
    );
  } catch (err) {
    fail(`Precondition 3 failed: could not run git status on api/services/pipeline.js — ${err.message}`);
  }
  if (statusOut.trim().length > 0) {
    fail(
      'Precondition 3 failed: api/services/pipeline.js has unstaged changes ' +
      'and is not one of the files with known prior-session hunks. Refusing ' +
      'to write on top of an unexpected modification. Review or commit/stash ' +
      'the existing change, then re-run.\n' +
      `  git status output:\n${statusOut}`
    );
  }
  console.log('  ✓ Precondition 3: api/services/pipeline.js has no unstaged changes');
}

// ─── CHANGE 1 — default-deny on gate lookup ────────────────────────────────

const C1_MARKER = 'CLOSE-GAP-12-C1';

const C1_OLD = `// ─── VALIDATE GATE ────────────────────────────────────────────────────────────
async function validateGate(to_stage, asset_id, client_id) {
  const checker = GATE_REQUIREMENTS[to_stage];
  if (!checker) return [];
  return await checker(asset_id, client_id);
}`;

const C1_NEW = `// ─── VALIDATE GATE ────────────────────────────────────────────────────────────
async function validateGate(to_stage, asset_id, client_id) {
  const checker = GATE_REQUIREMENTS[to_stage];
  if (!checker) {
    // ${C1_MARKER}: absence of a gate requirement is never a pass. A stage
    // with no entry here must block, not silently succeed.
    throw new Error(\`No gate definition exists for stage '\${to_stage}' — refusing to advance. Absence of a gate requirement is never a pass.\`);
  }
  return await checker(asset_id, client_id);
}`;

// ─── CHANGE 2 — add the missing tokenization / completed entries ──────────

const C2_MARKER = 'CLOSE-GAP-12-C2';

const C2_OLD = `  securitization: async (asset_id, client_id) => {
    const icc = await db.forms.query(
      \`SELECT COUNT(*) FROM pcm_agreements
       WHERE asset_id = $1 AND agreement_type = 'icc_agreement'
       AND status = 'fully_executed'\`, [asset_id]
    );
    const errors = [];
    if (parseInt(icc.rows[0].count) === 0) errors.push('ICC Agreement not fully executed');
    return errors;
  }
};`;

const C2_NEW = `  securitization: async (asset_id, client_id) => {
    const icc = await db.forms.query(
      \`SELECT COUNT(*) FROM pcm_agreements
       WHERE asset_id = $1 AND agreement_type = 'icc_agreement'
       AND status = 'fully_executed'\`, [asset_id]
    );
    const errors = [];
    if (parseInt(icc.rows[0].count) === 0) errors.push('ICC Agreement not fully executed');
    return errors;
  },

  // ${C2_MARKER}: previously no entry existed for 'tokenization' — absence
  // meant validateGate() returned [] (pass) and checkRoleAuthority()
  // auto-authorized any caller. Condition reused from the existing
  // bank_assignment checker's pattern: a valuation with
  // date_validation_status = 'passed' must exist. This is not a new rule —
  // triggerTokenization() already requires exactly this and silently
  // no-ops without it; this makes that existing requirement an explicit,
  // enforced gate instead of a silent skip.
  tokenization: async (asset_id, client_id) => {
    const val = await db.assets.query(
      \`SELECT date_validation_status FROM pcm_valuations
       WHERE asset_id = $1 ORDER BY created_at DESC LIMIT 1\`, [asset_id]
    );
    const errors = [];
    if (!val.rows.length) errors.push('No valuation on file');
    if (val.rows[0]?.date_validation_status !== 'passed') errors.push('Valuation date validation not passed');
    return errors;
  },

  // ${C2_MARKER}: previously no entry existed for 'completed' — same gap as
  // tokenization above. Condition reused from the existing
  // collateralization checker's pattern (an asset column must be set):
  // pcm_assets.token_id must be populated, which triggerTokenization() sets
  // only when a classification token was actually minted.
  completed: async (asset_id, client_id) => {
    const asset = await db.assets.query(
      \`SELECT token_id FROM pcm_assets WHERE asset_id = $1\`, [asset_id]
    );
    const errors = [];
    if (!asset.rows[0]?.token_id) errors.push('No classification token minted for this asset');
    return errors;
  }
};`;

// ─── CHANGE 3 — system gate_role stops meaning auto-authorize ─────────────

const C3_MARKER = 'CLOSE-GAP-12-C3';

const C3_OLD = `// ─── CHECK ROLE AUTHORITY ─────────────────────────────────────────────────────
function checkRoleAuthority(to_stage, user_role) {
  const stage = STAGES[to_stage];
  if (!stage) return { authorized: false, reason: \`Unknown stage: \${to_stage}\` };
  if (stage.gate_role === 'system') return { authorized: true };

  const hierarchy = { trade_group_owner: 3, program_manager: 2, intake_officer: 1, system: 0 };
  const required  = hierarchy[stage.gate_role] || 0;
  const current   = hierarchy[user_role] || 0;

  if (current < required) {
    return {
      authorized: false,
      reason: \`Stage '\${to_stage}' requires role '\${stage.gate_role}' or higher. Current role: '\${user_role}'\`
    };
  }
  return { authorized: true };
}`;

const C3_NEW = `// ─── CHECK ROLE AUTHORITY ─────────────────────────────────────────────────────
// ${C3_MARKER}: gate_role === 'system' no longer auto-authorizes. It means
// the system's own gate check (GATE_REQUIREMENTS[to_stage], evaluated by
// the caller and passed in as systemCheck) must have run and recorded a
// pass. No recorded result — systemCheck missing or not evaluated — blocks,
// same as a failed one. Human-role hierarchy logic below is unchanged.
function checkRoleAuthority(to_stage, user_role, systemCheck) {
  const stage = STAGES[to_stage];
  if (!stage) return { authorized: false, reason: \`Unknown stage: \${to_stage}\` };

  if (stage.gate_role === 'system') {
    if (!systemCheck || systemCheck.evaluated !== true) {
      return {
        authorized: false,
        reason: \`Stage '\${to_stage}' is system-gated and requires a recorded system check result before authorization; none was provided.\`
      };
    }
    if (!systemCheck.passed) {
      return {
        authorized: false,
        reason: \`Stage '\${to_stage}' is system-gated and the recorded system check did not pass.\`
      };
    }
    return { authorized: true };
  }

  const hierarchy = { trade_group_owner: 3, program_manager: 2, intake_officer: 1, system: 0 };
  const required  = hierarchy[stage.gate_role] || 0;
  const current   = hierarchy[user_role] || 0;

  if (current < required) {
    return {
      authorized: false,
      reason: \`Stage '\${to_stage}' requires role '\${stage.gate_role}' or higher. Current role: '\${user_role}'\`
    };
  }
  return { authorized: true };
}`;

// ─── CHANGE 4 — fail-closed error semantics on the whole path ─────────────

const C4_MARKER = 'CLOSE-GAP-12-C4';

const C4_OLD = `// ─── ADVANCE PIPELINE ─────────────────────────────────────────────────────────
async function advancePipeline({ asset_id, client_id, to_stage, user, notes }) {
  // 1. Role authority check
  const auth = checkRoleAuthority(to_stage, user.role);
  if (!auth.authorized) {
    return { success: false, code: 403, error: auth.reason };
  }

  // 2. Gate requirements check
  const gateErrors = await validateGate(to_stage, asset_id, client_id);
  if (gateErrors.length > 0) {
    return { success: false, code: 422, error: 'Gate requirements not met', gate_errors: gateErrors };
  }

  // 3. Get current stages`;

const C4_NEW = `// ─── ADVANCE PIPELINE ─────────────────────────────────────────────────────────
// ${C4_MARKER}: fail-closed on the whole path. The gate is evaluated first,
// inside a try/catch — any error or timeout (including the "no gate
// definition" throw from validateGate()) blocks immediately with
// block_reason 'blocked_error'. A gate that ran cleanly but found unmet
// conditions blocks with block_reason 'blocked_pending'. No branch here
// logs and continues past a failure. For system-gated stages, this same
// evaluation becomes the recorded systemCheck result checkRoleAuthority()
// requires — evaluated once, not queried twice.
async function advancePipeline({ asset_id, client_id, to_stage, user, notes }) {
  const stage = STAGES[to_stage];
  if (!stage) {
    return { success: false, code: 400, error: \`Unknown stage: \${to_stage}\`, block_reason: 'blocked_error' };
  }

  let systemCheck;
  if (stage.gate_role === 'system') {
    try {
      const errors = await validateGate(to_stage, asset_id, client_id);
      systemCheck = { evaluated: true, passed: errors.length === 0, errors };
    } catch (err) {
      return { success: false, code: 422, error: err.message, block_reason: 'blocked_error' };
    }
  }

  // 1. Role authority check (unchanged for human-gated stages)
  const auth = checkRoleAuthority(to_stage, user.role, systemCheck);
  if (!auth.authorized) {
    return {
      success: false, code: 403, error: auth.reason,
      block_reason: (systemCheck && !systemCheck.passed) ? 'blocked_pending' : undefined
    };
  }

  // 2. Gate requirements check
  let gateErrors;
  try {
    gateErrors = systemCheck ? systemCheck.errors : await validateGate(to_stage, asset_id, client_id);
  } catch (err) {
    return { success: false, code: 422, error: err.message, block_reason: 'blocked_error' };
  }
  if (gateErrors.length > 0) {
    return { success: false, code: 422, error: 'Gate requirements not met', block_reason: 'blocked_pending', gate_errors: gateErrors };
  }

  // 3. Get current stages`;

// ─── MAIN ───────────────────────────────────────────────────────────────────

function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  CLOSE-GAP-12 — Gate Completeness                    ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');

  console.log('Preconditions:');
  checkPrecondition1_gap11Applied();

  if (!fs.existsSync(TARGET)) {
    fail(`Target file not found: ${TARGET}`);
  }
  const original = fs.readFileSync(TARGET, 'utf8');
  checkPrecondition2_shape(original);

  const alreadyApplied = {
    C1: original.includes(C1_MARKER),
    C2: original.includes(C2_MARKER),
    C3: original.includes(C3_MARKER),
    C4: original.includes(C4_MARKER)
  };

  if (alreadyApplied.C1 && alreadyApplied.C2 && alreadyApplied.C3 && alreadyApplied.C4) {
    console.log('');
    console.log('✓ CLOSE-GAP-12 already fully applied — no-op.');
    console.log('  Change 1 (default-deny on gate lookup):        already applied');
    console.log('  Change 2 (tokenization/completed entries):     already applied');
    console.log('  Change 3 (system gate_role auto-authorize):    already applied');
    console.log('  Change 4 (fail-closed error semantics):        already applied');
    return;
  }

  const someApplied = alreadyApplied.C1 || alreadyApplied.C2 || alreadyApplied.C3 || alreadyApplied.C4;
  if (someApplied) {
    fail(
      'File is in a partially-applied state: ' +
      `C1=${alreadyApplied.C1} C2=${alreadyApplied.C2} C3=${alreadyApplied.C3} C4=${alreadyApplied.C4}. ` +
      'Refusing to guess which changes are safe to (re)apply. Manual review required.'
    );
  }

  // Nothing applied yet and we're about to write — now enforce precondition 3.
  checkPrecondition3_cleanWorkingTree();

  let updated = original;
  const report = [];

  if (!updated.includes(C1_OLD)) {
    fail('Expected validateGate() block not found — file may have changed since this script was written. Manual review required.');
  }
  updated = updated.replace(C1_OLD, C1_NEW);
  report.push('Change 1 (default-deny on gate lookup):        applied');

  if (!updated.includes(C2_OLD)) {
    fail('Expected securitization/closing-brace block not found — file may have changed since this script was written. Manual review required.');
  }
  updated = updated.replace(C2_OLD, C2_NEW);
  report.push('Change 2 (tokenization/completed entries):     applied');

  if (!updated.includes(C3_OLD)) {
    fail('Expected checkRoleAuthority() block not found — file may have changed since this script was written. Manual review required.');
  }
  updated = updated.replace(C3_OLD, C3_NEW);
  report.push('Change 3 (system gate_role auto-authorize):    applied');

  if (!updated.includes(C4_OLD)) {
    fail('Expected advancePipeline() block not found — file may have changed since this script was written. Manual review required.');
  }
  updated = updated.replace(C4_OLD, C4_NEW);
  report.push('Change 4 (fail-closed error semantics):        applied');

  fs.writeFileSync(TARGET, updated, 'utf8');

  console.log('');
  console.log('✓ CLOSE-GAP-12 applied:');
  report.forEach(line => console.log(`  ${line}`));

  console.log('\nRunning npm run build...');
  execSync('npm run build', { cwd: REPO_ROOT, stdio: 'inherit' });
}

main();
