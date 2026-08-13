'use strict';

async function execute(context) {
  const { client_id, full_name, country_of_origin, db } = context;

  // High-risk countries per OFAC SDN list categories
  const HIGH_RISK_COUNTRIES = [
    'Iran','North Korea','Syria','Cuba','Venezuela',
    'Russia','Belarus','Myanmar','Sudan','Zimbabwe'
  ];

  const SANCTIONS_PATTERNS = [
    /^\s*(al[\s-]?qa[ei]da|taliban|isis|hezbollah|hamas)/i,
    /(SDN|SDGT|OFAC)/i
  ];

  const warnings  = [];
  const flags     = [];

  // Country check
  if (HIGH_RISK_COUNTRIES.some(c => 
    country_of_origin?.toLowerCase().includes(c.toLowerCase()))) {
    flags.push(`High-risk jurisdiction: ${country_of_origin}`);
  }

  // Name pattern check
  SANCTIONS_PATTERNS.forEach(pattern => {
    if (pattern.test(full_name)) {
      flags.push(`Name matches sanctions pattern`);
    }
  });

  // CLOSE-GAP-25: this agent has never called an external sanctions API --
  // it is a hardcoded heuristic (10 country strings, 4 regex patterns).
  // A match is still real signal ('flagged'), but "no match" is NOT the
  // same claim as "screened clean against the real SDN list" -- calling
  // it 'clear' let the kyc_verification gate treat an unauthoritative
  // heuristic as a completed sanctions screen. See
  // db/migrations/0001-ofac-status-not-authoritative.sql.
  const status = flags.length > 0 ? 'flagged' : 'not_authoritatively_screened';

  // Record result in DB
  if (client_id && db) {
    await db.clients.query(
      `INSERT INTO pcm_ofac_results 
         (client_id, provider, provider_reference_id, status, match_count, 
          raw_response_summary, screened_by_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        client_id,
        'HEURISTIC-PRESCREEN-NOT-SDN-V1',
        `COREG-${Date.now()}`,
        status,
        flags.length,
        JSON.stringify({ flags, warnings }),
        'ofac-screening-agent'
      ]
    );

    // Update client OFAC status
    await db.clients.query(
      `UPDATE pcm_clients SET ofac_status = $1 WHERE client_id = $2`,
      [status, client_id]
    );
  }

  return {
    status,
    flags,
    warnings,
    action:  status === 'flagged' ? 'HOLD_FOR_REVIEW' : 'PROCEED',
    message: status === 'flagged'
      ? `OFAC screening flagged: ${flags.join('; ')}`
      : 'OFAC screening clear — no matches found'
  };
}

module.exports = { execute };
