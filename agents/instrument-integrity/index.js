'use strict';

/**
 * Instrument & Counterparty Integrity Agent (v1 — financial instruments module)
 *
 * Framework design: this engine (scoring, structural validation, fail-closed
 * logic) is shared across future asset-class typology modules (real estate,
 * precious metals, private equity — see spec section 2). v1 ships with the
 * financial-instruments typology only, because that is the proven live gap.
 *
 * IMPORTANT — what this agent does NOT do:
 * It never sets instrument_integrity_status to 'verified'. Independent-channel
 * counterparty verification (spec section 3.3) requires a human to confirm
 * through a channel NOT supplied in the submitted documents. This agent can
 * only BLOCK (hard fail) or route to PENDING_HUMAN_VERIFICATION. A separate
 * human-review confirmation step (not yet built — see manifest open_items)
 * is required to ever set 'verified'.
 */

const fs   = require('fs');
const path = require('path');

const TYPOLOGY_PATH = path.join(__dirname, 'typologies', 'financial-instruments.json');

function loadTypology() {
  const raw = fs.readFileSync(TYPOLOGY_PATH, 'utf8');
  return JSON.parse(raw);
}

// ── ISIN validation (ISO 6166: 2-letter country + 9 alphanumeric + 1 check digit) ──
function validateISIN(isin) {
  if (!isin || typeof isin !== 'string') return { valid: false, reason: 'missing' };
  const clean = isin.trim().toUpperCase();

  if (!/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(clean)) {
    return { valid: false, reason: 'format_invalid' };
  }

  // Convert letters to numbers (A=10 .. Z=35), then Luhn-style checksum
  let digits = '';
  for (const ch of clean.slice(0, 11)) {
    if (/[A-Z]/.test(ch)) digits += (ch.charCodeAt(0) - 55).toString();
    else digits += ch;
  }

  let sum = 0;
  let double = true; // process from the right
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = parseInt(digits[i], 10);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }

  const checkDigit = (10 - (sum % 10)) % 10;
  const valid = checkDigit === parseInt(clean[11], 10);
  return { valid, reason: valid ? null : 'checksum_failed' };
}

// ── CUSIP validation (ANSI X9.6: 9 characters, modulus 10 checksum) ──
function validateCUSIP(cusip) {
  if (!cusip || typeof cusip !== 'string') return { valid: false, reason: 'missing' };
  const clean = cusip.trim().toUpperCase();

  if (!/^[A-Z0-9]{9}$/.test(clean)) {
    return { valid: false, reason: 'format_invalid' };
  }

  const charVal = (c) => {
    if (/[0-9]/.test(c)) return parseInt(c, 10);
    if (/[A-Z]/.test(c)) return c.charCodeAt(0) - 55;
    if (c === '*') return 36;
    if (c === '@') return 37;
    if (c === '#') return 38;
    return NaN;
  };

  let sum = 0;
  for (let i = 0; i < 8; i++) {
    let v = charVal(clean[i]);
    if (Number.isNaN(v)) return { valid: false, reason: 'invalid_character' };
    if (i % 2 === 1) v *= 2;
    sum += Math.floor(v / 10) + (v % 10);
  }

  const checkDigit = (10 - (sum % 10)) % 10;
  const valid = checkDigit === parseInt(clean[8], 10);
  return { valid, reason: valid ? null : 'checksum_failed' };
}

// ── SWIFT MT message — structural presence check (v1: field-presence only, ──
// ── not full ISO 15022 grammar parsing — flagged as a v1.1 hardening item) ──
const MT_REQUIRED_FIELDS = {
  MT542: ['16R', '20C', '23G', '16S'],
  MT760: ['20', '23', '30', '32B', '50', '59'],
  MT799: ['20', '21', '79']
};

function validateSWIFTStructure(mtType, rawMessage) {
  if (!mtType || !rawMessage) return { valid: false, reason: 'missing', checked: false };
  const required = MT_REQUIRED_FIELDS[mtType.toUpperCase()];
  if (!required) return { valid: null, reason: 'unrecognized_mt_type', checked: false };

  const missing = required.filter(field => !new RegExp(`:${field}:`).test(rawMessage));
  return {
    valid: missing.length === 0,
    reason: missing.length > 0 ? `missing_fields:${missing.join(',')}` : null,
    checked: true
  };
}

// ── Typology scoring ──
function scoreTypology(text, typology) {
  const matches = [];
  let score = 0;
  const content = (text || '').toLowerCase();

  for (const pattern of typology.patterns) {
    const re = new RegExp(pattern.regex, 'i');
    if (re.test(content)) {
      score += pattern.weight;
      matches.push({ id: pattern.id, description: pattern.description, weight: pattern.weight });
    }
  }

  return { score, matches };
}

async function execute(context) {
  const {
    asset_id, client_id, description, instrument_type,
    isin, cusip, swift_mt_type, swift_raw_message, db
  } = context;

  const typology = loadTypology();
  const fullText = `${description || ''} ${instrument_type || ''}`;

  const { score, matches } = scoreTypology(fullText, typology);

  const isinResult  = isin  ? validateISIN(isin)   : null;
  const cusipResult = cusip ? validateCUSIP(cusip) : null;
  const swiftResult = swift_mt_type
    ? validateSWIFTStructure(swift_mt_type, swift_raw_message)
    : null;

  const structural_failures = [];
  if (isinResult  && !isinResult.valid)  structural_failures.push(`ISIN: ${isinResult.reason}`);
  if (cusipResult && !cusipResult.valid) structural_failures.push(`CUSIP: ${cusipResult.reason}`);
  if (swiftResult && swiftResult.checked && !swiftResult.valid) structural_failures.push(`SWIFT ${swift_mt_type}: ${swiftResult.reason}`);

  let status;
  let action;

  if (score >= typology.block_threshold || structural_failures.length > 0) {
    status = 'blocked';
    action = 'HARD_BLOCK';
  } else if (score >= typology.review_threshold) {
    status = 'pending_human_verification';
    action = 'ESCALATE_TO_HUMAN_REVIEW';
  } else {
    // Passing automated checks is NOT the same as verified.
    // Independent-channel counterparty verification is still required.
    status = 'pending_human_verification';
    action = 'ROUTE_TO_INDEPENDENT_VERIFICATION';
  }

  const result = {
    status,
    action,
    instrument_integrity_status: status, // written to pcm_assets by caller
    fraud_risk_score: score,
    typology_version: typology.typology_version,
    matched_patterns: matches,
    structural_validation: {
      isin: isinResult,
      cusip: cusipResult,
      swift: swiftResult,
      failures: structural_failures
    },
    message: status === 'blocked'
      ? `BLOCKED — fraud risk score ${score} (threshold ${typology.block_threshold}) or structural validation failure: ${structural_failures.join('; ') || 'none'}`
      : `Requires independent-channel counterparty verification before this instrument can be marked verified. Contact info supplied in submitted documents must NOT be used for verification.`
  };

  if (asset_id && db) {
    await db.assets.query(
      `UPDATE pcm_assets SET instrument_integrity_status = $1 WHERE asset_id = $2`,
      [status, asset_id]
    );
    await db.assets.query(
      `INSERT INTO pcm_instrument_integrity_results
         (asset_id, client_id, status, fraud_risk_score, typology_version,
          matched_pattern_ids, structural_failures, screened_by_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        asset_id, client_id, status, score, typology.typology_version,
        JSON.stringify(matches.map(m => m.id)),
        JSON.stringify(structural_failures),
        'instrument-integrity-agent'
      ]
    );
  }

  return result;
}

module.exports = { execute, validateISIN, validateCUSIP, validateSWIFTStructure };
