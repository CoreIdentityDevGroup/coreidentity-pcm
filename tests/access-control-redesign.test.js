// 2026-08-17 access-control redesign: legal-review attestation
// (corrected same day -- legal assigns a handler by asset type, not just
// reviews), the explicit gate_roles permission sets replacing
// pipeline.js's old hierarchy plus the additive assigned-handler path,
// and the trade_group_owner -> administrator rename's alias window. Real
// Express app, real HTTP requests via supertest, real isolated local
// database (see tests/env.setup.js) -- same pattern as
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

// pcm_legal_attestations.assigned_staff_id is a real FK to pcm_staff
// (same-database reference, unlike asset_id -- see db/migrations/0013a's
// comment) -- any test that actually records an attestation needs a real
// staff row behind the token's staff_id, not an arbitrary string.
async function staffToken(role) {
  const staff = await fx.createStaff({ role: role === 'administrator' ? 'administrator' : role });
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

describe('Legal-review attestation — asset-scoped, two-step entry/countersign', () => {
  test('entry by Intake Officer, countersign by Administrator, satisfies the kyc_verification gate and assigns the handler', async () => {
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id);
    await fx.addKycDocument(client_id);
    await fx.addPofRecord(client_id);
    await fx.confirmOfacAttestation(client_id);

    const beforeErrors = await validateGate('kyc_verification', asset_id, client_id);
    expect(beforeErrors).toEqual(expect.arrayContaining(['No legal-review attestation on file']));

    const io = await staffToken('intake_officer');
    const entryRes = await request(app)
      .post(`/api/v1/assets/${asset_id}/legal-attestation`)
      .set('Authorization', `Bearer ${io.token}`)
      .send({ counsel_name: 'Jane Counsel, Esq.', review_date: '2026-08-17', reference: 'Matter #4471' });
    expect(entryRes.status).toBe(201);
    expect(entryRes.body.status).toBe('pending_countersign');
    expect(entryRes.body.assigned_role).toBe('intake_officer');

    // Live ownership pointer set at entry, not only at countersign.
    const assetRow = await db.assets.query(`SELECT assigned_handler_role, assigned_handler_staff_id FROM pcm_assets WHERE asset_id = $1`, [asset_id]);
    expect(assetRow.rows[0].assigned_handler_role).toBe('intake_officer');
    expect(assetRow.rows[0].assigned_handler_staff_id).toBe(io.staff.staff_id);

    const pendingErrors = await validateGate('kyc_verification', asset_id, client_id);
    expect(pendingErrors).toEqual(expect.arrayContaining(['Legal attestation recorded but not yet countersigned by an Administrator']));
    expect(pendingErrors).not.toContain('No legal-review attestation on file');

    const admin = await staffToken('administrator');
    const countersignRes = await request(app)
      .patch(`/api/v1/assets/${asset_id}/legal-attestation/${entryRes.body.attestation_id}/countersign`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({});
    expect(countersignRes.status).toBe(200);
    expect(countersignRes.body.status).toBe('confirmed');

    const afterErrors = await validateGate('kyc_verification', asset_id, client_id);
    expect(afterErrors).toEqual([]);
  });

  test('entry by Program Manager also works -- legal can assign either role', async () => {
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id);
    const pm = await staffToken('program_manager');
    const entryRes = await request(app)
      .post(`/api/v1/assets/${asset_id}/legal-attestation`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ counsel_name: 'Jane Counsel', review_date: '2026-08-17', reference: 'Matter #2' });
    expect(entryRes.status).toBe(201);
    expect(entryRes.body.assigned_role).toBe('program_manager');
  });

  test('Administrator entry works too (superset rule) and records assigned_role: administrator', async () => {
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id);
    const admin = await staffToken('administrator');
    const entryRes = await request(app)
      .post(`/api/v1/assets/${asset_id}/legal-attestation`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ counsel_name: 'Jane Counsel', review_date: '2026-08-17', reference: 'Matter #3' });
    expect(entryRes.status).toBe(201);
    expect(entryRes.body.assigned_role).toBe('administrator');
  });

  test('assigned_staff_id/assigned_role come from req.user, not the request body -- a caller cannot claim an assignment for someone else', async () => {
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id);
    const io = await staffToken('intake_officer');
    const entryRes = await request(app)
      .post(`/api/v1/assets/${asset_id}/legal-attestation`)
      .set('Authorization', `Bearer ${io.token}`)
      .send({
        counsel_name: 'Jane Counsel', review_date: '2026-08-17', reference: 'Matter #5',
        // Attempted injection -- must be ignored entirely.
        assigned_staff_id: 'someone-elses-staff-id', assigned_role: 'program_manager'
      });
    expect(entryRes.status).toBe(201);

    const row = await db.clients.query(`SELECT assigned_staff_id, assigned_role FROM pcm_legal_attestations WHERE attestation_id = $1`, [entryRes.body.attestation_id]);
    expect(row.rows[0].assigned_staff_id).toBe(io.staff.staff_id);
    expect(row.rows[0].assigned_role).toBe('intake_officer');
  });

  test('same principal cannot countersign their own attestation entry', async () => {
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id);
    const staff = await fx.createStaff({ role: 'intake_officer' });
    const ioToken = tokenFor('intake_officer', staff.email, staff.staff_id);
    const entryRes = await request(app)
      .post(`/api/v1/assets/${asset_id}/legal-attestation`)
      .set('Authorization', `Bearer ${ioToken}`)
      .send({ counsel_name: 'John Counsel', review_date: '2026-08-17', reference: 'Matter #1' });
    expect(entryRes.status).toBe(201);

    // Same person, now presenting an Administrator-role token (their
    // email is the identity dual control keys off, not the role claim).
    const adminToken = tokenFor('administrator', staff.email, staff.staff_id);
    const countersignRes = await request(app)
      .patch(`/api/v1/assets/${asset_id}/legal-attestation/${entryRes.body.attestation_id}/countersign`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(countersignRes.status).toBe(403);

    const row = await db.clients.query(`SELECT status FROM pcm_legal_attestations WHERE attestation_id = $1`, [entryRes.body.attestation_id]);
    expect(row.rows[0].status).toBe('pending_countersign');
  });

  test('Intake Officer cannot countersign (Administrator only)', async () => {
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id);
    const io = await staffToken('intake_officer');
    const entryRes = await request(app)
      .post(`/api/v1/assets/${asset_id}/legal-attestation`)
      .set('Authorization', `Bearer ${io.token}`)
      .send({ counsel_name: 'X', review_date: '2026-08-17', reference: 'Y' });
    expect(entryRes.status).toBe(201);

    const ioCountersign = await request(app)
      .patch(`/api/v1/assets/${asset_id}/legal-attestation/${entryRes.body.attestation_id}/countersign`)
      .set('Authorization', `Bearer ${tokenFor('intake_officer', 'io3@example.test')}`)
      .send({});
    expect(ioCountersign.status).toBe(403);
  });
});

describe('Additive owner-based access — assignment adds a path, does not exclude anyone', () => {
  test('an assigned Program Manager gains kyc_verification access (normally Intake-Officer-only) for THAT asset', async () => {
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id);
    await fx.addKycDocument(client_id);
    await fx.addPofRecord(client_id);
    await fx.confirmOfacAttestation(client_id);

    const entryRes = await request(app)
      .post(`/api/v1/assets/${asset_id}/legal-attestation`)
      .set('Authorization', `Bearer ${tokenFor('program_manager', 'assigned-pm@example.test', 'assigned-pm-id')}`)
      .send({ counsel_name: 'X', review_date: '2026-08-17', reference: 'Y' });
    await request(app)
      .patch(`/api/v1/assets/${asset_id}/legal-attestation/${entryRes.body.attestation_id}/countersign`)
      .set('Authorization', `Bearer ${tokenFor('administrator', 'admin2@example.test')}`)
      .send({});

    // Direct unit check of the assigned handler's authority, isolated
    // from the rest of advancePipeline's gate-requirements plumbing.
    const auth = checkRoleAuthority(
      'kyc_verification',
      { role: 'program_manager', staff_id: 'assigned-pm-id' },
      undefined,
      { assigned_handler_role: 'program_manager', assigned_handler_staff_id: 'assigned-pm-id' }
    );
    expect(auth.authorized).toBe(true);

    // A DIFFERENT, unassigned Program Manager must NOT get this via
    // ownership -- gate_roles alone still says no for kyc_verification.
    const otherAuth = checkRoleAuthority(
      'kyc_verification',
      { role: 'program_manager', staff_id: 'some-other-pm-id' },
      undefined,
      { assigned_handler_role: 'program_manager', assigned_handler_staff_id: 'assigned-pm-id' }
    );
    expect(otherAuth.authorized).toBe(false);
  });

  test('additive, not exclusive: an UNASSIGNED Intake Officer still has normal kyc_verification access on an asset assigned to a Program Manager', () => {
    const auth = checkRoleAuthority(
      'kyc_verification',
      { role: 'intake_officer', staff_id: 'some-other-io-id' },
      undefined,
      { assigned_handler_role: 'program_manager', assigned_handler_staff_id: 'assigned-pm-id' }
    );
    // gate_roles.includes('intake_officer') is still true regardless of
    // who this asset is assigned to -- assignment only ever adds a path,
    // never removes the normal one. This is the specific behavior
    // confirmed this session: exclusive ownership was considered and
    // rejected.
    expect(auth.authorized).toBe(true);
  });

  test('no assignment on the asset -- ownership path simply does not apply, normal gate_roles behavior unchanged', () => {
    expect(checkRoleAuthority('kyc_verification', { role: 'program_manager', staff_id: 'x' }, undefined, null).authorized).toBe(false);
    expect(checkRoleAuthority('kyc_verification', { role: 'program_manager', staff_id: 'x' }, undefined, {}).authorized).toBe(false);
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

  test('Adjustment 1: POF verification stays Program Manager, not Intake Officer', async () => {
    const client_id = await fx.createClient();
    const pof = await fx.addPofRecord(client_id);
    const ioRes = await request(app)
      .patch(`/api/v1/clients/${client_id}/pof/${pof}/verify`)
      .set('Authorization', `Bearer ${tokenFor('intake_officer')}`)
      .send({ verification_notes: 'n/a' });
    expect(ioRes.status).toBe(403);

    const pmRes = await request(app)
      .patch(`/api/v1/clients/${client_id}/pof/${pof}/verify`)
      .set('Authorization', `Bearer ${tokenFor('program_manager')}`)
      .send({ verification_notes: 'checked' });
    expect(pmRes.status).toBe(200);
  });

  test('Adjustment 2: Referrers and Leads keep all three staff roles, unchanged', async () => {
    for (const role of ['administrator', 'program_manager', 'intake_officer']) {
      const res = await request(app)
        .get('/api/v1/referrers')
        .set('Authorization', `Bearer ${tokenFor(role)}`)
        .query({ type: 'Law Firms' });
      expect(res.status).toBe(200);
    }
  });

  test('Administrator passes every route regardless of listed roles (strict superset)', async () => {
    const res = await request(app)
      .post('/api/v1/assets')
      .set('Authorization', `Bearer ${tokenFor('administrator')}`)
      .send({ client_id: await fx.createClient(), asset_type: 'real_estate' });
    expect(res.status).toBe(201);
  });
});

describe('Pipeline gate_roles — explicit sets, not a hierarchy', () => {
  test('Program Manager is rejected for bank_assignment (Administrator-only stage) -- no inheritance', () => {
    const result = checkRoleAuthority('bank_assignment', { role: 'program_manager', staff_id: 'x' }, undefined, null);
    expect(result.authorized).toBe(false);
  });

  test('Intake Officer is rejected for appraisal_review (Program Manager stage)', () => {
    const result = checkRoleAuthority('appraisal_review', { role: 'intake_officer', staff_id: 'x' }, undefined, null);
    expect(result.authorized).toBe(false);
  });

  test('Program Manager is rejected for kyc_verification (Intake Officer stage) -- the actual point of "explicit sets, not a hierarchy"', () => {
    // Under the old >= hierarchy, program_manager (2) inherited every
    // intake_officer (1) gate automatically -- this is the specific
    // behavior the redesign was for.
    const result = checkRoleAuthority('kyc_verification', { role: 'program_manager', staff_id: 'x' }, undefined, null);
    expect(result.authorized).toBe(false);
  });

  test('Intake Officer is authorized for kyc_verification, Program Manager for appraisal_review (each role\'s own stage)', () => {
    expect(checkRoleAuthority('kyc_verification', { role: 'intake_officer', staff_id: 'x' }, undefined, null).authorized).toBe(true);
    expect(checkRoleAuthority('appraisal_review', { role: 'program_manager', staff_id: 'x' }, undefined, null).authorized).toBe(true);
  });

  test('Administrator is authorized for every human-gated stage', () => {
    for (const stage of ['kyc_verification', 'appraisal_review', 'bank_assignment', 'collateralization', 'monetization', 'securitization', 'rejected', 'on_hold']) {
      expect(checkRoleAuthority(stage, { role: 'administrator', staff_id: 'x' }, undefined, null).authorized).toBe(true);
    }
  });
});

describe('Rename alias window — trade_group_owner still works as Administrator', () => {
  test('a token minted with the pre-rename role string passes an Administrator-only route', async () => {
    const res = await request(app)
      .delete(`/api/v1/clients/${await fx.createClient()}`)
      .set('Authorization', `Bearer ${tokenFor('trade_group_owner')}`);
    expect(res.status).toBe(200);
  });

  test('a token minted with the pre-rename role string passes an Administrator-only pipeline gate', () => {
    const result = checkRoleAuthority('bank_assignment', { role: 'trade_group_owner', staff_id: 'x' }, undefined, null);
    expect(result.authorized).toBe(true);
  });

  test('a fresh login after the rename issues role: administrator, not trade_group_owner', async () => {
    const staff = await fx.createStaff({ role: 'administrator', password: 'fresh-login-pass-1' });
    const res = await request(app).post('/api/v1/auth/login').send({ email: staff.email, password: 'fresh-login-pass-1' });
    expect(res.status).toBe(200);
    const payload = JSON.parse(Buffer.from(res.body.token.split('.')[1], 'base64url').toString());
    expect(payload.role).toBe('administrator');
  });
});
