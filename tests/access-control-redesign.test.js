// 2026-08-17 access-control redesign: legal-review attestation, the
// explicit gate_roles permission sets replacing pipeline.js's old
// hierarchy, and the trade_group_owner -> administrator rename's alias
// window. Real Express app, real HTTP requests via supertest, real
// isolated local database (see tests/env.setup.js) -- same pattern as
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
const { checkRoleAuthority } = require('../api/services/pipeline');

function tokenFor(role, sub = 'test-fixture') {
  return jwt.sign({ sub, role }, process.env.JWT_SECRET, { expiresIn: '5m' });
}

afterAll(async () => {
  await Promise.all([db.clients.end(), db.assets.end(), db.forms.end(), db.pehf.end()]);
});

describe('Legal-review attestation — two-step entry/countersign', () => {
  test('entry by Intake Officer, countersign by Administrator, satisfies the kyc_verification gate', async () => {
    const client_id = await fx.createClient();
    await fx.addKycDocument(client_id);
    await fx.addPofRecord(client_id);
    await fx.confirmOfacAttestation(client_id);

    // Gate blocks before any attestation exists.
    const beforeErrors = await require('../api/services/pipeline').validateGate('kyc_verification', null, client_id);
    expect(beforeErrors).toEqual(expect.arrayContaining(['No legal-review attestation on file']));

    const entryRes = await request(app)
      .post(`/api/v1/clients/${client_id}/legal-attestation`)
      .set('Authorization', `Bearer ${tokenFor('intake_officer', 'io1@example.test')}`)
      .send({ counsel_name: 'Jane Counsel, Esq.', review_date: '2026-08-17', reference: 'Matter #4471' });
    expect(entryRes.status).toBe(201);
    expect(entryRes.body.status).toBe('pending_countersign');

    // Gate distinguishes "pending" from "none" -- not the same message.
    const pendingErrors = await require('../api/services/pipeline').validateGate('kyc_verification', null, client_id);
    expect(pendingErrors).toEqual(expect.arrayContaining(['Legal attestation recorded but not yet countersigned by an Administrator']));
    expect(pendingErrors).not.toContain('No legal-review attestation on file');

    const countersignRes = await request(app)
      .patch(`/api/v1/clients/${client_id}/legal-attestation/${entryRes.body.attestation_id}/countersign`)
      .set('Authorization', `Bearer ${tokenFor('administrator', 'admin1@example.test')}`)
      .send({});
    expect(countersignRes.status).toBe(200);
    expect(countersignRes.body.status).toBe('confirmed');

    // Gate now clears the legal-attestation condition specifically (KYC/POF/OFAC
    // already satisfied by the fixtures above).
    const afterErrors = await require('../api/services/pipeline').validateGate('kyc_verification', null, client_id);
    expect(afterErrors).toEqual([]);
  });

  test('same principal cannot countersign their own attestation entry', async () => {
    const client_id = await fx.createClient();
    const entryRes = await request(app)
      .post(`/api/v1/clients/${client_id}/legal-attestation`)
      .set('Authorization', `Bearer ${tokenFor('intake_officer', 'same-person@example.test')}`)
      .send({ counsel_name: 'John Counsel', review_date: '2026-08-17', reference: 'Matter #1' });
    expect(entryRes.status).toBe(201);

    // Same email, but now presenting as an Administrator -- still the same
    // principal, dual control must still reject it.
    const countersignRes = await request(app)
      .patch(`/api/v1/clients/${client_id}/legal-attestation/${entryRes.body.attestation_id}/countersign`)
      .set('Authorization', `Bearer ${tokenFor('administrator', 'same-person@example.test')}`)
      .send({});
    expect(countersignRes.status).toBe(403);

    const row = await db.clients.query(`SELECT status FROM pcm_legal_attestations WHERE attestation_id = $1`, [entryRes.body.attestation_id]);
    expect(row.rows[0].status).toBe('pending_countersign');
  });

  test('Program Manager cannot record a legal attestation, Intake Officer cannot countersign one', async () => {
    const client_id = await fx.createClient();

    const pmEntry = await request(app)
      .post(`/api/v1/clients/${client_id}/legal-attestation`)
      .set('Authorization', `Bearer ${tokenFor('program_manager')}`)
      .send({ counsel_name: 'X', review_date: '2026-08-17', reference: 'Y' });
    expect(pmEntry.status).toBe(403);

    const ioEntry = await request(app)
      .post(`/api/v1/clients/${client_id}/legal-attestation`)
      .set('Authorization', `Bearer ${tokenFor('intake_officer', 'io2@example.test')}`)
      .send({ counsel_name: 'X', review_date: '2026-08-17', reference: 'Y' });
    expect(ioEntry.status).toBe(201);

    const ioCountersign = await request(app)
      .patch(`/api/v1/clients/${client_id}/legal-attestation/${ioEntry.body.attestation_id}/countersign`)
      .set('Authorization', `Bearer ${tokenFor('intake_officer', 'io3@example.test')}`)
      .send({});
    expect(ioCountersign.status).toBe(403);
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
    const result = checkRoleAuthority('bank_assignment', 'program_manager', undefined);
    expect(result.authorized).toBe(false);
  });

  test('Intake Officer is rejected for appraisal_review (Program Manager stage)', () => {
    const result = checkRoleAuthority('appraisal_review', 'intake_officer', undefined);
    expect(result.authorized).toBe(false);
  });

  test('Program Manager is rejected for kyc_verification (Intake Officer stage) -- the actual point of "explicit sets, not a hierarchy"', () => {
    // Under the old >= hierarchy, program_manager (2) inherited every
    // intake_officer (1) gate automatically -- this is the specific
    // behavior the redesign was for.
    const result = checkRoleAuthority('kyc_verification', 'program_manager', undefined);
    expect(result.authorized).toBe(false);
  });

  test('Intake Officer is authorized for kyc_verification, Program Manager for appraisal_review (each role\'s own stage)', () => {
    expect(checkRoleAuthority('kyc_verification', 'intake_officer', undefined).authorized).toBe(true);
    expect(checkRoleAuthority('appraisal_review', 'program_manager', undefined).authorized).toBe(true);
  });

  test('Administrator is authorized for every human-gated stage', () => {
    for (const stage of ['kyc_verification', 'appraisal_review', 'bank_assignment', 'collateralization', 'monetization', 'securitization', 'rejected', 'on_hold']) {
      expect(checkRoleAuthority(stage, 'administrator', undefined).authorized).toBe(true);
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
    const result = checkRoleAuthority('bank_assignment', 'trade_group_owner', undefined);
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
