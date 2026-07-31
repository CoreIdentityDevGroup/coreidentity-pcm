#!/usr/bin/env node
/**
 * CLOSE-GAP-04: Add human-review confirmation endpoint for instrument integrity
 *
 * This is the ONLY code path permitted to ever set
 * pcm_assets.instrument_integrity_status = 'verified'. The instrument-integrity
 * agent itself can only reach 'blocked' or 'pending_human_verification' — by
 * design, per spec section 3.3 (independent-channel counterparty verification
 * must be human-confirmed, never self-cleared by an agent).
 *
 * Endpoint: POST /api/v1/pipeline/verify-instrument
 * Auth: program_manager or trade_group_owner (matches appraisal_review's own
 * gate_role requirement in STAGES — a reviewer must hold at least the
 * authority the stage itself requires).
 *
 * Required body fields:
 *   - asset_id, client_id
 *   - decision: 'verified' | 'blocked'  (no other values accepted)
 *   - verification_channel_note: non-empty string documenting how the
 *     instrument was independently confirmed (or why it's being blocked)
 *
 * Known limitation, stated plainly: this endpoint cannot programmatically
 * verify that the reviewer actually used an independent channel — it can
 * only require that a note was written and log who wrote it. That is a
 * process control, not a technical one. See spec section 6 for the same
 * class of limitation already documented for ISIN/CUSIP checksum validation.
 *
 * Idempotent: detects existing route before writing; no-ops cleanly.
 * Ends with: npm run build
 *
 * Run: node scripts/close-gap-04-add-instrument-verification-endpoint.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const TARGET = path.join(__dirname, '..', 'api', 'routes', 'pipeline.js');

const ANCHOR = '// ─── HOLD ASSET ───────────────────────────────────────────────────────────────';

const NEW_ROUTE = [
  '// ─── VERIFY INSTRUMENT INTEGRITY (human-review confirmation) ─────────────────',
  "// CLOSE-GAP-04: the ONLY path permitted to set instrument_integrity_status",
  "// to 'verified'. The instrument-integrity agent cannot self-clear this status.",
  "router.post('/verify-instrument', authorize('program_manager','trade_group_owner'), async (req, res, next) => {",
  '  try {',
  '    const { asset_id, client_id, decision, verification_channel_note } = req.body;',
  '',
  '    if (!asset_id || !client_id) {',
  "      return res.status(400).json({ error: 'asset_id and client_id required' });",
  '    }',
  "    if (!['verified', 'blocked'].includes(decision)) {",
  '      return res.status(400).json({ error: "decision must be \'verified\' or \'blocked\'" });',
  '    }',
  '    if (!verification_channel_note || !verification_channel_note.trim()) {',
  '      return res.status(400).json({',
  "        error: 'verification_channel_note required \u2014 document how this was independently confirmed (or why it is being blocked). Contact info from the submitted documents must NOT be used for verification.'",
  '      });',
  '    }',
  '',
  "    const db = require('../services/db');",
  "    const governance = require('../services/governance');",
  '',
  '    const current = await db.assets.query(',
  '      `SELECT instrument_integrity_status FROM pcm_assets WHERE asset_id = $1`,',
  '      [asset_id]',
  '    );',
  '    if (!current.rows.length) {',
  "      return res.status(404).json({ error: 'Asset not found' });",
  '    }',
  "    if (current.rows[0].instrument_integrity_status === 'verified') {",
  "      return res.status(409).json({ error: 'Asset already verified \u2014 no action taken' });",
  '    }',
  '',
  "    const reviewedBy = req.user?.sub || req.user?.email || 'unknown_reviewer';",
  '',
  '    await db.assets.query(',
  '      `UPDATE pcm_assets SET instrument_integrity_status = $1 WHERE asset_id = $2`,',
  '      [decision, asset_id]',
  '    );',
  '',
  '    await db.assets.query(',
  '      `UPDATE pcm_instrument_integrity_results',
  '         SET reviewed_by = $1, reviewed_at = NOW(), verification_channel_note = $2, status = $3',
  '       WHERE id = (',
  '         SELECT id FROM pcm_instrument_integrity_results',
  '         WHERE asset_id = $4 ORDER BY created_at DESC LIMIT 1',
  '       )`,',
  '      [reviewedBy, verification_channel_note, decision, asset_id]',
  '    );',
  '',
  '    await governance.salLog({',
  '      agent_id: reviewedBy,',
  '      action:   `INSTRUMENT_INTEGRITY_REVIEW.${decision.toUpperCase()}`,',
  '      resource: `pcm:asset:${asset_id}`,',
  "      decision: decision === 'verified' ? 'ALLOW' : 'BLOCK',",
  '      context:  { asset_id, client_id, reviewed_by: reviewedBy, verification_channel_note }',
  '    });',
  '',
  '    res.json({',
  '      success: true,',
  '      asset_id,',
  '      instrument_integrity_status: decision,',
  '      reviewed_by: reviewedBy',
  '    });',
  '  } catch (err) { next(err); }',
  '});',
  '',
  ANCHOR
].join('\n');

function main() {
  if (!fs.existsSync(TARGET)) {
    console.error(`\u2717 Target file not found: ${TARGET}`);
    process.exit(1);
  }

  const contents = fs.readFileSync(TARGET, 'utf8');

  if (contents.includes('CLOSE-GAP-04')) {
    console.log('\u2713 CLOSE-GAP-04 already applied \u2014 no-op.');
    return;
  }

  if (!contents.includes(ANCHOR)) {
    console.error('\u2717 Expected anchor comment not found \u2014 file may have changed since this script was written.');
    console.error('  Refusing to apply blind edit. Manual review required.');
    process.exit(1);
  }

  const updated = contents.replace(ANCHOR, NEW_ROUTE);
  fs.writeFileSync(TARGET, updated, 'utf8');
  console.log('\u2713 CLOSE-GAP-04 applied: POST /api/v1/pipeline/verify-instrument added.');
}

main();
