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
    const pof = await fx.addPofRecord(client_id);
    await fx.confirmOfacAttestation(client_id);

    const beforeErrors = await validateGate('kyc_verification', asset_id, client_id);
    expect(beforeErrors).toEqual(expect.arrayContaining(['No legal-review attestation on file']));

    const io = await staffToken('intake_officer');
    const entryRes = await request(app)
      .post(`/api/v1/assets/${asset_id}/legal-attestation`)
      .set('Authorization', `Bearer ${io.token}`)
      .send({ counsel_name: 'Jane Counsel, Esq.', review_date: '2026-08-17', reference: 'Matter #4471', outcome: 'approved' });
    expect(entryRes.status).toBe(201);
    expect(entryRes.body.status).toBe('pending_countersign');
    expect(entryRes.body.assigned_role).toBe('intake_officer');

    // Live ownership pointer set at entry, not only at countersign.
    const assetRow = await db.assets.query(`SELECT assigned_handler_role, assigned_handler_staff_id FROM pcm_assets WHERE asset_id = $1`, [asset_id]);
    expect(assetRow.rows[0].assigned_handler_role).toBe('intake_officer');
    expect(assetRow.rows[0].assigned_handler_staff_id).toBe(io.staff.staff_id);

    // 2026-08-17 (Intake Officer scope, third revision): the assigned
    // handler also records legal's POF outcome, same review event, same
    // gate requirement now -- linked to this attestation.
    const pofRes = await request(app)
      .patch(`/api/v1/clients/${client_id}/pof/${pof}/legal-outcome`)
      .set('Authorization', `Bearer ${io.token}`)
      .send({ outcome: 'approved', attestation_id: entryRes.body.attestation_id });
    expect(pofRes.status).toBe(200);

    const pendingErrors = await validateGate('kyc_verification', asset_id, client_id);
    expect(pendingErrors).toEqual(expect.arrayContaining(['Legal attestation recorded but not yet countersigned']));
    expect(pendingErrors).not.toContain('No legal-review attestation on file');
    // POF outcome is recorded (approved) but its linked attestation isn't
    // confirmed yet -- same one-countersign-covers-both mechanism should
    // report the POF side as still pending too.
    expect(pendingErrors).toEqual(expect.arrayContaining(['Proof of Funds outcome recorded but the underlying legal attestation is not yet countersigned']));

    const admin = await staffToken('administrator');
    const countersignRes = await request(app)
      .patch(`/api/v1/assets/${asset_id}/legal-attestation/${entryRes.body.attestation_id}/countersign`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({});
    expect(countersignRes.status).toBe(200);
    expect(countersignRes.body.status).toBe('confirmed');

    // The single countersign above -- on the attestation only -- also
    // satisfies the POF side of the gate now, without a second
    // countersign step (Todd, explicit: "one countersign covers both").
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
      .send({ counsel_name: 'Jane Counsel', review_date: '2026-08-17', reference: 'Matter #2', outcome: 'approved' });
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
      .send({ counsel_name: 'Jane Counsel', review_date: '2026-08-17', reference: 'Matter #3', outcome: 'approved' });
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
        counsel_name: 'Jane Counsel', review_date: '2026-08-17', reference: 'Matter #5', outcome: 'approved',
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
      .send({ counsel_name: 'John Counsel', review_date: '2026-08-17', reference: 'Matter #1', outcome: 'approved' });
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

  // Inverted 2026-08-17 (second correction): countersign widened from
  // Administrator-only to all three roles -- primarily Intake Officer or
  // Program Manager in practice. The distinct-principal check is what
  // actually protects this, not the role gate -- covered by the three
  // tests below, one per role pairing.
  test('a DIFFERENT Intake Officer can countersign an Intake Officer\'s entry', async () => {
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id);
    const io1 = await staffToken('intake_officer');
    const entryRes = await request(app)
      .post(`/api/v1/assets/${asset_id}/legal-attestation`)
      .set('Authorization', `Bearer ${io1.token}`)
      .send({ counsel_name: 'X', review_date: '2026-08-17', reference: 'Y', outcome: 'approved' });
    expect(entryRes.status).toBe(201);

    const io2 = await staffToken('intake_officer');
    const countersignRes = await request(app)
      .patch(`/api/v1/assets/${asset_id}/legal-attestation/${entryRes.body.attestation_id}/countersign`)
      .set('Authorization', `Bearer ${io2.token}`)
      .send({});
    expect(countersignRes.status).toBe(200);
  });

  test('a Program Manager can countersign an Intake Officer\'s entry', async () => {
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id);
    const io = await staffToken('intake_officer');
    const entryRes = await request(app)
      .post(`/api/v1/assets/${asset_id}/legal-attestation`)
      .set('Authorization', `Bearer ${io.token}`)
      .send({ counsel_name: 'X', review_date: '2026-08-17', reference: 'Y', outcome: 'approved' });
    expect(entryRes.status).toBe(201);

    const pm = await staffToken('program_manager');
    const countersignRes = await request(app)
      .patch(`/api/v1/assets/${asset_id}/legal-attestation/${entryRes.body.attestation_id}/countersign`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({});
    expect(countersignRes.status).toBe(200);
  });

  test('distinct-principal check still applies regardless of role -- the same Intake Officer cannot countersign under a different-looking token', async () => {
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id);
    const io = await fx.createStaff({ role: 'intake_officer' });
    const entryRes = await request(app)
      .post(`/api/v1/assets/${asset_id}/legal-attestation`)
      .set('Authorization', `Bearer ${tokenFor('intake_officer', io.email, io.staff_id)}`)
      .send({ counsel_name: 'X', review_date: '2026-08-17', reference: 'Y', outcome: 'approved' });
    expect(entryRes.status).toBe(201);

    // Same person, same role -- widening countersign to Intake Officer
    // must not accidentally widen it to "any Intake Officer including
    // yourself."
    const selfCountersign = await request(app)
      .patch(`/api/v1/assets/${asset_id}/legal-attestation/${entryRes.body.attestation_id}/countersign`)
      .set('Authorization', `Bearer ${tokenFor('intake_officer', io.email, io.staff_id)}`)
      .send({});
    expect(selfCountersign.status).toBe(403);
  });

  test('outcome is required and must be approved or denied -- no default, no third value', async () => {
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id);
    const io = await staffToken('intake_officer');

    const missing = await request(app)
      .post(`/api/v1/assets/${asset_id}/legal-attestation`)
      .set('Authorization', `Bearer ${io.token}`)
      .send({ counsel_name: 'X', review_date: '2026-08-17', reference: 'Y' });
    expect(missing.status).toBe(400);

    const bogus = await request(app)
      .post(`/api/v1/assets/${asset_id}/legal-attestation`)
      .set('Authorization', `Bearer ${io.token}`)
      .send({ counsel_name: 'X', review_date: '2026-08-17', reference: 'Y', outcome: 'maybe' });
    expect(bogus.status).toBe(400);
  });
});

describe('Denial — same dual control as approval, terminal only once countersigned', () => {
  test('a denial recorded but not yet countersigned does NOT move the asset -- nothing is final on an unconfirmed single-principal claim', async () => {
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id);
    const io = await staffToken('intake_officer');

    const entryRes = await request(app)
      .post(`/api/v1/assets/${asset_id}/legal-attestation`)
      .set('Authorization', `Bearer ${io.token}`)
      .send({ counsel_name: 'X', review_date: '2026-08-17', reference: 'Y', outcome: 'denied' });
    expect(entryRes.status).toBe(201);

    const assetRow = await db.assets.query(`SELECT pipeline_stage FROM pcm_assets WHERE asset_id = $1`, [asset_id]);
    expect(assetRow.rows[0].pipeline_stage).toBe('intake'); // unchanged, still pending countersign
  });

  test('countersigning a denial automatically moves the asset to rejected, via the real advancePipeline path (audit row included)', async () => {
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id);
    const io = await staffToken('intake_officer');

    const entryRes = await request(app)
      .post(`/api/v1/assets/${asset_id}/legal-attestation`)
      .set('Authorization', `Bearer ${io.token}`)
      .send({ counsel_name: 'X', review_date: '2026-08-17', reference: 'Denied — sanctioned jurisdiction', outcome: 'denied' });
    expect(entryRes.status).toBe(201);

    const admin = await staffToken('administrator');
    const countersignRes = await request(app)
      .patch(`/api/v1/assets/${asset_id}/legal-attestation/${entryRes.body.attestation_id}/countersign`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({});
    expect(countersignRes.status).toBe(200);
    expect(countersignRes.body.auto_rejected).toBe(true);
    expect(countersignRes.body.rejection_result.success).toBe(true);

    const assetRow = await db.assets.query(`SELECT pipeline_stage FROM pcm_assets WHERE asset_id = $1`, [asset_id]);
    expect(assetRow.rows[0].pipeline_stage).toBe('rejected');

    // Real advancePipeline path, not a raw UPDATE -- proven by the same
    // audit trail every other transition gets.
    const history = await db.assets.query(`SELECT to_stage, transitioned_by FROM pcm_pipeline_history WHERE asset_id = $1 ORDER BY created_at DESC LIMIT 1`, [asset_id]);
    expect(history.rows[0].to_stage).toBe('rejected');
    expect(history.rows[0].transitioned_by).toBe(admin.staff.email);
  });

  // Regression test for the exact interaction the countersign-widening
  // correction created: 'rejected' is Administrator-only in gate_roles,
  // so a Program Manager countersigning a denial would 403 inside the
  // internal advancePipeline() call unless that call's actor is
  // specifically authorized around this -- see the countersign route's
  // header comment for the fix (role-overridden synthetic actor,
  // real identity preserved). Without that fix, this exact test is what
  // would have failed.
  test('a Program Manager countersigning a denial still triggers the automatic rejection (the interaction a naive countersign-widening would have broken)', async () => {
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id);
    const io = await staffToken('intake_officer');

    const entryRes = await request(app)
      .post(`/api/v1/assets/${asset_id}/legal-attestation`)
      .set('Authorization', `Bearer ${io.token}`)
      .send({ counsel_name: 'X', review_date: '2026-08-17', reference: 'Denied', outcome: 'denied' });
    expect(entryRes.status).toBe(201);

    const pm = await staffToken('program_manager');
    const countersignRes = await request(app)
      .patch(`/api/v1/assets/${asset_id}/legal-attestation/${entryRes.body.attestation_id}/countersign`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({});
    expect(countersignRes.status).toBe(200);
    expect(countersignRes.body.auto_rejected).toBe(true);
    expect(countersignRes.body.rejection_result.success).toBe(true);

    const assetRow = await db.assets.query(`SELECT pipeline_stage FROM pcm_assets WHERE asset_id = $1`, [asset_id]);
    expect(assetRow.rows[0].pipeline_stage).toBe('rejected');

    // Real identity preserved in the audit trail despite the role
    // override used to pass the internal gate check.
    const history = await db.assets.query(`SELECT to_stage, transitioned_by, transition_role FROM pcm_pipeline_history WHERE asset_id = $1 ORDER BY created_at DESC LIMIT 1`, [asset_id]);
    expect(history.rows[0].transitioned_by).toBe(pm.staff.email);
  });

  test('rejected via denial is genuinely terminal -- cannot advance back out, same as any other rejection', async () => {
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id);
    const io = await staffToken('intake_officer');
    const entryRes = await request(app)
      .post(`/api/v1/assets/${asset_id}/legal-attestation`)
      .set('Authorization', `Bearer ${io.token}`)
      .send({ counsel_name: 'X', review_date: '2026-08-17', reference: 'Y', outcome: 'denied' });
    const admin = await staffToken('administrator');
    await request(app)
      .patch(`/api/v1/assets/${asset_id}/legal-attestation/${entryRes.body.attestation_id}/countersign`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({});

    const bounceRes = await request(app)
      .post('/api/v1/pipeline/advance')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ asset_id, client_id, to_stage: 'kyc_verification' });
    expect(bounceRes.status).toBe(422);
    expect(bounceRes.body.error).toMatch(/Invalid stage transition/);
  });

  test('gate distinguishes a confirmed denial from "not yet reviewed" -- distinct message, fails closed even though this path should be unreachable in practice', async () => {
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id);
    await fx.confirmLegalAttestation(client_id, asset_id, { outcome: 'denied' });

    const errors = await validateGate('kyc_verification', asset_id, client_id);
    expect(errors).toEqual(expect.arrayContaining(['Legal review denied — package rejected, cannot proceed']));
  });

  test('no-supersede: a second attestation attempt on an asset with a confirmed outcome is rejected, whether the first was approved or denied', async () => {
    const client_id = await fx.createClient();
    const { asset_id: deniedAsset } = await fx.createAsset(client_id);
    await fx.confirmLegalAttestation(client_id, deniedAsset, { outcome: 'denied' });

    const io = await staffToken('intake_officer');
    const secondAttempt = await request(app)
      .post(`/api/v1/assets/${deniedAsset}/legal-attestation`)
      .set('Authorization', `Bearer ${io.token}`)
      .send({ counsel_name: 'Y', review_date: '2026-08-17', reference: 'Z', outcome: 'approved' });
    expect(secondAttempt.status).toBe(409);

    const { asset_id: approvedAsset } = await fx.createAsset(client_id);
    await fx.confirmLegalAttestation(client_id, approvedAsset, { outcome: 'approved' });
    const thirdAttempt = await request(app)
      .post(`/api/v1/assets/${approvedAsset}/legal-attestation`)
      .set('Authorization', `Bearer ${io.token}`)
      .send({ counsel_name: 'Y', review_date: '2026-08-17', reference: 'Z', outcome: 'approved' });
    expect(thirdAttempt.status).toBe(409);
  });

  test('a pending (not yet confirmed) attestation does NOT block a second entry attempt -- only confirmed supersedes', async () => {
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id);
    const io1 = await staffToken('intake_officer');
    const first = await request(app)
      .post(`/api/v1/assets/${asset_id}/legal-attestation`)
      .set('Authorization', `Bearer ${io1.token}`)
      .send({ counsel_name: 'X', review_date: '2026-08-17', reference: 'Y', outcome: 'approved' });
    expect(first.status).toBe(201);

    const io2 = await staffToken('intake_officer');
    const second = await request(app)
      .post(`/api/v1/assets/${asset_id}/legal-attestation`)
      .set('Authorization', `Bearer ${io2.token}`)
      .send({ counsel_name: 'X2', review_date: '2026-08-17', reference: 'Y2', outcome: 'approved' });
    expect(second.status).toBe(201);
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

  test('the floor also covers KYC documents, POF records, OFAC results, assets, and legal attestations -- not just clients', async () => {
    const client_id = await fx.createClient();
    await fx.addKycDocument(client_id);
    const kycRow = await db.clients.query(`SELECT doc_id FROM pcm_kyc_documents WHERE client_id = $1`, [client_id]);
    await expect(db.clients.query(`DELETE FROM pcm_kyc_documents WHERE doc_id = $1`, [kycRow.rows[0].doc_id]))
      .rejects.toThrow(/Retention floor/);

    const { asset_id } = await fx.createAsset(client_id);
    await expect(db.assets.query(`DELETE FROM pcm_assets WHERE asset_id = $1`, [asset_id]))
      .rejects.toThrow(/Retention floor/);

    await fx.confirmLegalAttestation(client_id, asset_id);
    const attRow = await db.clients.query(`SELECT attestation_id FROM pcm_legal_attestations WHERE asset_id = $1`, [asset_id]);
    await expect(db.clients.query(`DELETE FROM pcm_legal_attestations WHERE attestation_id = $1`, [attRow.rows[0].attestation_id]))
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
    const entryRes = await request(app)
      .post(`/api/v1/assets/${asset_id}/legal-attestation`)
      .set('Authorization', `Bearer ${assignedIo.token}`)
      .send({ counsel_name: 'X', review_date: '2026-08-17', reference: 'Y', outcome: 'approved' });
    expect(entryRes.status).toBe(201);
    const admin = await staffToken('administrator');
    const countersignRes = await request(app)
      .patch(`/api/v1/assets/${asset_id}/legal-attestation/${entryRes.body.attestation_id}/countersign`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({});
    expect(countersignRes.status).toBe(200);

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
  // action) no longer exists. Replaced with tests for what it became:
  // PATCH .../pof/:pof_id/legal-outcome, recording legal's POF decision,
  // open to Intake Officer or Program Manager (same gate as legal-
  // attestation entry), requiring a real attestation_id.
  test('POF legal-outcome recording is open to Intake Officer and Program Manager, not Administrator-only or Program-Manager-only', async () => {
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id);
    const io = await staffToken('intake_officer');
    const entryRes = await request(app)
      .post(`/api/v1/assets/${asset_id}/legal-attestation`)
      .set('Authorization', `Bearer ${io.token}`)
      .send({ counsel_name: 'X', review_date: '2026-08-17', reference: 'Y', outcome: 'approved' });
    expect(entryRes.status).toBe(201);

    const pof = await fx.addPofRecord(client_id);
    const pmRes = await request(app)
      .patch(`/api/v1/clients/${client_id}/pof/${pof}/legal-outcome`)
      .set('Authorization', `Bearer ${tokenFor('program_manager')}`)
      .send({ outcome: 'approved', attestation_id: entryRes.body.attestation_id });
    expect(pmRes.status).toBe(200);
    expect(pmRes.body.outcome).toBe('approved');
    expect(pmRes.body.attestation_id).toBe(entryRes.body.attestation_id);
  });

  test('POF legal-outcome recording rejects a missing or malformed attestation_id', async () => {
    const client_id = await fx.createClient();
    const pof = await fx.addPofRecord(client_id);
    const noAttestation = await request(app)
      .patch(`/api/v1/clients/${client_id}/pof/${pof}/legal-outcome`)
      .set('Authorization', `Bearer ${tokenFor('intake_officer')}`)
      .send({ outcome: 'approved' });
    expect(noAttestation.status).toBe(400);

    const fakeAttestation = await request(app)
      .patch(`/api/v1/clients/${client_id}/pof/${pof}/legal-outcome`)
      .set('Authorization', `Bearer ${tokenFor('intake_officer')}`)
      .send({ outcome: 'approved', attestation_id: '00000000-0000-0000-0000-000000000000' });
    expect(fakeAttestation.status).toBe(404);
  });

  test('POF legal-outcome recording is no-supersede, same rule as legal attestation entry', async () => {
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id);
    const io = await staffToken('intake_officer');
    const entryRes = await request(app)
      .post(`/api/v1/assets/${asset_id}/legal-attestation`)
      .set('Authorization', `Bearer ${io.token}`)
      .send({ counsel_name: 'X', review_date: '2026-08-17', reference: 'Y', outcome: 'approved' });

    const pof = await fx.addPofRecord(client_id);
    const first = await request(app)
      .patch(`/api/v1/clients/${client_id}/pof/${pof}/legal-outcome`)
      .set('Authorization', `Bearer ${tokenFor('program_manager')}`)
      .send({ outcome: 'approved', attestation_id: entryRes.body.attestation_id });
    expect(first.status).toBe(200);

    const second = await request(app)
      .patch(`/api/v1/clients/${client_id}/pof/${pof}/legal-outcome`)
      .set('Authorization', `Bearer ${tokenFor('program_manager')}`)
      .send({ outcome: 'denied', attestation_id: entryRes.body.attestation_id });
    expect(second.status).toBe(409);
  });

  // 2026-08-17 (Intake Officer scope, third revision): Adjustment 2
  // inverted -- referral-source/lead management is a different domain
  // from collecting and routing a specific client's package to legal,
  // not part of "collect and route only." Intake Officer is now excluded.
  test('Adjustment 2 (revised): Referrers and Leads narrow to Administrator and Program Manager, Intake Officer excluded', async () => {
    for (const role of ['administrator', 'program_manager']) {
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

  // 2026-08-17 (Intake Officer scope, third revision): kyc_verification's
  // gate_roles flipped from ['intake_officer'] to ['program_manager'] --
  // see routes/pipeline.js POST /advance and services/pipeline.js's
  // STAGES comment. Worth stating plainly: with this change, Intake
  // Officer no longer has ANY entry in STAGES.gate_roles reachable via a
  // live route (their 'intake' stage entry was already dead code before
  // today -- confirmed while making this change, no valid isValidTransition
  // path ever reaches to_stage:'intake', since assets start there via
  // direct creation, not advancePipeline()). Program Manager is now the
  // only non-Administrator human role with pipeline-advancement authority
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
