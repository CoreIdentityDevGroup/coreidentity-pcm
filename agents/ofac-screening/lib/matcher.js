'use strict';

// SDN sanctions screening design (docs/SDN-Sanctions-Screening-Design.md),
// piece 3 (matching). Exact + near-exact tiers only -- fuzzy (tier 3) is
// explicitly deferred to its own dated fast-follow, see design doc.
//
// Both tiers are indexed lookups against precomputed name_normalized/
// name_canonical columns (agents/ofac-screening/lib/normalize.js, applied
// identically at ingest time and here) -- neither tier introduces a
// similarity score. An exact/near-exact HIT is a hard flag, not something
// that auto-clears; only a no-match at both tiers auto-clears. See design
// doc piece 4 for why (an exact name match to SDN is about the least
// ambiguous signal this system can produce).

const { normalizeName, canonicalizeName } = require('./normalize');

// Builds the name string to screen. Prefers structured given_name/
// family_name (added this pass specifically so DOB/structured-name
// intake isn't a dead end) -- falls back to full_name for any client
// created before this pass (the one pre-existing test client had
// given_name/family_name backfilled by migration 0004, but this fallback
// keeps the matcher correct even if that weren't true).
function resolveInputName({ given_name, family_name, full_name }) {
  if (given_name || family_name) {
    return [given_name, family_name].filter(Boolean).join(' ');
  }
  return full_name || '';
}

async function findMatch(db, versionId, normalized, canonical) {
  // Tier 1: exact, against primary names and aliases.
  const exactEntry = await db.clients.query(
    `SELECT entry_id, sdn_uid, sdn_type, first_name, last_name, program_list, name_normalized
     FROM pcm_sdn_entries
     WHERE version_id = $1 AND name_normalized = $2
     LIMIT 1`,
    [versionId, normalized]
  );
  if (exactEntry.rows.length) {
    const e = exactEntry.rows[0];
    return {
      tier: 'exact', matched: true,
      sdn_uid: e.sdn_uid, sdn_type: e.sdn_type,
      matched_name: [e.first_name, e.last_name].filter(Boolean).join(' '),
      matched_via: 'primary_name', alias_category: null,
      program_list: e.program_list,
    };
  }

  const exactAlias = await db.clients.query(
    `SELECT a.entry_id, e.sdn_uid, e.sdn_type, a.first_name, a.last_name, a.category, e.program_list
     FROM pcm_sdn_aliases a
     JOIN pcm_sdn_entries e ON e.entry_id = a.entry_id
     WHERE a.version_id = $1 AND a.name_normalized = $2
     LIMIT 1`,
    [versionId, normalized]
  );
  if (exactAlias.rows.length) {
    const a = exactAlias.rows[0];
    return {
      tier: 'exact', matched: true,
      sdn_uid: a.sdn_uid, sdn_type: a.sdn_type,
      matched_name: [a.first_name, a.last_name].filter(Boolean).join(' '),
      matched_via: 'alias', alias_category: a.category,
      program_list: a.program_list,
    };
  }

  // Tier 2: near-exact (normalization + transliteration-equivalence
  // canonical form), against primary names and aliases.
  const nearEntry = await db.clients.query(
    `SELECT entry_id, sdn_uid, sdn_type, first_name, last_name, program_list
     FROM pcm_sdn_entries
     WHERE version_id = $1 AND name_canonical = $2
     LIMIT 1`,
    [versionId, canonical]
  );
  if (nearEntry.rows.length) {
    const e = nearEntry.rows[0];
    return {
      tier: 'near_exact', matched: true,
      sdn_uid: e.sdn_uid, sdn_type: e.sdn_type,
      matched_name: [e.first_name, e.last_name].filter(Boolean).join(' '),
      matched_via: 'primary_name', alias_category: null,
      program_list: e.program_list,
    };
  }

  const nearAlias = await db.clients.query(
    `SELECT a.entry_id, e.sdn_uid, e.sdn_type, a.first_name, a.last_name, a.category, e.program_list
     FROM pcm_sdn_aliases a
     JOIN pcm_sdn_entries e ON e.entry_id = a.entry_id
     WHERE a.version_id = $1 AND a.name_canonical = $2
     LIMIT 1`,
    [versionId, canonical]
  );
  if (nearAlias.rows.length) {
    const a = nearAlias.rows[0];
    return {
      tier: 'near_exact', matched: true,
      sdn_uid: a.sdn_uid, sdn_type: a.sdn_type,
      matched_name: [a.first_name, a.last_name].filter(Boolean).join(' '),
      matched_via: 'alias', alias_category: a.category,
      program_list: a.program_list,
    };
  }

  return { tier: null, matched: false };
}

// screenClient(db, versionId, client) -> {
//   matched, tier, compared: {...}, ...match details if matched
// }
// `client` is { full_name, given_name, family_name, date_of_birth,
// country_of_origin } -- date_of_birth and country_of_origin are recorded
// in `compared` as evidence context but are NOT used as a filter by
// either tier in this pass (see design doc: neither tier needs DOB to
// determine a string match; DOB is captured now so a future tier/human
// reviewer has it, not wired into matching logic yet).
async function screenClient(db, versionId, client) {
  const inputName = resolveInputName(client);
  const normalized = normalizeName(inputName);
  const canonical = canonicalizeName(normalized);

  const compared = {
    input_name: inputName,
    input_normalized: normalized,
    input_canonical: canonical,
    date_of_birth: client.date_of_birth || null,
    country_of_origin: client.country_of_origin || null,
  };

  if (!normalized) {
    return { matched: false, tier: null, compared, note: 'empty_input_name' };
  }

  const match = await findMatch(db, versionId, normalized, canonical);
  return { ...match, compared };
}

module.exports = { screenClient, resolveInputName };
