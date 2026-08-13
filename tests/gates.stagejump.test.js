// Phase 6.1 (SCRUB): isolates the "direct stage jump" assertion from the
// Sentinel-unavailable confound. gates.negative.test.js's own direct-jump
// test found that advancePipeline() returned success: false for a
// straight intake -> tokenization jump, but the block_reason was
// 'blocked_unavailable' (Sentinel unreachable in the test environment)
// -- NOT evidence of sequential-order enforcement. That result would be
// identical for a legitimate, correctly-sequenced advance under the same
// test conditions, so it does not actually test what it claims to.
//
// This file mocks governance.sentinelCheck to always ALLOW, isolating
// the one question that matters: with role authority and the target
// stage's own gate requirements both satisfied, does advancePipeline()
// independently verify that to_stage is the correct next stage after
// from_stage, or does it only check the target stage in isolation?
// Mocking an external service boundary (Sentinel) for a unit test is
// standard practice -- this is not shipped, not user-facing, and not the
// synthetic-data pattern this scrub spent five phases removing elsewhere.
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

test('FINDING: direct stage jump (intake -> tokenization) is NOT rejected when the target gate happens to be satisfiable, even with Sentinel mocked to ALLOW', async () => {
  const client_id = await fx.createClient();
  const { asset_id } = await fx.createAsset(client_id);
  // Only what tokenization's own gate checks for -- none of
  // kyc_verification/appraisal_review/bank_assignment/collateralization/
  // monetization/securitization evidence exists for this asset.
  await fx.addValuation(asset_id, { date_validation_status: 'passed' });

  const result = await advancePipeline({
    asset_id, client_id, to_stage: 'tokenization',
    user: { sub: 'test-fixture', role: 'trade_group_owner' }
  });

  const check = await db.assets.query(`SELECT pipeline_stage FROM pcm_assets WHERE asset_id = $1`, [asset_id]);

  if (result.success === true && check.rows[0].pipeline_stage === 'tokenization') {
    console.warn(
      '[FINDING, Phase 6.1] advancePipeline() has NO sequential-stage-order enforcement. ' +
      'An asset can jump directly from intake to tokenization -- skipping kyc_verification, ' +
      'appraisal_review, bank_assignment, collateralization, monetization, and securitization ' +
      'entirely -- as long as the TARGET stage\'s own gate_requirements entry happens to be ' +
      'satisfiable and role authority + Sentinel both allow it. Documented in SCRUB-PHASE6.txt ' +
      'as a genuine, newly-found gap, not fixed in this pass (a new production behavior change ' +
      'to a live financial pipeline gate, same caution as Phase 3.4\'s KYC gate change, which was ' +
      'held for explicit confirmation before implementing).'
    );
  }

  // Asserts the ACTUAL observed behavior (documents reality), not the
  // spec's assumed behavior -- see the console.warn above and
  // SCRUB-PHASE6.txt for what this means.
  expect(result.success).toBe(true);
  expect(check.rows[0].pipeline_stage).toBe('tokenization');
});
