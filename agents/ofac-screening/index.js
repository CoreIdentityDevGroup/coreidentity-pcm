'use strict';

// SDN sanctions screening design (docs/SDN-Sanctions-Screening-Design.md).
// Replaces the CLOSE-GAP-25 heuristic (10 hardcoded country strings, 4
// regex patterns) with real screening against OFAC's actual SDN list,
// ingested by scripts/ofac-sdn-ingest.js. Exact + near-exact tiers only in
// this pass -- fuzzy (tier 3) is an explicit, separately-dated fast-follow
// (see design doc piece 3); it is not silently absent, it is scoped out.
//
// A freshness check runs before any matching: screening against a stale
// list blocks (not_authoritatively_screened) rather than clears -- see
// lib/freshness.js for the threshold and its evidence.
//
// A match at either tier is a hard flag ('flagged'), same as the old
// heuristic and the same existing dual-control override path
// (POST /:id/ofac/override, CLOSE-GAP-19a) resolves it. Only a genuine
// no-match at both tiers, against a fresh list, produces 'clear' -- and
// unlike the old heuristic, this 'clear' is real: see the kyc_verification
// gate update that re-verifies this before trusting it.

const { checkFreshness } = require('./lib/freshness');
const { screenClient } = require('./lib/matcher');

const PROVIDER = 'SDN-ENGINE-EXACT-NEAR-EXACT-V1';

async function recordResult(db, { client_id, status, match_count, raw_response_summary, list_version_id, match_method, compared_fields }) {
  if (!client_id || !db) return;
  await db.clients.query(
    `INSERT INTO pcm_ofac_results
       (client_id, provider, provider_reference_id, status, match_count,
        raw_response_summary, screened_by_agent, list_version_id,
        match_method, compared_fields)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      client_id, PROVIDER, `SDN-${Date.now()}`, status, match_count,
      raw_response_summary, 'ofac-screening-agent',
      list_version_id, match_method, JSON.stringify(compared_fields)
    ]
  );
  await db.clients.query(
    `UPDATE pcm_clients SET ofac_status = $1 WHERE client_id = $2`,
    [status, client_id]
  );
}

async function execute(context) {
  const { client_id, full_name, given_name, family_name, date_of_birth,
          country_of_origin, db } = context;

  const freshness = await checkFreshness(db);

  if (freshness.status === 'block') {
    const status = 'not_authoritatively_screened';
    const message = `OFAC screening blocked: SDN list is ${freshness.ageDays == null ? 'unavailable' : freshness.ageDays + ' days old'} ` +
      `(threshold ${freshness.blockThresholdDays}d) -- not authoritative. reason=${freshness.reason}`;

    await recordResult(db, {
      client_id, status, match_count: 0,
      raw_response_summary: message,
      list_version_id: freshness.versionId, match_method: null,
      compared_fields: { freshness },
    });

    return {
      status, flags: [], warnings: [message],
      action: 'HOLD_FOR_REVIEW',
      message
    };
  }

  const warnings = [];
  if (freshness.status === 'warn') {
    warnings.push(`SDN list aging: ${freshness.ageDays} days old (warn threshold ${freshness.warnThresholdDays}d, not blocking)`);
  }

  const match = await screenClient(db, freshness.versionId, {
    full_name, given_name, family_name, date_of_birth, country_of_origin
  });

  const flags = [];
  if (match.matched) {
    flags.push(
      `SDN match: "${match.matched_name}" (sdn_uid=${match.sdn_uid}, type=${match.sdn_type}, ` +
      `tier=${match.tier}, via=${match.matched_via}` +
      `${match.alias_category ? ', alias_category=' + match.alias_category : ''}, ` +
      `programs=${(match.program_list || []).join('|')})`
    );
  }

  const status = match.matched ? 'flagged' : 'clear';
  const compared_fields = {
    ...match.compared,
    freshness: { status: freshness.status, ageDays: freshness.ageDays, publishDate: freshness.publishDate },
  };

  await recordResult(db, {
    client_id, status, match_count: match.matched ? 1 : 0,
    raw_response_summary: JSON.stringify({ flags, warnings }),
    list_version_id: freshness.versionId, match_method: match.tier,
    compared_fields,
  });

  return {
    status, flags, warnings,
    action: status === 'flagged' ? 'HOLD_FOR_REVIEW' : 'PROCEED',
    message: status === 'flagged'
      ? `OFAC screening flagged: ${flags.join('; ')}`
      : `OFAC screening clear -- no match at exact or near-exact tier (SDN list published ${freshness.publishDate})`
  };
}

module.exports = { execute };
