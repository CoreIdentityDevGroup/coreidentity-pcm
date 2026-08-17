// Phase 6.1 (SCRUB) — Step 4d: the end-to-end HTTP proof, previously
// deferred "for lack of production data." Completed here against the
// isolated local database (real schema, zero production data) instead --
// a real Express app, a real HTTP request/response cycle via supertest,
// hitting the real POST /api/v1/pipeline/advance route, which calls the
// real advancePipeline().
'use strict';

jest.mock('../api/services/governance', () => ({
  ...jest.requireActual('../api/services/governance'),
  sentinelCheck: jest.fn().mockResolvedValue({ allowed: true, decision: 'ALLOW', reason: null })
}));

process.env.PORT = '34177'; // distinct test-only port, avoids colliding with anything else on this box

const jwt = require('jsonwebtoken');
const request = require('supertest');
const app = require('../api/app');
const db = require('../api/services/db');
const fx = require('./fixtures');

function tokenFor(role) {
  return jwt.sign({ sub: 'test-http-proof', role }, process.env.JWT_SECRET, { expiresIn: '5m' });
}

afterAll(async () => {
  await Promise.all([db.clients.end(), db.assets.end(), db.forms.end(), db.pehf.end()]);
});

// 2026-08-17 (Intake Officer scope, third revision): tests below switched
// from intake_officer to program_manager for /pipeline/advance calls --
// Intake Officer no longer has route-level access to this endpoint at all
// (routes/pipeline.js POST /advance), so these generic gate-enforcement
// proofs (not specifically about Intake Officer's access) needed an actor
// who still has it. Separately, kyc_verification's gate_roles itself also
// flipped to program_manager -- see services/pipeline.js's STAGES.
describe('Step 4d — real HTTP proof of gate enforcement', () => {
  test('POST /api/v1/pipeline/advance with missing evidence -> real HTTP 422, not silently 200', async () => {
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id);

    const res = await request(app)
      .post('/api/v1/pipeline/advance')
      .set('Authorization', `Bearer ${tokenFor('program_manager')}`)
      .send({ asset_id, client_id, to_stage: 'kyc_verification' });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/Gate requirements not met/);
    expect(res.body.gate_errors).toEqual(expect.arrayContaining([expect.stringContaining('No KYC documents on file')]));

    // Confirm the block is real at the HTTP boundary too: the asset must
    // not have advanced in the database a real client would then read.
    const check = await db.assets.query(`SELECT pipeline_stage FROM pcm_assets WHERE asset_id = $1`, [asset_id]);
    expect(check.rows[0].pipeline_stage).toBe('intake');
  });

  test('POST /api/v1/pipeline/advance with unauthenticated request -> real HTTP 401', async () => {
    const res = await request(app)
      .post('/api/v1/pipeline/advance')
      .send({ asset_id: 'x', client_id: 'y', to_stage: 'kyc_verification' });
    expect(res.status).toBe(401);
  });

  test('POST /api/v1/pipeline/advance with full real evidence -> real HTTP 200, stage actually advances', async () => {
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id);
    await fx.addKycDocument(client_id);
    await fx.addPofRecord(client_id);
    await fx.confirmOfacAttestation(client_id);
    await fx.confirmLegalAttestation(client_id, asset_id);

    const res = await request(app)
      .post('/api/v1/pipeline/advance')
      .set('Authorization', `Bearer ${tokenFor('program_manager')}`)
      .send({ asset_id, client_id, to_stage: 'kyc_verification' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const check = await db.assets.query(`SELECT pipeline_stage FROM pcm_assets WHERE asset_id = $1`, [asset_id]);
    expect(check.rows[0].pipeline_stage).toBe('kyc_verification');
  });

  test('POST /api/v1/pipeline/advance with wrong role for the target stage -> real HTTP 403', async () => {
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id);
    await fx.addKycDocument(client_id);
    await fx.addPofRecord(client_id);
    await fx.confirmOfacAttestation(client_id);
    await fx.confirmLegalAttestation(client_id, asset_id);

    // kyc_verification's gate_roles is ['program_manager'] (explicit set,
    // not a hierarchy -- 2026-08-17 redesign, flipped from
    // ['intake_officer'] the same day -- see STAGES' comment);
    // Administrator passes every gate by definition. 'system' is in
    // neither category and is deliberately rejected here. Intake Officer
    // would ALSO be rejected now (both by this gate and, more
    // fundamentally, by the route itself no longer accepting them at
    // all), not tested separately here since 'system' already proves the
    // route-level rejection path.
    const res = await request(app)
      .post('/api/v1/pipeline/advance')
      .set('Authorization', `Bearer ${tokenFor('system')}`)
      .send({ asset_id, client_id, to_stage: 'kyc_verification' });

    expect(res.status).toBe(403);
  });

  test('POST /api/v1/pipeline/hold then /resume (CLOSE-GAP-30) -> real HTTP round trip back to the exact pre-hold stage', async () => {
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id);
    await fx.addKycDocument(client_id);
    await fx.addPofRecord(client_id);
    await fx.confirmOfacAttestation(client_id);
    await fx.confirmLegalAttestation(client_id, asset_id);

    const toKyc = await request(app)
      .post('/api/v1/pipeline/advance')
      .set('Authorization', `Bearer ${tokenFor('program_manager')}`)
      .send({ asset_id, client_id, to_stage: 'kyc_verification' });
    expect(toKyc.status).toBe(200);

    const toHold = await request(app)
      .post('/api/v1/pipeline/hold')
      .set('Authorization', `Bearer ${tokenFor('program_manager')}`)
      .send({ asset_id, client_id, notes: 'http-proof hold' });
    expect(toHold.status).toBe(200);
    expect(toHold.body.success).toBe(true);

    // Deliberately still 'trade_group_owner', not 'administrator' -- this
    // doubles as a regression test of the alias window (authorize.js's
    // normalizeRole()): a token minted with the pre-rename role string
    // must still pass an Administrator-level gate. See
    // tests/access-control-redesign.test.js for the explicit alias tests.
    const resumed = await request(app)
      .post('/api/v1/pipeline/resume')
      .set('Authorization', `Bearer ${tokenFor('trade_group_owner')}`)
      .send({ asset_id, client_id });
    expect(resumed.status).toBe(200);
    expect(resumed.body.success).toBe(true);

    const check = await db.assets.query(`SELECT pipeline_stage FROM pcm_assets WHERE asset_id = $1`, [asset_id]);
    expect(check.rows[0].pipeline_stage).toBe('kyc_verification');
  });
});
