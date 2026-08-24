// 2026-08-17 access-control redesign: the explicit gate_roles permission
// sets replacing pipeline.js's old hierarchy plus the additive
// assigned-handler path, and the trade_group_owner -> facilitator
// rename's alias window.
//
// 2026-08-24: legal-review attestation (the two-step entry/countersign
// mechanic this file originally tested) is removed entirely -- CoreG
// reviews its own documentation, there is no external counsel step.
// Replaced by: POST /assets/:id/assign (standalone package-handler
// assignment, no attestation) and platform submission/response tracking
// (POST /assets/:id/platform-submission,
// POST .../platform-submission/:submission_id/response) -- the package
// goes to an external platform after securitization (stage 7) completes,
// and platform APPROVED is now the gate requirement for advancing to
// tokenization (stage 8). See db/migrations/0013, 0017.
//
// Real Express app, real HTTP requests via supertest, real isolated
// local database (see tests/env.setup.js) -- same pattern as
// gates.http-proof.test.js and password-reset.test.js.
'use strict';

jest.mock('../api/services/governance', () => ({
  ...jest.requireActual('../api/services/governance'),
  sentinelCheck: jest.fn().mockResolvedValue({ allowed: true, decision: 'ALLOW', reason: null })
}));

process.env.PORT = '34179'; // distinct test-only port

const jwt = require('jsonwebtoken');
const request = require('supertest');
const app = require('../api/app');
const db = require('../api/services/db');
const fx = require('./fixtures');
const { checkRoleAuthority, validateGate } = require('../api/services/pipeline');

function tokenFor(role, sub = 'test-fixture', staff_id = 'test-staff-id') {
  return jwt.sign({ sub, role, staff_id }, process.env.JWT_SECRET, { expiresIn: '5m' });
}

// pcm_assets.assigned_handler_staff_id is written by POST /assets/:id/assign
// from req.user.staff_id -- tests that exercise assignment need a real
// staff_id behind the token, not an arbitrary string.
async function staffToken(role) {
  const staff = await fx.createStaff({ role: role === 'facilitator' ? 'facilitator' : role });
  return { token: tokenFor(role, staff.email, staff.staff_id), staff };
}

afterAll(async () => {
  await Promise.all([db.clients.end(), db.assets.end(), db.forms.end(), db.pehf.end()]);
});

describe('checkRoleAuthority is synchronous — the missed-await failure mode is structurally impossible', () => {
  // Explicit regression test, per instruction: a version of this function
  // that needed to be async (to look up ownership itself) would, if
  // called without `await`, hand back a Promise. `somePromise.authorized`
  // is `undefined`, not throwing -- so a call site checking `if
  // (!auth.authorized)` would still (accidentally) block, but a call site
  // checking raw truthiness of the return value, or any future refactor
  // that does, would treat the Promise itself as "authorized" (Promises
  // are always truthy objects) and pass a check that should have failed.
  // That failure mode passes every test that only exercises the happy
  // path, because nothing throws and the wrong answer looks like a
  // plausible object.
  //
  // The actual fix isn't a guard against this -- it's that
  // checkRoleAuthority never needed to become async in the first place
  // (advancePipeline already fetches the asset row before calling it; see
  // that function's header comment). This test proves that structurally:
  // calling it with no `await` at all still returns a plain object
  // synchronously, not a thenable, so there is no missed-await scenario
  // to have.
  test('calling checkRoleAuthority without await returns a plain object, not a Promise', () => {
    const result = checkRoleAuthority('bank_assignment', { role: 'intake_officer', staff_id: 'x' }, undefined, null);
    expect(result).not.toBeInstanceOf(Promise);
    expect(typeof result.then).not.toBe('function');
    expect(result.authorized).toBe(false); // correct answer, not a side point of this test
  });

  test('the real call site in advancePipeline() also awaits nothing async in checkRoleAuthority -- verified by asserting a real HTTP round trip completes without unhandled-rejection noise', async () => {
    // If advancePipeline's call site were treating a Promise as the auth
    // result (the exact bug this whole test file exists to rule out), a
    // request that SHOULD be blocked would incorrectly succeed. This
    // reproduces that exact shape end-to-end: an Intake Officer (not in
    // bank_assignment's gate_roles, no assignment) must still be blocked.
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id, { pipeline_stage: 'appraisal_review' });
    const res = await request(app)
      .post('/api/v1/pipeline/advance')
      .set('Authorization', `Bearer ${tokenFor('intake_officer')}`)
      .send({ asset_id, client_id, to_stage: 'bank_assignment' });
    expect(res.status).toBe(403);
  });
});

describe('Package handler assignment — POST /assets/:id/assign, standalone, self-referential', () => {
  test('Intake Officer can self-assign; assigned_role/assigned_staff_id land on pcm_assets', async () => {
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id);
    const io = await staffToken('intake_officer');

    const res = await request(app)
      .post(`/api/v1/assets/${asset_id}/assign`)
      .set('Authorization', `Bearer ${io.token}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.assigned_handler_role).toBe('intake_officer');
    expect(res.body.assigned_handler_staff_id).toBe(io.staff.staff_id);

    const assetRow = await db.assets.query(
      `SELECT assigned_handler_role, assigned_handler_staff_id FROM pcm_assets WHERE asset_id = $1`, [asset_id]
    );
    expect(assetRow.rows[0].assigned_handler_role).toBe('intake_officer');
    expect(assetRow.rows[0].assigned_handler_staff_id).toBe(io.staff.staff_id);
  });

  test('Program Manager and Facilitator can self-assign too', async () => {
    const client_id = await fx.createClient();
    for (const role of ['program_manager', 'facilitator']) {
      const { asset_id } = await fx.createAsset(client_id);
      const staff = await staffToken(role);
      const res = await request(app)
        .post(`/api/v1/assets/${asset_id}/assign`)
        .set('Authorization', `Bearer ${staff.token}`)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.assigned_handler_role).toBe(role);
    }
  });

  test('assigned_handler_role/staff_id come from req.user, not the request body -- a caller cannot claim an assignment for someone else', async () => {
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id);
    const io = await staffToken('intake_officer');
    const res = await request(app)
      .post(`/api/v1/assets/${asset_id}/assign`)
      .set('Authorization', `Bearer ${io.token}`)
      .send({
        // Attempted injection -- must be ignored entirely.
        assigned_handler_staff_id: 'someone-elses-staff-id', assigned_handler_role: 'program_manager'
      });
    expect(res.status).toBe(200);
    expect(res.body.assigned_handler_staff_id).toBe(io.staff.staff_id);
    expect(res.body.assigned_handler_role).toBe('intake_officer');
  });
});

describe('kyc_verification gate — restored to its own evidence (KYC documents, POF record, OFAC status), no external attestation', () => {
  test('all three satisfied -- no legal review of any kind required', async () => {
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id);
    await fx.addKycDocument(client_id);
    await fx.addPofRecord(client_id);
    await fx.confirmOfacAttestation(client_id);

    const errors = await validateGate('kyc_verification', asset_id, client_id);
    expect(errors).toEqual([]);
  });

  test('missing POF record blocks with a plain existence message, no outcome/approve-deny vocabulary', async () => {
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id);
    await fx.addKycDocument(client_id);
    await fx.confirmOfacAttestation(client_id);

    const errors = await validateGate('kyc_verification', asset_id, client_id);
    expect(errors).toEqual(expect.arrayContaining(['No Proof of Funds on file']));
  });

  test('missing KYC documents blocks independently of POF/OFAC', async () => {
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id);
    await fx.addPofRecord(client_id);
    await fx.confirmOfacAttestation(client_id);

    const errors = await validateGate('kyc_verification', asset_id, client_id);
    expect(errors).toEqual(expect.arrayContaining(['No KYC documents on file']));
  });
});

describe('Platform submission tracking — submission at securitization, single-principal response, DENIED archives via rejected', () => {
  test('submission only allowed once the asset is at securitization', async () => {
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id, { pipeline_stage: 'monetization' });
    const pm = await staffToken('program_manager');
    const res = await request(app)
      .post(`/api/v1/assets/${asset_id}/platform-submission`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({});
    expect(res.status).toBe(409);
  });

  test('submission at securitization succeeds and records submitted_by/submitted_at; APPROVED response satisfies the tokenization gate', async () => {
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id, { pipeline_stage: 'securitization' });
    await fx.addValuation(asset_id);
    const pm = await staffToken('program_manager');

    const submitRes = await request(app)
      .post(`/api/v1/assets/${asset_id}/platform-submission`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({});
    expect(submitRes.status).toBe(201);
    expect(submitRes.body.submitted_by).toBe(pm.staff.email);
    expect(submitRes.body.submission_id).toBeTruthy();

    const beforeResponse = await validateGate('tokenization', asset_id, client_id);
    expect(beforeResponse).toEqual(expect.arrayContaining(['Platform submission recorded but response not yet received']));

    const responseRes = await request(app)
      .post(`/api/v1/assets/${asset_id}/platform-submission/${submitRes.body.submission_id}/response`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ decision: 'APPROVED' });
    expect(responseRes.status).toBe(201);
    expect(responseRes.body.recorded_by).toBe(pm.staff.email);

    const afterResponse = await validateGate('tokenization', asset_id, client_id);
    expect(afterResponse).toEqual([]);
  });

  test('decision is required and must be APPROVED or DENIED -- no default, no third value', async () => {
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id, { pipeline_stage: 'securitization' });
    const pm = await staffToken('program_manager');
    const submitRes = await request(app)
      .post(`/api/v1/assets/${asset_id}/platform-submission`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({});

    const missing = await request(app)
      .post(`/api/v1/assets/${asset_id}/platform-submission/${submitRes.body.submission_id}/response`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({});
    expect(missing.status).toBe(400);

    const bogus = await request(app)
      .post(`/api/v1/assets/${asset_id}/platform-submission/${submitRes.body.submission_id}/response`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ decision: 'approved' }); // lowercase -- not the stored vocabulary
    expect(bogus.status).toBe(400);
  });

  test('a submission cannot receive a second response', async () => {
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id, { pipeline_stage: 'securitization' });
    const pm = await staffToken('program_manager');
    const submitRes = await request(app)
      .post(`/api/v1/assets/${asset_id}/platform-submission`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({});
    await request(app)
      .post(`/api/v1/assets/${asset_id}/platform-submission/${submitRes.body.submission_id}/response`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ decision: 'APPROVED' });

    const second = await request(app)
      .post(`/api/v1/assets/${asset_id}/platform-submission/${submitRes.body.submission_id}/response`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ decision: 'DENIED' });
    expect(second.status).toBe(409);
  });

  test('DENIED archives the package by auto-moving it to rejected, via the real advancePipeline path (audit row included)', async () => {
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id, { pipeline_stage: 'securitization' });
    const pm = await staffToken('program_manager');
    const submitRes = await request(app)
      .post(`/api/v1/assets/${asset_id}/platform-submission`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({});

    const responseRes = await request(app)
      .post(`/api/v1/assets/${asset_id}/platform-submission/${submitRes.body.submission_id}/response`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ decision: 'DENIED' });
    expect(responseRes.status).toBe(201);
    expect(responseRes.body.auto_rejected).toBe(true);
    expect(responseRes.body.rejection_result.success).toBe(true);

    const assetRow = await db.assets.query(`SELECT pipeline_stage FROM pcm_assets WHERE asset_id = $1`, [asset_id]);
    expect(assetRow.rows[0].pipeline_stage).toBe('rejected');

    const history = await db.assets.query(`SELECT to_stage, transitioned_by FROM pcm_pipeline_history WHERE asset_id = $1 ORDER BY created_at DESC LIMIT 1`, [asset_id]);
    expect(history.rows[0].to_stage).toBe('rejected');
    expect(history.rows[0].transitioned_by).toBe(pm.staff.email);
  });

  test('rejected via platform denial is genuinely terminal -- cannot advance back out, same as any other rejection', async () => {
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id, { pipeline_stage: 'securitization' });
    const pm = await staffToken('program_manager');
    const submitRes = await request(app)
      .post(`/api/v1/assets/${asset_id}/platform-submission`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({});
    await request(app)
      .post(`/api/v1/assets/${asset_id}/platform-submission/${submitRes.body.submission_id}/response`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ decision: 'DENIED' });

    const bounceRes = await request(app)
      .post('/api/v1/pipeline/advance')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ asset_id, client_id, to_stage: 'tokenization' });
    expect(bounceRes.status).toBe(422);
    expect(bounceRes.body.error).toMatch(/Invalid stage transition/);
  });
});

// Explicit negative coverage for the tokenization gate, per instruction:
// a gate that has only been observed passing is unverified. Both cases
// exercise validateGate() directly, isolated from advancePipeline's own
// structural-transition check (which would separately block a DENIED
// asset from even reaching this gate in the real advance flow -- see the
// 'genuinely terminal' test above).
describe('tokenization gate — negative coverage: platform approval is required, not assumed', () => {
  test('a submission with no response yet refuses the gate', async () => {
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id);
    await fx.addValuation(asset_id);
    await fx.createPlatformSubmission(asset_id);

    const errors = await validateGate('tokenization', asset_id, client_id);
    expect(errors).toEqual(expect.arrayContaining(['Platform submission recorded but response not yet received']));
  });

  test('a DENIED response refuses the gate, distinctly from "no response yet"', async () => {
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id);
    await fx.addValuation(asset_id);
    const submissionId = await fx.createPlatformSubmission(asset_id);
    await fx.recordPlatformResponse(submissionId, 'DENIED');

    const errors = await validateGate('tokenization', asset_id, client_id);
    expect(errors).toEqual(expect.arrayContaining(['Platform denied this submission — package cannot proceed']));
    expect(errors).not.toContain('Platform submission recorded but response not yet received');
  });

  test('no submission at all refuses the gate', async () => {
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id);
    await fx.addValuation(asset_id);

    const errors = await validateGate('tokenization', asset_id, client_id);
    expect(errors).toEqual(expect.arrayContaining(['No platform submission on file']));
  });
});

describe('Retention floor — one-year regulatory minimum, verified against the real database trigger', () => {
  test('deleting a fresh (< 1 year old) client is blocked by the database itself', async () => {
    const client_id = await fx.createClient();
    await expect(db.clients.query(`DELETE FROM pcm_clients WHERE client_id = $1`, [client_id]))
      .rejects.toThrow(/Retention floor/);

    // Row must still be present -- the block actually prevented deletion,
    // not just threw after partially succeeding.
    const check = await db.clients.query(`SELECT client_id FROM pcm_clients WHERE client_id = $1`, [client_id]);
    expect(check.rows.length).toBe(1);
  });

  test('deleting a client backdated past the one-year floor is allowed', async () => {
    const client_id = await fx.createClient();
    await db.clients.query(`UPDATE pcm_clients SET created_at = now() - interval '400 days' WHERE client_id = $1`, [client_id]);
    await expect(db.clients.query(`DELETE FROM pcm_clients WHERE client_id = $1`, [client_id])).resolves.not.toThrow();
  });

  test('the floor also covers KYC documents, POF records, OFAC results, and assets -- not just clients', async () => {
    const client_id = await fx.createClient();
    await fx.addKycDocument(client_id);
    const kycRow = await db.clients.query(`SELECT doc_id FROM pcm_kyc_documents WHERE client_id = $1`, [client_id]);
    await expect(db.clients.query(`DELETE FROM pcm_kyc_documents WHERE doc_id = $1`, [kycRow.rows[0].doc_id]))
      .rejects.toThrow(/Retention floor/);

    const { asset_id } = await fx.createAsset(client_id);
    await expect(db.assets.query(`DELETE FROM pcm_assets WHERE asset_id = $1`, [asset_id]))
      .rejects.toThrow(/Retention floor/);
  });
});

describe('Additive owner-based access — assignment adds a path, does not exclude anyone', () => {
  // 2026-08-17 (Intake Officer scope, third revision): kyc_verification's
  // gate_roles flipped from ['intake_officer'] to ['program_manager'] --
  // Intake Officer no longer advances anything (routes/pipeline.js POST
  // /advance no longer accepts them at all, so this stage's
  // checkRoleAuthority check is unreachable for them via any live route).
  // These three tests demonstrated the ownership/additive path using
  // Program Manager on kyc_verification, which is now moot for that role
  // (gate_roles grants it directly) -- roles swapped so the tests still
  // demonstrate something real: an assigned Intake Officer gaining access
  // to a stage gate_roles no longer grants them.
  test('an assigned Intake Officer gains kyc_verification access (now Program-Manager-only via gate_roles) for THAT asset', async () => {
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id);
    await fx.addKycDocument(client_id);
    await fx.addPofRecord(client_id);
    await fx.confirmOfacAttestation(client_id);

    const assignedIo = await staffToken('intake_officer');
    const assignRes = await request(app)
      .post(`/api/v1/assets/${asset_id}/assign`)
      .set('Authorization', `Bearer ${assignedIo.token}`)
      .send({});
    expect(assignRes.status).toBe(200);

    // Direct unit check of the assigned handler's authority, isolated
    // from the rest of advancePipeline's gate-requirements plumbing --
    // using the REAL assigned staff_id the HTTP calls above just wrote,
    // not a disconnected hand-picked one.
    const auth = checkRoleAuthority(
      'kyc_verification',
      { role: 'intake_officer', staff_id: assignedIo.staff.staff_id },
      undefined,
      { assigned_handler_role: 'intake_officer', assigned_handler_staff_id: assignedIo.staff.staff_id }
    );
    expect(auth.authorized).toBe(true);

    // A DIFFERENT, unassigned Intake Officer must NOT get this via
    // ownership -- gate_roles alone still says no for kyc_verification.
    const otherAuth = checkRoleAuthority(
      'kyc_verification',
      { role: 'intake_officer', staff_id: 'some-other-io-id' },
      undefined,
      { assigned_handler_role: 'intake_officer', assigned_handler_staff_id: assignedIo.staff.staff_id }
    );
    expect(otherAuth.authorized).toBe(false);
  });

  test('additive, not exclusive: an UNASSIGNED Program Manager still has normal kyc_verification access on an asset assigned to an Intake Officer', () => {
    const auth = checkRoleAuthority(
      'kyc_verification',
      { role: 'program_manager', staff_id: 'some-other-pm-id' },
      undefined,
      { assigned_handler_role: 'intake_officer', assigned_handler_staff_id: 'assigned-io-id' }
    );
    // gate_roles.includes('program_manager') is still true regardless of
    // who this asset is assigned to -- assignment only ever adds a path,
    // never removes the normal one. This is the specific behavior
    // confirmed this session: exclusive ownership was considered and
    // rejected.
    expect(auth.authorized).toBe(true);
  });

  test('no assignment on the asset -- ownership path simply does not apply, normal gate_roles behavior unchanged', () => {
    expect(checkRoleAuthority('kyc_verification', { role: 'intake_officer', staff_id: 'x' }, undefined, null).authorized).toBe(false);
    expect(checkRoleAuthority('kyc_verification', { role: 'intake_officer', staff_id: 'x' }, undefined, {}).authorized).toBe(false);
  });
});

describe('Explicit permission sets — no inheritance between Program Manager and Intake Officer', () => {
  test('Program Manager gets 403 creating a client (compliance-domain route, narrowed off PM)', async () => {
    const res = await request(app)
      .post('/api/v1/clients')
      .set('Authorization', `Bearer ${tokenFor('program_manager')}`)
      .send({ full_name: 'X', email: 'x@example.test', country_of_origin: 'US', given_name: 'X', family_name: 'Y', date_of_birth: '1990-01-01' });
    expect(res.status).toBe(403);
  });

  test('Intake Officer gets 403 creating an asset (contracts/monitoring-domain route, narrowed off IO)', async () => {
    const client_id = await fx.createClient();
    const res = await request(app)
      .post('/api/v1/assets')
      .set('Authorization', `Bearer ${tokenFor('intake_officer')}`)
      .send({ client_id, asset_type: 'real_estate' });
    expect(res.status).toBe(403);
  });

  // 2026-08-17 (Intake Officer scope, third revision): "Adjustment 1: POF
  // verification stays Program Manager, not Intake Officer" is gone --
  // its entire premise (a Program-Manager-performed POF verification
  // action) no longer exists. What it became (PATCH .../pof/:pof_id/legal-outcome)
  // is itself removed 2026-08-24 along with legal attestation -- CoreG
  // reviews POF itself, kyc_verification's gate checks record existence
  // only (see the "restored to its own evidence" describe block above).

  // 2026-08-17 (Intake Officer scope, third revision): Adjustment 2
  // inverted -- referral-source/lead management is a different domain
  // from collecting and routing a specific client's package to legal,
  // not part of "collect and route only." Intake Officer is now excluded.
  test('Adjustment 2 (revised): Referrers and Leads narrow to Facilitator and Program Manager, Intake Officer excluded', async () => {
    for (const role of ['facilitator', 'program_manager']) {
      const res = await request(app)
        .get('/api/v1/referrers')
        .set('Authorization', `Bearer ${tokenFor(role)}`)
        .query({ type: 'Law Firms' });
      expect(res.status).toBe(200);
    }
    const ioRes = await request(app)
      .get('/api/v1/referrers')
      .set('Authorization', `Bearer ${tokenFor('intake_officer')}`)
      .query({ type: 'Law Firms' });
    expect(ioRes.status).toBe(403);

    const ioLeadsRes = await request(app)
      .get('/api/v1/leads')
      .set('Authorization', `Bearer ${tokenFor('intake_officer')}`);
    expect(ioLeadsRes.status).toBe(403);
  });

  test('Facilitator passes every route regardless of listed roles (strict superset)', async () => {
    const res = await request(app)
      .post('/api/v1/assets')
      .set('Authorization', `Bearer ${tokenFor('facilitator')}`)
      .send({ client_id: await fx.createClient(), asset_type: 'real_estate' });
    expect(res.status).toBe(201);
  });
});

describe('Pipeline gate_roles — explicit sets, not a hierarchy', () => {
  test('Program Manager is rejected for bank_assignment (Facilitator-only stage) -- no inheritance', () => {
    const result = checkRoleAuthority('bank_assignment', { role: 'program_manager', staff_id: 'x' }, undefined, null);
    expect(result.authorized).toBe(false);
  });

  test('Intake Officer is rejected for appraisal_review (Program Manager stage)', () => {
    const result = checkRoleAuthority('appraisal_review', { role: 'intake_officer', staff_id: 'x' }, undefined, null);
    expect(result.authorized).toBe(false);
  });

  // 2026-08-17 (Intake Officer scope, third revision): kyc_verification's
  // gate_roles flipped from ['intake_officer'] to ['program_manager'] --
  // see routes/pipeline.js POST /advance and services/pipeline.js's
  // STAGES comment. Worth stating plainly: with this change, Intake
  // Officer no longer has ANY entry in STAGES.gate_roles reachable via a
  // live route (their 'intake' stage entry was already dead code before
  // today -- confirmed while making this change, no valid isValidTransition
  // path ever reaches to_stage:'intake', since assets start there via
  // direct creation, not advancePipeline()). Program Manager is now the
  // only non-Facilitator human role with pipeline-advancement authority
  // anywhere in STAGES. The "explicit sets, not hierarchy" pairing below
  // is Intake Officer/kyc_verification (rejected) vs. Program Manager on
  // both of its own stages (authorized) -- there's no longer a second
  // human role with its own separate stage to contrast against.
  test('Intake Officer is rejected for kyc_verification (now Program Manager\'s stage) -- explicit sets, not a hierarchy', () => {
    const result = checkRoleAuthority('kyc_verification', { role: 'intake_officer', staff_id: 'x' }, undefined, null);
    expect(result.authorized).toBe(false);
  });

  test('Program Manager is authorized for both kyc_verification and appraisal_review (both are Program Manager\'s stages now)', () => {
    expect(checkRoleAuthority('kyc_verification', { role: 'program_manager', staff_id: 'x' }, undefined, null).authorized).toBe(true);
    expect(checkRoleAuthority('appraisal_review', { role: 'program_manager', staff_id: 'x' }, undefined, null).authorized).toBe(true);
  });

  test('Facilitator is authorized for every human-gated stage', () => {
    for (const stage of ['kyc_verification', 'appraisal_review', 'bank_assignment', 'collateralization', 'monetization', 'securitization', 'rejected', 'on_hold']) {
      expect(checkRoleAuthority(stage, { role: 'facilitator', staff_id: 'x' }, undefined, null).authorized).toBe(true);
    }
  });
});

describe('Rename alias window — trade_group_owner still works as Facilitator', () => {
  test('a token minted with the pre-rename role string passes a Facilitator-only route', async () => {
    const res = await request(app)
      .delete(`/api/v1/clients/${await fx.createClient()}`)
      .set('Authorization', `Bearer ${tokenFor('trade_group_owner')}`);
    expect(res.status).toBe(200);
  });

  test('a token minted with the pre-rename role string passes a Facilitator-only pipeline gate', () => {
    const result = checkRoleAuthority('bank_assignment', { role: 'trade_group_owner', staff_id: 'x' }, undefined, null);
    expect(result.authorized).toBe(true);
  });

  test('a fresh login after the rename issues role: facilitator, not trade_group_owner', async () => {
    const staff = await fx.createStaff({ role: 'facilitator', password: 'fresh-login-pass-1' });
    const res = await request(app).post('/api/v1/auth/login').send({ email: staff.email, password: 'fresh-login-pass-1' });
    expect(res.status).toBe(200);
    const payload = JSON.parse(Buffer.from(res.body.token.split('.')[1], 'base64url').toString());
    expect(payload.role).toBe('facilitator');
  });
});
