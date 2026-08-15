'use strict';

// SDN sanctions screening design (docs/SDN-Sanctions-Screening-Design.md),
// piece 2 (freshness gate).
//
// Threshold derivation (from the design doc, approved 2026-08-15): OFAC's
// recent-actions feed showed gaps of 1-5 days between publication events
// over a 3-week observation window (2026-07-23 to 2026-08-12), business-
// day pattern, no fixed schedule. WARN at 4 days (past the typical
// mid-week gap, non-blocking); HARD BLOCK at 7 days (~2 days of margin
// over the worst observed gap). Approved as the launch value with the
// explicit caveat that it derives from one observation window and should
// be revisited once real fetch history accumulates -- do not treat these
// numbers as permanent without checking that note first.
//
// Measured off the list's own publish_date, NOT retrieved_at -- those are
// different facts (retrieved_at only proves we succeeded at fetching, not
// that the underlying list is current).

const WARN_DAYS  = 4;
const BLOCK_DAYS = 7;

async function checkFreshness(db) {
  const result = await db.clients.query(
    `SELECT version_id, publish_date, retrieved_at
     FROM pcm_sdn_list_versions
     WHERE fetch_status = 'success'
     ORDER BY publish_date DESC, retrieved_at DESC
     LIMIT 1`
  );

  if (!result.rows.length) {
    return {
      status: 'block',
      reason: 'no_successful_ingestion',
      versionId: null,
      publishDate: null,
      ageDays: null,
    };
  }

  const row = result.rows[0];
  const publishDate = row.publish_date; // date object from pg
  const ageMs = Date.now() - new Date(publishDate).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);

  let status = 'fresh';
  if (ageDays >= BLOCK_DAYS) status = 'block';
  else if (ageDays >= WARN_DAYS) status = 'warn';

  return {
    status,
    reason: status === 'block' ? 'list_stale' : (status === 'warn' ? 'list_aging' : null),
    versionId: row.version_id,
    publishDate: row.publish_date,
    retrievedAt: row.retrieved_at,
    ageDays: Math.round(ageDays * 10) / 10,
    warnThresholdDays: WARN_DAYS,
    blockThresholdDays: BLOCK_DAYS,
  };
}

module.exports = { checkFreshness, WARN_DAYS, BLOCK_DAYS };
