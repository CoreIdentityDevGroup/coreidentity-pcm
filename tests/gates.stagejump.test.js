// Phase 6.1/CLOSE-GAP-30 (SCRUB): isolates stage-order-transition
// assertions from the Sentinel-unavailable confound by mocking
// governance.sentinelCheck to always ALLOW -- the one question these
// tests isolate is whether advancePipeline() independently verifies
// to_stage is a valid transition from from_stage, given role authority
// and the target stage's own gate requirements are both already
// satisfied. Mocking an external service boundary (Sentinel) for a unit
// test is standard practice -- not shipped, not user-facing, and not the
// synthetic-data pattern this scrub spent five phases removing
// elsewhere.
//
// Originally documented the OPPOSITE of what it now asserts: before
// CLOSE-GAP-30, this exact test proved advancePipeline() had no
// sequential-order enforcement at all (a direct intake -> tokenization
// jump succeeded). See SCRUB-PHASE6.txt for the full finding record.
// Updated to assert the corrected behavior once the fix landed -- a test
// that keeps asserting a known bug after the bug is fixed is worse than
// no test.
'use strict';

jest.mock('../api/services/governance', () => ({
  ...jest.requireActual('../api/services/governance'),
  sentinelCheck: jest.fn().mockResolvedValue({ allowed: true, decision: 'ALLOW', reason: null })
}));

const { advancePipeline } = require('../api/services/pipeline');
const db = require('../api/services/db');
const fx = require('./fixtures');

afterAll(async () => {
  await Promise.all([db.clients.end(), db.assets.end(), db.forms.end(), db.pehf.end()]);
});

test('direct stage jump (intake -> tokenization) is now rejected, even when the target gate is satisfiable and Sentinel allows', async () => {
  const client_id = await fx.createClient();
  const { asset_id } = await fx.createAsset(client_id);
  // Only what tokenization's own gate checks for -- none of
  // kyc_verification/appraisal_review/bank_assignment/collateralization/
  // monetization/securitization evidence exists. Before CLOSE-GAP-30,
  // this alone was enough to advance directly to tokenization.
  await fx.addValuation(asset_id, { date_validation_status: 'passed' });

  const result = await advancePipeline({
    asset_id, client_id, to_stage: 'tokenization',
    user: { sub: 'test-fixture', role: 'trade_group_owner' }
  });

  expect(result.success).toBe(false);
  expect(result.block_reason).toBe('blocked_invalid_transition');

  const check = await db.assets.query(`SELECT pipeline_stage FROM pcm_assets WHERE asset_id = $1`, [asset_id]);
  expect(check.rows[0].pipeline_stage).toBe('intake');
});

test('correctly sequenced single-step advance still succeeds (regression guard: the fix must not block legitimate progression)', async () => {
  const client_id = await fx.createClient();
  const { asset_id } = await fx.createAsset(client_id);
  await fx.addKycDocument(client_id);
  await fx.addPofRecord(client_id);
  await fx.confirmOfacAttestation(client_id);

  const result = await advancePipeline({
    asset_id, client_id, to_stage: 'kyc_verification',
    user: { sub: 'test-fixture', role: 'trade_group_owner' }
  });

  expect(result.success).toBe(true);
  const check = await db.assets.query(`SELECT pipeline_stage FROM pcm_assets WHERE asset_id = $1`, [asset_id]);
  expect(check.rows[0].pipeline_stage).toBe('kyc_verification');
});

test('rejected is reachable from any non-terminal stage, at any time (existing behavior preserved)', async () => {
  const client_id = await fx.createClient();
  const { asset_id } = await fx.createAsset(client_id);
  // Still at 'intake' -- reject must work regardless of how far the
  // asset has progressed.
  const result = await advancePipeline({
    asset_id, client_id, to_stage: 'rejected',
    user: { sub: 'test-fixture', role: 'trade_group_owner' }, notes: 'test rejection'
  });
  expect(result.success).toBe(true);
});

test('on_hold can only resume to the exact stage it was held from, reconstructed from pcm_pipeline_history', async () => {
  const client_id = await fx.createClient();
  const { asset_id } = await fx.createAsset(client_id);
  await fx.addKycDocument(client_id);
  await fx.addPofRecord(client_id);
  await fx.confirmOfacAttestation(client_id);

  // Advance to kyc_verification for real, then hold.
  const toKyc = await advancePipeline({ asset_id, client_id, to_stage: 'kyc_verification', user: { sub: 'test-fixture', role: 'trade_group_owner' } });
  expect(toKyc.success).toBe(true);
  const toHold = await advancePipeline({ asset_id, client_id, to_stage: 'on_hold', user: { sub: 'test-fixture', role: 'program_manager' } });
  expect(toHold.success).toBe(true);

  // Resuming to the WRONG stage must be rejected.
  const wrongResume = await advancePipeline({ asset_id, client_id, to_stage: 'appraisal_review', user: { sub: 'test-fixture', role: 'trade_group_owner' } });
  expect(wrongResume.success).toBe(false);
  expect(wrongResume.block_reason).toBe('blocked_invalid_transition');

  // Resuming to the CORRECT (pre-hold) stage must succeed.
  const correctResume = await advancePipeline({ asset_id, client_id, to_stage: 'kyc_verification', user: { sub: 'test-fixture', role: 'trade_group_owner' } });
  expect(correctResume.success).toBe(true);
  const check = await db.assets.query(`SELECT pipeline_stage FROM pcm_assets WHERE asset_id = $1`, [asset_id]);
  expect(check.rows[0].pipeline_stage).toBe('kyc_verification');
});
