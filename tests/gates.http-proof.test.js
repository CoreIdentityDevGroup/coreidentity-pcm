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

describe('Step 4d — real HTTP proof of gate enforcement', () => {
  test('POST /api/v1/pipeline/advance with missing evidence -> real HTTP 422, not silently 200', async () => {
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id);

    const res = await request(app)
      .post('/api/v1/pipeline/advance')
      .set('Authorization', `Bearer ${tokenFor('intake_officer')}`)
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

    const res = await request(app)
      .post('/api/v1/pipeline/advance')
      .set('Authorization', `Bearer ${tokenFor('intake_officer')}`)
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

    // kyc_verification requires intake_officer or higher in the role
    // hierarchy (trade_group_owner:3, program_manager:2,
    // intake_officer:1) -- CUSTOMER-equivalent low-privilege role
    // rejected here is deliberately below that.
    const res = await request(app)
      .post('/api/v1/pipeline/advance')
      .set('Authorization', `Bearer ${tokenFor('system')}`)
      .send({ asset_id, client_id, to_stage: 'kyc_verification' });

    expect(res.status).toBe(403);
  });
});
