'use strict';

const db         = require('./db');
const governance = require('./governance');
const { normalizeRole, isAdministrator } = require('../middleware/authorize');

// ─── PIPELINE STAGE DEFINITIONS ───────────────────────────────────────────────
// gate_roles: explicit permission sets, not a >= hierarchy (2026-08-17
// access-control redesign) -- replaces the old single gate_role + numeric
// hierarchy lookup. Administrator is not listed per-row: it passes every
// gate by definition (see checkRoleAuthority below), same convention as
// authorize.js. 'system' stages (tokenization/completed) are unchanged --
// automated, gated on a recorded system check result, not a human role.
const STAGES = {
  intake:           { order: 1, gate_roles: ['intake_officer'],  label: 'Intake and Document Receipt' },
  kyc_verification: { order: 2, gate_roles: ['intake_officer'],  label: 'KYC / CIS / POF Verification' },
  appraisal_review: { order: 3, gate_roles: ['program_manager'], label: 'Appraisal / Valuation Review' },
  bank_assignment:  { order: 4, gate_roles: [],                  label: 'Trader Bank Assignment' },   // Administrator only
  collateralization:{ order: 5, gate_roles: [],                  label: 'Collateralization' },        // Administrator only
  monetization:     { order: 6, gate_roles: ['program_manager'], label: 'Monetization' },
  securitization:   { order: 7, gate_roles: ['program_manager'], label: 'Securitization' },
  tokenization:     { order: 8, gate_roles: ['system'],          label: 'Tokenization' },
  completed:        { order: 9, gate_roles: ['system'],          label: 'Completed' },
  rejected:         { order: 0, gate_roles: [],                  label: 'Rejected' },                 // Administrator only
  on_hold:          { order: 0, gate_roles: ['program_manager'], label: 'On Hold' }
};

// CLOSE-GAP-30: sequential-stage-order enforcement, previously absent
// entirely. Reads order from STAGES above -- the same source
// GATE_REQUIREMENTS keys off -- not a second ordering. See this script's
// header (scripts/close-gap-30-sequential-stage-order.js) for the full
// design rationale (why rejected/on_hold are any-stage exits, why
// on_hold's return is the one narrow exception, why all other backward
// moves are blocked outright).
function isValidTransition(from_stage, to_stage, priorStageBeforeHold) {
  if (to_stage === 'rejected') {
    return from_stage !== 'rejected' && from_stage !== 'completed';
  }
  if (to_stage === 'on_hold') {
    return from_stage !== 'rejected' && from_stage !== 'completed' && from_stage !== 'on_hold';
  }
  if (from_stage === 'on_hold') {
    return priorStageBeforeHold != null && to_stage === priorStageBeforeHold;
  }
  if (from_stage === 'rejected') {
    return false; // terminal -- no transitions out
  }
  const fromOrder = STAGES[from_stage]?.order;
  const toOrder   = STAGES[to_stage]?.order;
  if (fromOrder == null || toOrder == null) return false;
  return toOrder === fromOrder + 1;
}

// ─── GATE REQUIREMENTS PER STAGE ──────────────────────────────────────────────
const GATE_REQUIREMENTS = {
  kyc_verification: async (asset_id, client_id) => {
    const kyc = await db.clients.query(
      `SELECT COUNT(*) FROM pcm_kyc_documents
       WHERE client_id = $1 AND vault_status = 'active'`, [client_id]
    );
    const pof = await db.clients.query(
      `SELECT COUNT(*) FROM pcm_pof_records
       WHERE client_id = $1 AND vault_status = 'active'`, [client_id]
    );
    const ofac = await db.clients.query(
      `SELECT ofac_status FROM pcm_clients WHERE client_id = $1`, [client_id]
    );
    const errors = [];
    if (parseInt(kyc.rows[0].count) === 0) errors.push('No KYC documents on file');
    if (parseInt(pof.rows[0].count) === 0) errors.push('No Proof of Funds on file');

    // CLOSE-GAP-27: allowlist, not blocklist. Enumerating only the bad
    // values previously let 'clear' -- an unauthoritative heuristic
    // result -- pass with zero human involvement. See CLOSE-GAP-25/26 and
    // db/migrations/0001-ofac-status-not-authoritative.sql.
    //
    // SDN screening design (docs/SDN-Sanctions-Screening-Design.md):
    // 'clear' is now a third independently-verified state, alongside the
    // two dual-control states below -- the real exact/near-exact engine
    // (agents/ofac-screening/index.js) can produce an authoritative clear
    // without a human in the loop, which is the whole point of piece 4
    // (dual-control becomes the exception path, not the routine one).
    // Re-verified against pcm_ofac_results directly, same discipline as
    // the other two branches -- NOT trusted from the status column alone,
    // because a stale 'clear' can still exist on a row screened before
    // this engine existed (the CLOSE-GAP-25 migration note documents
    // exactly one such row). Only a 'clear' actually produced by the real
    // engine (provider + a real match_method, not a legacy/unknown one)
    // satisfies the gate.
    const ofacStatus = ofac.rows[0]?.ofac_status;
    let ofacSatisfied = false;

    if (ofacStatus === 'manual_review') {
      // Genuinely flagged by the engine, dual-control override.
      const override = await db.clients.query(
        `SELECT review_outcome FROM pcm_ofac_results
         WHERE client_id = $1 AND provider = 'MANUAL_OVERRIDE'
         ORDER BY screened_at DESC LIMIT 1`, [client_id]
      );
      ofacSatisfied = override.rows[0]?.review_outcome === 'MANUAL_OVERRIDE_CONFIRMED';
    } else if (ofacStatus === 'attested_out_of_band') {
      // Engine could not authoritatively screen (e.g. a freshness block),
      // but a real out-of-band screen was performed and dual-control
      // attested.
      const attestation = await db.clients.query(
        `SELECT review_outcome FROM pcm_ofac_results
         WHERE client_id = $1 AND provider = 'OUT_OF_BAND_ATTESTATION'
         ORDER BY screened_at DESC LIMIT 1`, [client_id]
      );
      ofacSatisfied = attestation.rows[0]?.review_outcome === 'ATTESTATION_CONFIRMED';
    } else if (ofacStatus === 'clear') {
      const cleared = await db.clients.query(
        `SELECT match_method FROM pcm_ofac_results
         WHERE client_id = $1 AND provider = 'SDN-ENGINE-EXACT-NEAR-EXACT-V1' AND status = 'clear'
         ORDER BY screened_at DESC LIMIT 1`, [client_id]
      );
      ofacSatisfied = ['exact', 'near_exact'].includes(cleared.rows[0]?.match_method);
    }

    if (!ofacSatisfied) {
      errors.push(`OFAC screening not satisfied (status: ${ofacStatus || 'none'}) — requires an authoritative real-engine clear result, a confirmed dual-control override (engine flagged a match), or a confirmed out-of-band attestation (engine could not authoritatively screen)`);
    }

    // Legal review, 2026-08-17 access-control redesign (corrected
    // 2026-08-17, same day -- legal also assigns a handler, not just
    // reviews): counsel is internal to the platform owners but external
    // to CoreG, has no portal account, and never performs the review
    // inside this system -- the platform only records that it happened
    // (see pcm_legal_attestations / api/routes/assets.js's
    // legal-attestation routes). Asset-scoped, not just client-scoped --
    // assignment is by asset type, so a client with multiple assets can
    // route each to a different handler; the lookup narrows to this
    // specific asset, not "any attestation on this client." Distinguishing
    // "no attestation" from "entered but not yet countersigned" here, same
    // as the OFAC branch above distinguishes its own sub-states, rather
    // than collapsing both into one message.
    // outcome checked alongside status (2026-08-17 correction: legal
    // returns a binary approve/deny, not just "reviewed"). A confirmed
    // DENIAL must not satisfy this gate -- in normal operation the
    // countersign route's automatic rejection already moves the asset to
    // 'rejected' before anyone could reach this check again (isValidTransition
    // blocks all forward movement out of 'rejected' unconditionally), but
    // this still fails closed rather than assuming that transition always
    // ran, e.g. if it errored (see assets.js countersign route's handling
    // of that case).
    const legal = await db.clients.query(
      `SELECT status, outcome FROM pcm_legal_attestations
       WHERE client_id = $1 AND asset_id = $2 ORDER BY entered_at DESC LIMIT 1`, [client_id, asset_id]
    );
    const legalRow = legal.rows[0];
    if (!legalRow || legalRow.status !== 'confirmed' || legalRow.outcome !== 'approved') {
      if (legalRow?.status === 'confirmed' && legalRow.outcome === 'denied') {
        errors.push('Legal review denied — package rejected, cannot proceed');
      } else if (legalRow?.status === 'pending_countersign') {
        errors.push('Legal attestation recorded but not yet countersigned by an Administrator');
      } else {
        errors.push('No legal-review attestation on file');
      }
    }

    return errors;
  },

  appraisal_review: async (asset_id, client_id) => {
    const val = await db.assets.query(
      `SELECT COUNT(*), MAX(date_validation_status) as val_status
       FROM pcm_valuations WHERE asset_id = $1`, [asset_id]
    );
    const docs = await db.assets.query(
      `SELECT COUNT(*) FROM pcm_asset_documents
       WHERE asset_id = $1 AND vault_status = 'active'`, [asset_id]
    );
    // CLOSE-GAP-02b: instrument authenticity/fraud-typology gate.
    // Blocks progression until the instrument-integrity agent has cleared
    // this asset. 'pending' (default) and 'blocked' both fail the gate —
    // only 'verified' (set exclusively via human-confirmed independent-channel
    // review, never by the agent alone) passes.
    const integrity = await db.assets.query(
      `SELECT instrument_integrity_status FROM pcm_assets WHERE asset_id = $1`, [asset_id]
    );
    // CLOSE-GAP-31: allowlist, not blocklist (Phase 2 validator 2.7).
    // val_status previously only blocked on the literal 'failed' --
    // 'manual_override' (a real enum value, confirmed live: pending,
    // passed, failed, manual_override) had zero references anywhere in
    // this codebase before this fix, so nothing establishes what it's
    // supposed to mean or how it gets set. Not assuming it deserves a
    // pass -- mirrors the exact allowlist bank_assignment/tokenization
    // already use for this same column: only 'passed' satisfies the
    // gate, everything else (including any future enum value) blocks by
    // default. Same reasoning for instrument_integrity_status: 'verified'
    // is the one human-confirmed-good state (CLOSE-GAP-04's
    // /verify-instrument is the only path that sets it); everything else
    // blocks.
    const errors = [];
    if (parseInt(val.rows[0].count) === 0) errors.push('No valuation or appraisal submitted');
    // Gating condition is the allowlist (!== 'passed'); the specific bad
    // value is only used to pick a more informative message, not to
    // decide pass/fail -- an unrecognized future value still blocks and
    // still gets a real (if generic) message, never silently passes.
    if (val.rows[0].val_status !== 'passed') {
      errors.push(val.rows[0].val_status === 'failed'
        ? 'Same-date validation failed — document dates do not match'
        : 'Same-date validation not passed — document dates do not match, or validation has not completed');
    }
    if (parseInt(docs.rows[0].count) === 0) errors.push('No supporting documents on file');
    const integrityStatus = integrity.rows[0]?.instrument_integrity_status;
    if (integrityStatus !== 'verified') {
      errors.push(integrityStatus === 'blocked'
        ? 'Instrument integrity screening BLOCKED this asset — see pcm_instrument_integrity_results'
        : 'Instrument integrity screening not yet cleared — independent-channel counterparty verification required');
    }
    return errors;
  },

  bank_assignment: async (asset_id, client_id) => {
    const val = await db.assets.query(
      `SELECT date_validation_status FROM pcm_valuations
       WHERE asset_id = $1 ORDER BY created_at DESC LIMIT 1`, [asset_id]
    );
    const errors = [];
    if (!val.rows.length) errors.push('No valuation on file');
    if (val.rows[0]?.date_validation_status !== 'passed') errors.push('Valuation date validation not passed');
    return errors;
  },

  collateralization: async (asset_id, client_id) => {
    const asset = await db.assets.query(
      `SELECT bank_assignment FROM pcm_assets WHERE asset_id = $1`, [asset_id]
    );
    const mfa = await db.forms.query(
      `SELECT COUNT(*) FROM pcm_agreements
       WHERE asset_id = $1 AND agreement_type = 'master_fee_agreement'
       AND status = 'fully_executed'`, [asset_id]
    );
    const imfpa = await db.forms.query(
      `SELECT COUNT(*) FROM pcm_agreements
       WHERE asset_id = $1
       AND agreement_type = 'irrevocable_master_fee_protection_agreement'
       AND status = 'fully_executed'`, [asset_id]
    );
    const errors = [];
    if (!asset.rows[0]?.bank_assignment) errors.push('No trader bank assigned');
    if (parseInt(mfa.rows[0].count) === 0) errors.push('Master Fee Agreement not fully executed');
    if (parseInt(imfpa.rows[0].count) === 0) errors.push('IMFPA not fully executed');
    return errors;
  },

  monetization: async (asset_id, client_id) => {
    const pgl = await db.forms.query(
      `SELECT COUNT(*) FROM pcm_agreements
       WHERE asset_id = $1 AND agreement_type = 'payment_guarantee_letter'
       AND status = 'fully_executed'`, [asset_id]
    );
    const errors = [];
    if (parseInt(pgl.rows[0].count) === 0) errors.push('Payment Guarantee Letter not fully executed');
    return errors;
  },

  securitization: async (asset_id, client_id) => {
    const icc = await db.forms.query(
      `SELECT COUNT(*) FROM pcm_agreements
       WHERE asset_id = $1 AND agreement_type = 'icc_agreement'
       AND status = 'fully_executed'`, [asset_id]
    );
    const errors = [];
    if (parseInt(icc.rows[0].count) === 0) errors.push('ICC Agreement not fully executed');
    return errors;
  },

  // CLOSE-GAP-12-C2: previously no entry existed for 'tokenization' — absence
  // meant validateGate() returned [] (pass) and checkRoleAuthority()
  // auto-authorized any caller. Condition reused from the existing
  // bank_assignment checker's pattern: a valuation with
  // date_validation_status = 'passed' must exist. This is not a new rule —
  // triggerTokenization() already requires exactly this and silently
  // no-ops without it; this makes that existing requirement an explicit,
  // enforced gate instead of a silent skip.
  tokenization: async (asset_id, client_id) => {
    const val = await db.assets.query(
      `SELECT date_validation_status FROM pcm_valuations
       WHERE asset_id = $1 ORDER BY created_at DESC LIMIT 1`, [asset_id]
    );
    const errors = [];
    if (!val.rows.length) errors.push('No valuation on file');
    if (val.rows[0]?.date_validation_status !== 'passed') errors.push('Valuation date validation not passed');
    return errors;
  },

  // CLOSE-GAP-12-C2: previously no entry existed for 'completed' — same gap as
  // tokenization above. Condition reused from the existing
  // collateralization checker's pattern (an asset column must be set):
  // pcm_assets.token_id must be populated, which triggerTokenization() sets
  // only when a classification token was actually minted.
  completed: async (asset_id, client_id) => {
    const asset = await db.assets.query(
      `SELECT token_id FROM pcm_assets WHERE asset_id = $1`, [asset_id]
    );
    const errors = [];
    if (!asset.rows[0]?.token_id) errors.push('No classification token minted for this asset');
    return errors;
  },

  // CLOSE-GAP-21: 'rejected' and 'on_hold' are administrative/terminal
  // stages, not forward-progress gates -- there is no data precondition
  // to check the way kyc_verification/appraisal_review/etc. gate forward
  // movement on evidence. checkRoleAuthority() is the real control for
  // both. Explicit always-pass entries, not a silent gap: before this,
  // the absence of any entry made validateGate() throw (CLOSE-GAP-12-C1's
  // own "no gate definition = block" rule), which made every call to
  // POST /pipeline/reject and POST /pipeline/hold 422 unconditionally.
  rejected: async () => [],
  on_hold:  async () => []
};

// ─── VALIDATE GATE ────────────────────────────────────────────────────────────
async function validateGate(to_stage, asset_id, client_id) {
  const checker = GATE_REQUIREMENTS[to_stage];
  if (!checker) {
    // CLOSE-GAP-12-C1: absence of a gate requirement is never a pass. A stage
    // with no entry here must block, not silently succeed.
    throw new Error(`No gate definition exists for stage '${to_stage}' — refusing to advance. Absence of a gate requirement is never a pass.`);
  }
  return await checker(asset_id, client_id);
}

// ─── CHECK ROLE AUTHORITY ─────────────────────────────────────────────────────
// CLOSE-GAP-12-C3: gate_role === 'system' no longer auto-authorizes. It means
// the system's own gate check (GATE_REQUIREMENTS[to_stage], evaluated by
// the caller and passed in as systemCheck) must have run and recorded a
// pass. No recorded result — systemCheck missing or not evaluated — blocks,
// same as a failed one. Human-role hierarchy logic below is unchanged.
//
// DELIBERATELY SYNCHRONOUS. Assigned-handler access (2026-08-17 legal-
// attestation redesign) needs pcm_assets.assigned_handler_staff_id, which
// looks like it would require this function to become async and take
// asset_id, do its own query. It doesn't: advancePipeline() already
// fetches the asset row before calling this (to check the requested
// transition is structurally valid) -- widening that one existing query
// to also select the two ownership columns and passing them in as
// assetOwnership means this function never touches the DB itself. That
// was a deliberate choice, not an oversight: an async version, called
// from advancePipeline's `const auth = checkRoleAuthority(...)` without
// an added `await`, would assign a Promise to `auth`. `auth.authorized`
// on a Promise is `undefined`, and the call site already checks
// `auth.authorized !== true` below -- so even that specific mistake would
// fail closed (403), not open. But "the bug fails safe if you also get a
// second thing right" is worse than "the bug can't happen," and a
// missed-await defect is exactly the kind of thing that passes every
// test which only exercises the happy path (the broken state still LOOKS
// like a normal object property access, nothing throws) -- see
// tests/access-control-redesign.test.js's explicit regression test for
// this, which calls this function without any await and asserts the
// return value is a plain object, not a thenable, so the question is
// structurally moot rather than merely defended against.
function checkRoleAuthority(to_stage, user, systemCheck, assetOwnership) {
  const stage = STAGES[to_stage];
  if (!stage) return { authorized: false, reason: `Unknown stage: ${to_stage}` };

  if (stage.gate_roles.includes('system')) {
    if (!systemCheck || systemCheck.evaluated !== true) {
      return {
        authorized: false,
        reason: `Stage '${to_stage}' is system-gated and requires a recorded system check result before authorization; none was provided.`
      };
    }
    if (!systemCheck.passed) {
      return {
        authorized: false,
        reason: `Stage '${to_stage}' is system-gated and the recorded system check did not pass.`
      };
    }
    return { authorized: true };
  }

  // Explicit permission set, not a >= hierarchy. Administrator passes
  // every gate by definition (isAdministrator, alias-aware for
  // pre-rename tokens). Additive third path (2026-08-17): the asset's
  // assigned handler (pcm_assets.assigned_handler_staff_id, set at legal-
  // attestation entry) may also act, regardless of this stage's own
  // gate_roles -- "the assigned handler carries the package through to
  // completion." Deliberately additive, not exclusive: this ADDS a path
  // for the handler, it does not remove anyone else's normal gate_roles
  // access (an unassigned Intake Officer can still do kyc_verification
  // work on an asset assigned to a Program Manager). Exclusive ownership
  // was considered and rejected -- see this session's design report:
  // it makes every package a single point of failure and forces
  // reassignment tooling immediately; tightening later is a config
  // change, loosening after people rely on exclusivity is not.
  const isAssignedHandler = !!(assetOwnership?.assigned_handler_staff_id &&
    assetOwnership.assigned_handler_staff_id === user.staff_id);

  const authorized = isAdministrator(user.role) ||
    stage.gate_roles.includes(normalizeRole(user.role)) ||
    isAssignedHandler;

  if (!authorized) {
    const required = stage.gate_roles.length ? stage.gate_roles.join(' or ') : 'Administrator';
    return {
      authorized: false,
      reason: `Stage '${to_stage}' requires role '${required}' (or being this asset's assigned handler). Current role: '${user.role}'`
    };
  }
  return { authorized: true };
}

// ─── ADVANCE PIPELINE ─────────────────────────────────────────────────────────
// CLOSE-GAP-12-C4: fail-closed on the whole path. The gate is evaluated first,
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
    return { success: false, code: 400, error: `Unknown stage: ${to_stage}`, block_reason: 'blocked_error' };
  }

  // 0. Fetch current stage + structural transition-validity check
  // (CLOSE-GAP-30). Deliberately first, before role authority or gate
  // requirements: whether a transition is even reachable at all is a
  // cheaper, more fundamental question than whether the evidence for the
  // target stage happens to be on file -- checking evidence for a
  // structurally-invalid transition is backwards (and, in practice,
  // produces a misleading 'blocked_pending' for the wrong reason if
  // ordered after the gate check, e.g. resuming on_hold to a stage
  // that's both structurally wrong AND missing its own evidence would
  // report the latter, masking the real problem).
  // assigned_handler_role/assigned_handler_staff_id selected here (not a
  // separate query) specifically so checkRoleAuthority can stay
  // synchronous -- see that function's header comment.
  const asset = await db.assets.query(
    `SELECT pipeline_stage, pipeline_reference, assigned_handler_role, assigned_handler_staff_id
     FROM pcm_assets WHERE asset_id = $1`, [asset_id]
  );
  const client = await db.clients.query(
    `SELECT pipeline_stage FROM pcm_clients WHERE client_id = $1 AND deleted_at IS NULL`, [client_id]
  );

  if (!asset.rows.length) return { success: false, code: 404, error: 'Asset not found' };
  if (!client.rows.length) return { success: false, code: 404, error: 'Client not found' };

  const from_stage = asset.rows[0].pipeline_stage;

  // Resuming from on_hold needs the pre-hold stage, reconstructed from
  // pcm_pipeline_history -- the only place it's recorded, since no
  // separate "held_from_stage" column exists.
  let priorStageBeforeHold = null;
  if (from_stage === 'on_hold') {
    const priorStageResult = await db.assets.query(
      `SELECT from_stage FROM pcm_pipeline_history
       WHERE asset_id = $1 AND to_stage = 'on_hold'
       ORDER BY created_at DESC LIMIT 1`, [asset_id]
    );
    priorStageBeforeHold = priorStageResult.rows[0]?.from_stage || null;
  }
  if (!isValidTransition(from_stage, to_stage, priorStageBeforeHold)) {
    return {
      success: false, code: 422,
      error: `Invalid stage transition: ${from_stage} -> ${to_stage}. Stages must advance one at a time; direct jumps are rejected.`,
      block_reason: 'blocked_invalid_transition'
    };
  }

  let systemCheck;
  if (stage.gate_roles.includes('system')) {
    try {
      const errors = await validateGate(to_stage, asset_id, client_id);
      systemCheck = { evaluated: true, passed: errors.length === 0, errors };
    } catch (err) {
      return { success: false, code: 422, error: err.message, block_reason: 'blocked_error' };
    }
  }

  // 1. Role authority check (unchanged for human-gated stages)
  const assetOwnership = {
    assigned_handler_role: asset.rows[0].assigned_handler_role,
    assigned_handler_staff_id: asset.rows[0].assigned_handler_staff_id
  };
  const auth = checkRoleAuthority(to_stage, user, systemCheck, assetOwnership);
  // Strict `!== true`, not `!auth.authorized` -- belt-and-suspenders per
  // this session's explicit instruction to verify a missed-await-shaped
  // mistake can't read as authorized. checkRoleAuthority is synchronous
  // (see its own header comment for why), so `auth` can't actually be a
  // Promise here today -- this guards the invariant anyway, at zero cost,
  // in case that ever changes without this comment being re-read.
  if (auth.authorized !== true) {
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

  // CLOSE-GAP-16: Sentinel enforcement gate, fail-closed. Runs after the
  // local checks above (role authority, gate requirements) and before any
  // state mutation below. BLOCK_SENTINEL_UNAVAILABLE / BLOCK_SENTINEL_ERROR
  // / BLOCK_SENTINEL_TIMEOUT (the policy engine could not be reached or
  // did not answer -- see CLOSE-GAP-14/15) map to block_reason
  // 'blocked_unavailable', distinguishable from a real Sentinel BLOCK
  // decision (block_reason 'blocked_pending', same bucket as unmet gate
  // requirements: the system answered, the answer was no).
  const sentinelResult = await governance.sentinelCheck(
    `PIPELINE_ADVANCE.${to_stage.toUpperCase()}`,
    `pcm:asset:${asset_id}`,
    {
      client_id,
      pipeline_reference: asset.rows[0].pipeline_reference,
      from_stage, to_stage,
      transitioned_by: user.sub || 'system'
    }
  );
  if (!sentinelResult.allowed) {
    const dependencyDown = sentinelResult.decision === 'BLOCK_SENTINEL_UNAVAILABLE'
                         || sentinelResult.decision === 'BLOCK_SENTINEL_ERROR'
                         || sentinelResult.decision === 'BLOCK_SENTINEL_TIMEOUT';
    return {
      success: false,
      code: dependencyDown ? 503 : 403,
      error: sentinelResult.reason || 'Blocked by Sentinel policy',
      block_reason: dependencyDown ? 'blocked_unavailable' : 'blocked_pending',
      sentinel_decision: sentinelResult.decision
    };
  }

  // 4. Advance both asset and client
  const [updated_asset] = await Promise.all([
    db.assets.query(
      `UPDATE pcm_assets SET pipeline_stage = $1 WHERE asset_id = $2 RETURNING *`,
      [to_stage, asset_id]
    ),
    db.clients.query(
      `UPDATE pcm_clients SET pipeline_stage = $1 WHERE client_id = $2`,
      [to_stage, client_id]
    )
  ]);

  // 5. Write audit records to both databases
  await Promise.all([
    db.assets.query(
      `INSERT INTO pcm_pipeline_history
        (asset_id, client_id, from_stage, to_stage, transitioned_by, transition_role, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [asset_id, client_id, from_stage, to_stage, user.sub || 'system', user.role, notes]
    ),
    db.clients.query(
      `INSERT INTO pcm_client_pipeline_audit
        (client_id, from_stage, to_stage, transitioned_by, transition_role, notes)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [client_id, from_stage, to_stage, user.sub || 'system', user.role, notes]
    )
  ]);

  // 6. Auto-trigger tokenization at stage 8
  if (to_stage === 'tokenization') {
    await triggerTokenization(asset_id, client_id, updated_asset.rows[0]);
  }

  return {
    success: true,
    asset: updated_asset.rows[0],
    transition: { from: from_stage, to: to_stage },
    stage_label: STAGES[to_stage]?.label
  };
}

// ─── TOKENIZATION TRIGGER ─────────────────────────────────────────────────────
async function triggerTokenization(asset_id, client_id, asset) {
  const valuation = await db.assets.query(
    `SELECT * FROM pcm_valuations WHERE asset_id = $1
     AND date_validation_status = 'passed'
     ORDER BY created_at DESC LIMIT 1`, [asset_id]
  );

  if (!valuation.rows.length) return;

  const val = valuation.rows[0];
  const crypto = require('crypto');
  const payload = JSON.stringify({
    asset_id, asset_type: asset.asset_type,
    verified_value: val.appraised_value,
    verification_date: val.appraisal_date,
    issuing_authority: val.appraiser_name,
    pipeline_reference: asset.pipeline_reference,
    minted_at: new Date().toISOString()
  });

  const signature = crypto
    .createHash('sha256')
    .update(payload)
    .digest('hex');

  await db.assets.query(
    `INSERT INTO pcm_classification_tokens
      (asset_id, client_id, asset_type, verified_value, currency,
       verification_date, issuing_authority, pipeline_reference,
       token_purpose, transferable, signature_algorithm, signature, signing_agent_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,false,$10,$11,$12)
     ON CONFLICT DO NOTHING`,
    [asset_id, client_id, asset.asset_type, val.appraised_value,
     val.currency || 'USD', val.appraisal_date, val.appraiser_name,
     asset.pipeline_reference, 'identification_and_verification_only',
     'ML-DSA-65-STUB', signature, 'token-minting-agent']
  );

  await db.assets.query(
    `UPDATE pcm_assets SET token_id =
      (SELECT token_id FROM pcm_classification_tokens WHERE asset_id = $1 LIMIT 1)
     WHERE asset_id = $1`, [asset_id]
  );
}

// ─── GET PIPELINE STATUS ──────────────────────────────────────────────────────
async function getPipelineStatus(asset_id, client_id) {
  const [asset, client, history, forms] = await Promise.all([
    db.assets.query(`SELECT * FROM pcm_assets WHERE asset_id = $1`, [asset_id]),
    db.clients.query(`SELECT * FROM pcm_clients WHERE client_id = $1 AND deleted_at IS NULL`, [client_id]),
    db.assets.query(`SELECT * FROM pcm_pipeline_history WHERE asset_id = $1 ORDER BY created_at`, [asset_id]),
    db.forms.query(`SELECT agreement_type, status FROM pcm_agreements WHERE asset_id = $1`, [asset_id])
  ]);

  if (!asset.rows.length) return null;

  const current_stage = asset.rows[0].pipeline_stage;
  const stage_info    = STAGES[current_stage];

  // Calculate next stage
  const stage_order   = Object.entries(STAGES)
    .filter(([, v]) => v.order > 0)
    .sort(([, a], [, b]) => a.order - b.order);
  const current_idx   = stage_order.findIndex(([k]) => k === current_stage);
  const next_stage    = current_idx >= 0 && current_idx < stage_order.length - 1
    ? stage_order[current_idx + 1][0] : null;

  // Pre-check next gate requirements
  let next_gate_status = null;
  if (next_stage) {
    const errors = await validateGate(next_stage, asset_id, client_id);
    next_gate_status = { stage: next_stage, ready: errors.length === 0, blockers: errors };
  }

  return {
    asset_id,
    client_id,
    pipeline_reference: asset.rows[0].pipeline_reference,
    current_stage,
    stage_label:  stage_info?.label,
    gate_roles:   stage_info?.gate_roles,
    next_stage,
    next_gate_status,
    history:      history.rows,
    agreements:   forms.rows,
    asset:        asset.rows[0],
    client:       client.rows[0]
  };
}

module.exports = { advancePipeline, getPipelineStatus, validateGate, STAGES, isValidTransition, checkRoleAuthority };
