// Phase 6.1 (SCRUB): fixtures and negative tests against an isolated
// local database (Docker postgres:16, schema dumped from live
// production -- see tests/env.setup.js and ~/SCRUB-PHASE6.txt for setup
// detail; zero production data ever read or written by this suite).
//
// Per instruction, asserts on agent output / gate state (DB rows,
// advancePipeline()'s return value), not activity-row presence:
//   - agent errors / missing evidence -> blocks
//   - direct stage jump -> rejected
//   - Sentinel unavailable -> blocks with block_reason 'blocked_unavailable'
'use strict';

const { advancePipeline, validateGate } = require('../api/services/pipeline');
const db = require('../api/services/db');
const fx = require('./fixtures');

const SYSTEM_USER = { sub: 'test-fixture', role: 'trade_group_owner' };

afterAll(async () => {
  await Promise.all([
    db.clients.end(), db.assets.end(), db.forms.end(), db.pehf.end()
  ]);
});

describe('kyc_verification gate', () => {
  test('missing evidence (no KYC docs, no POF, OFAC pending) -> blocks', async () => {
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id);

    const errors = await validateGate('kyc_verification', asset_id, client_id);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining('No KYC documents on file'),
      expect.stringContaining('No Proof of Funds on file'),
    ]));

    const result = await advancePipeline({ asset_id, client_id, to_stage: 'kyc_verification', user: SYSTEM_USER });
    expect(result.success).toBe(false);
    expect(result.block_reason).toBe('blocked_pending');
  });

  test('partial evidence (docs present, OFAC never screened) -> still blocks', async () => {
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id);
    await fx.addKycDocument(client_id);
    await fx.addPofRecord(client_id);
    // ofac_status defaults to 'pending' -- never screened

    const errors = await validateGate('kyc_verification', asset_id, client_id);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/OFAC screening not satisfied/);
  });

  test('legacy/unrecognized ofac_status (e.g. stale "clear") -> blocks, not silently accepted', async () => {
    // Regression guard for the exact defect CLOSE-GAP-27 fixed: the old
    // blocklist gate let ANY status other than pending/flagged pass,
    // including a legacy 'clear' row. The allowlist rewrite must block
    // everything except the two explicitly-confirmed dual-control states.
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id);
    await fx.addKycDocument(client_id);
    await fx.addPofRecord(client_id);
    await db.clients.query(`UPDATE pcm_clients SET ofac_status = 'clear' WHERE client_id = $1`, [client_id]);

    const errors = await validateGate('kyc_verification', asset_id, client_id);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/OFAC screening not satisfied/);
  });

  test('full evidence + confirmed out-of-band attestation -> passes gate check', async () => {
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id);
    await fx.addKycDocument(client_id);
    await fx.addPofRecord(client_id);
    await fx.confirmOfacAttestation(client_id);

    const errors = await validateGate('kyc_verification', asset_id, client_id);
    expect(errors).toEqual([]);
  });
});

describe('appraisal_review gate', () => {
  test('agent output missing (no valuation submitted) -> blocks', async () => {
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id);

    const errors = await validateGate('appraisal_review', asset_id, client_id);
    expect(errors).toEqual(expect.arrayContaining([expect.stringContaining('No valuation or appraisal submitted')]));
  });

  test('agent-detected failure (date_validation_status = failed) -> blocks', async () => {
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id);
    await fx.addValuation(asset_id, { date_validation_status: 'failed' });
    await fx.addAssetDocument(asset_id);

    const errors = await validateGate('appraisal_review', asset_id, client_id);
    expect(errors).toEqual(expect.arrayContaining([expect.stringContaining('Same-date validation failed')]));
  });

  test('instrument-integrity never cleared (still pending) -> blocks', async () => {
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id);
    await fx.addValuation(asset_id);
    await fx.addAssetDocument(asset_id);
    // instrument_integrity_status defaults to 'pending' -- fixture does NOT clear it

    const errors = await validateGate('appraisal_review', asset_id, client_id);
    expect(errors).toEqual(expect.arrayContaining([expect.stringContaining('Instrument integrity screening not yet cleared')]));
  });

  test('real instrument-integrity agent detects a structural failure -> writes blocked -> gate rejects', async () => {
    // Runs the actual agent module (pure JS, no external AI call --
    // ISIN/CUSIP checksum + SWIFT structural validation, see
    // agents/instrument-integrity/typologies/financial-instruments.json)
    // against the real fixture DB, not a simulated DB write. This is the
    // "agent errors -> blocks" case using real agent code, distinct from
    // the "missing evidence" cases above which never invoke an agent at
    // all.
    const { execute: instrumentIntegrityExecute } = require('../agents/instrument-integrity');
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id);
    await fx.addValuation(asset_id);
    await fx.addAssetDocument(asset_id);

    const agentResult = await instrumentIntegrityExecute({
      asset_id, client_id,
      description: 'Corporate bond instrument',
      instrument_type: 'bond',
      isin: 'NOT-A-VALID-ISIN', // malformed -- fails ISO 6166 format check
      db
    });

    expect(agentResult.status).toBe('blocked');
    expect(agentResult.structural_validation.failures.length).toBeGreaterThan(0);

    const errors = await validateGate('appraisal_review', asset_id, client_id);
    expect(errors).toEqual(expect.arrayContaining([expect.stringContaining('Instrument integrity screening BLOCKED')]));
  });

  test('full real evidence -> passes gate check', async () => {
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id);
    await fx.addValuation(asset_id);
    await fx.addAssetDocument(asset_id);
    await fx.setInstrumentIntegrityVerified(asset_id);

    const errors = await validateGate('appraisal_review', asset_id, client_id);
    expect(errors).toEqual([]);
  });
});

describe('bank_assignment / collateralization gates', () => {
  test('bank_assignment: no valuation on file -> blocks', async () => {
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id);
    const errors = await validateGate('bank_assignment', asset_id, client_id);
    expect(errors).toEqual(expect.arrayContaining([expect.stringContaining('No valuation on file')]));
  });

  test('collateralization: no bank assigned, no agreements -> blocks with all three reasons', async () => {
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id);
    const errors = await validateGate('collateralization', asset_id, client_id);
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining('No trader bank assigned'),
      expect.stringContaining('Master Fee Agreement not fully executed'),
      expect.stringContaining('IMFPA not fully executed'),
    ]));
  });

  test('collateralization: full evidence -> passes gate check', async () => {
    const client_id = await fx.createClient();
    const { asset_id, pipeline_reference } = await fx.createAsset(client_id);
    await fx.setBankAssignment(asset_id);
    await fx.addExecutedAgreement(asset_id, client_id, pipeline_reference, 'master_fee_agreement');
    await fx.addExecutedAgreement(asset_id, client_id, pipeline_reference, 'irrevocable_master_fee_protection_agreement');

    const errors = await validateGate('collateralization', asset_id, client_id);
    expect(errors).toEqual([]);
  });
});

describe('tokenization / completed gates (system-gated)', () => {
  test('tokenization: no passed valuation -> blocks', async () => {
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id);
    const errors = await validateGate('tokenization', asset_id, client_id);
    expect(errors.length).toBeGreaterThan(0);
  });

  test('completed: no classification token minted -> blocks', async () => {
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id);
    const errors = await validateGate('completed', asset_id, client_id);
    expect(errors).toEqual(expect.arrayContaining([expect.stringContaining('No classification token minted')]));
  });

  test('completed: token minted -> passes gate check', async () => {
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id);
    await fx.mintClassificationToken(asset_id, client_id);
    const errors = await validateGate('completed', asset_id, client_id);
    expect(errors).toEqual([]);
  });
});

describe('unknown/no-gate-definition stage -> absence is never a pass (CLOSE-GAP-12-C1)', () => {
  test('validateGate throws for a stage with no GATE_REQUIREMENTS entry', async () => {
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id);
    await expect(validateGate('not_a_real_stage', asset_id, client_id)).rejects.toThrow();
  });
});

describe('direct stage jump', () => {
  test('jumping straight from intake to tokenization -> blocked_invalid_transition, before Sentinel is ever consulted (CLOSE-GAP-30)', async () => {
    // Deliberately gives the asset ONLY what tokenization's own gate
    // checks for (a passed valuation) -- none of kyc_verification,
    // appraisal_review, bank_assignment, collateralization, or
    // monetization/securitization evidence exists.
    //
    // This originally documented an open finding (no sequential-order
    // enforcement existed at all -- see git history / SCRUB-PHASE6.txt).
    // Now that CLOSE-GAP-30 fixed it, this asserts the real outcome. Note
    // this test does NOT need Sentinel mocked to ALLOW (unlike
    // gates.stagejump.test.js's more surgical version of this same
    // assertion) -- the transition-validity check runs before the
    // Sentinel call, so it's unreachable regardless of Sentinel's
    // availability, and block_reason distinguishes the two cleanly.
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id);
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
});

describe('Sentinel unavailable', () => {
  test('advancing a stage whose role + gate checks pass, with no reachable Sentinel, blocks with blocked_unavailable', async () => {
    // SENTINEL_JWT_SECRET is unset in tests/env.setup.js -- this is the
    // real code path a Sentinel outage hits (mintSentinelToken() throws,
    // sentinelCheck() catches it), not a mock.
    const client_id = await fx.createClient();
    const { asset_id } = await fx.createAsset(client_id);
    await fx.mintClassificationToken(asset_id, client_id);
    // CLOSE-GAP-30: advancePipeline() now checks transition validity
    // before Sentinel, so the asset must actually BE at tokenization
    // (completed's real predecessor) for a completed-bound advance to
    // reach the Sentinel check at all -- a raw UPDATE here, not
    // advancePipeline() itself, since walking through every intermediate
    // stage via advancePipeline() would each independently hit the same
    // real Sentinel-unavailable path this test is isolating.
    await db.assets.query(`UPDATE pcm_assets SET pipeline_stage = 'tokenization' WHERE asset_id = $1`, [asset_id]);
    // 'completed' gate passes (token minted); gate_role is 'system', so
    // role authority auto-passes too via the systemCheck path. Only the
    // Sentinel check remains before mutation.

    const result = await advancePipeline({ asset_id, client_id, to_stage: 'completed', user: SYSTEM_USER });

    expect(result.success).toBe(false);
    expect(result.block_reason).toBe('blocked_unavailable');
    expect(result.code).toBe(503);

    // Confirm the block is real, not cosmetic: the stage must NOT have advanced.
    const check = await db.assets.query(`SELECT pipeline_stage FROM pcm_assets WHERE asset_id = $1`, [asset_id]);
    expect(check.rows[0].pipeline_stage).not.toBe('completed');
  });
});
