'use strict';

// Shared by the ingestion script (scripts/ofac-sdn-ingest.js, precomputes
// name_normalized/name_canonical on every SDN entry/alias at ingest time)
// and the screening engine (agents/ofac-screening/index.js, applies the
// same functions to the client's name at screening time). Both sides MUST
// use identical logic or an indexed lookup match becomes meaningless --
// this file is the single source of truth for both.
//
// See docs/SDN-Sanctions-Screening-Design.md piece 3 for the full design
// rationale and the explicit statement that near-exact coverage here is
// NOT exhaustive.

// Tier 1 (exact): NFKD-decompose, strip combining diacritics, case-fold,
// strip punctuation to spaces, collapse whitespace. Deterministic and
// explainable -- no judgment calls in this function.
function normalizeName(name) {
  if (!name) return '';
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')   // strip combining diacritics (e.g. "é" -> "e")
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, ' ')      // punctuation/symbols -> space
    .replace(/\s+/g, ' ')
    .trim();
}

// Tier 2 (near-exact): folds a bounded, explicitly non-exhaustive set of
// known common transliteration variants and honorifics onto the
// normalized form, then sorts tokens so word-order differences (given/
// family order varies by culture; SDN data entry is inconsistent) don't
// prevent a match. This is a real, stated tradeoff: it also means two
// different people whose names are anagram-equivalent token sets
// canonicalize identically. Documented, not hidden -- see design doc.
//
// Extend TRANSLITERATION_MAP as real gaps are found in production. Do not
// present this table as complete; it isn't, and can't be.
const HONORIFICS = new Set([
  'MR', 'MRS', 'MS', 'MISS', 'DR', 'SHEIKH', 'SHEIKHA', 'HAJI', 'HAJJI',
  'SAYYID', 'SAYYIDA', 'IMAM', 'AL', 'EL'
]);

const TRANSLITERATION_MAP = {
  MOHAMMED: 'MUHAMMAD', MOHAMMAD: 'MUHAMMAD', MOHAMED: 'MUHAMMAD',
  MUHAMAD: 'MUHAMMAD', MOHAMAD: 'MUHAMMAD', MUHAMED: 'MUHAMMAD',
  AHMAD: 'AHMED',
  HUSSEIN: 'HUSAYN', HUSAIN: 'HUSAYN', HUSSAIN: 'HUSAYN',
  YOUSEF: 'YUSUF', YOUSUF: 'YUSUF', YUSSEF: 'YUSUF', YOUSSEF: 'YUSUF', YUSEF: 'YUSUF',
  ABRAHIM: 'IBRAHIM', IBRAHEEM: 'IBRAHIM',
  ABDULLA: 'ABDULLAH', ABDALLAH: 'ABDULLAH', ABDULAH: 'ABDULLAH',
  OSAMA: 'USAMA',
  KHALED: 'KHALID',
  OMAR: 'UMAR',
  HASSAN: 'HASAN',
  SALEH: 'SALIH',
  ABDEL: 'ABDUL', ABDUL: 'ABDUL',
  GADAFI: 'QADHAFI', GADDAFI: 'QADHAFI', KADAFI: 'QADHAFI', QADDAFI: 'QADHAFI',
  YELTSIN: 'YELTSIN',
};

function canonicalizeName(normalized) {
  if (!normalized) return '';
  const tokens = normalized
    .split(' ')
    .filter(t => t && !HONORIFICS.has(t))
    .map(t => TRANSLITERATION_MAP[t] || t);
  if (!tokens.length) return '';
  return tokens.sort().join(' ');
}

module.exports = { normalizeName, canonicalizeName };
