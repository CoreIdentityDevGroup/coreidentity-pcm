// Phase B (B4) closeout: bank_id validation on POST /assets/:id/bank-assignment
// -- reviewed by hand at the time it shipped, never exercised by the suite.
// A validation branch that has never run is unverified.
'use strict';

const jwt     = require('jsonwebtoken');
const request = require('supertest');
const app     = require('../api/app');
const db      = require('../api/services/db');
const fx      = require('./fixtures');

function tokenFor(role) {
  return jwt.sign({ sub: 'test-bank-assignment', role }, process.env.JWT_SECRET, { expiresIn: '5m' });
}

afterAll(async () => {
  await Promise.all([db.clients.end(), db.assets.end(), db.forms.end(), db.pehf.end()]);
});

describe('POST /assets/:id/bank-assignment — bank_id validation', () => {
  test('a valid, active bank_id resolves and is stored', async () => {
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id);
    const bank = await fx.createRefBank();

    const res = await request(app)
      .post(`/api/v1/assets/${asset_id}/bank-assignment`)
      .set('Authorization', `Bearer ${tokenFor('program_manager')}`)
      .send({ bank_id: bank.bank_id, bank_name: bank.name, bank_jurisdiction: 'us' });

    expect(res.status).toBe(201);
    expect(res.body.bank_id).toBe(bank.bank_id);

    const row = await db.assets.query(`SELECT bank_id FROM pcm_bank_assignments WHERE asset_id = $1`, [asset_id]);
    expect(row.rows[0].bank_id).toBe(bank.bank_id);
  });

  test('an unknown bank_id (not in pcm_banks at all) is refused with 400', async () => {
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id);

    const res = await request(app)
      .post(`/api/v1/assets/${asset_id}/bank-assignment`)
      .set('Authorization', `Bearer ${tokenFor('program_manager')}`)
      .send({ bank_id: '00000000-0000-0000-0000-000000000000', bank_name: 'Ghost Bank', bank_jurisdiction: 'us' });

    expect(res.status).toBe(400);

    const row = await db.assets.query(`SELECT COUNT(*) FROM pcm_bank_assignments WHERE asset_id = $1`, [asset_id]);
    expect(parseInt(row.rows[0].count)).toBe(0);
  });

  test('a real but inactive bank_id is refused with 400 -- existence alone is not enough', async () => {
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id);
    const bank = await fx.createRefBank({ active: false });

    const res = await request(app)
      .post(`/api/v1/assets/${asset_id}/bank-assignment`)
      .set('Authorization', `Bearer ${tokenFor('program_manager')}`)
      .send({ bank_id: bank.bank_id, bank_name: bank.name, bank_jurisdiction: 'us' });

    expect(res.status).toBe(400);
  });

  test('omitting bank_id still succeeds -- it is optional, not required', async () => {
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id);

    const res = await request(app)
      .post(`/api/v1/assets/${asset_id}/bank-assignment`)
      .set('Authorization', `Bearer ${tokenFor('program_manager')}`)
      .send({ bank_name: 'Free-Text Only Bank', bank_jurisdiction: 'us' });

    expect(res.status).toBe(201);
    expect(res.body.bank_id).toBeNull();
  });
});
