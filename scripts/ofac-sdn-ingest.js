#!/usr/bin/env node
/**
 * SDN sanctions screening design (docs/SDN-Sanctions-Screening-Design.md),
 * piece 1 (ingestion).
 *
 * Fetches OFAC's real SDN list and stores it versioned in
 * pcm_sdn_list_versions / pcm_sdn_entries / pcm_sdn_aliases.
 *
 * Endpoint verified live 2026-08-15 (see design doc): both
 * /api/download/sdn.xml and /api/PublicationPreview/exports/SDN.XML
 * resolve to the same file (identical ETag) on
 * sanctionslistservice.ofac.treas.gov. Basic XML chosen over CSV
 * (unstructured) and Advanced XML (4.4x larger, carries ownership graphs
 * not needed for name/DOB matching) -- confirmed live that basic XML
 * already has structured firstName/lastName, dateOfBirthList, idList, and
 * akaList with OFAC's own strong/weak reliability category.
 *
 * Version identifier is the file's own <Publish_Date> (inside the
 * misspelled-in-OFAC's-own-schema <publshInformation> element -- verified
 * live, not a typo introduced here), not our retrieval timestamp -- see
 * the design doc's freshness-gate section for why those are different
 * facts that both need recording.
 *
 * Every fetch attempt is recorded, success or failure (a failed attempt
 * writes a pcm_sdn_list_versions row with fetch_status='failed' and no
 * publish_date -- see migration 0008), so a silently broken ingestion job
 * is visible to the freshness gate rather than just going quiet.
 *
 * v1 deliberately does NOT do incremental/delta updates (a same-day delta
 * file exists per OFAC's own metadata but is not used here) -- every
 * successful fetch writes a complete new version + full entry/alias set.
 * Simpler and more robust than partial-update logic; reassess if storage
 * growth becomes a real problem.
 *
 * Run: node scripts/ofac-sdn-ingest.js
 * Exit 0 on success, 1 on failure (for CI).
 */

'use strict';

const crypto = require('crypto');
const { XMLParser } = require('fast-xml-parser');
const db = require('../api/services/db');
const { normalizeName, canonicalizeName } = require('../agents/ofac-screening/lib/normalize');
const { WARN_DAYS, BLOCK_DAYS } = require('../agents/ofac-screening/lib/freshness');

const SDN_XML_URL = 'https://sanctionslistservice.ofac.treas.gov/api/download/sdn.xml';
const FETCH_TIMEOUT_MS = 60000;
const INSERT_BATCH_SIZE = 500;
// Standing (non-UAT) BLOCK_DAYS value, for comparison against whatever
// freshness.js's BLOCK_DAYS is currently set to. Duplicated here rather
// than imported because it has to stay fixed at the documented policy
// value even while freshness.js's own BLOCK_DAYS is deliberately raised
// for a UAT window (see CLAIMS-INVENTORY.txt Addendum 36) -- this constant
// is what "back to normal" means, not whatever the override happens to be.
const STANDING_BLOCK_DAYS = 7;

function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

// OFAC's Publish_Date is "MM/DD/YYYY" -- confirmed live (e.g. "08/07/2026").
function parsePublishDate(s) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((s || '').trim());
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  return `${yyyy}-${mm}-${dd}`;
}

async function fetchSdnXml() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(SDN_XML_URL, { signal: controller.signal, redirect: 'follow' });
    if (!resp.ok) {
      throw new Error(`SDN fetch failed: HTTP ${resp.status}`);
    }
    const text = await resp.text();
    const sha256 = crypto.createHash('sha256').update(text).digest('hex');
    return { text, sha256 };
  } finally {
    clearTimeout(timeout);
  }
}

function buildNameFields(firstName, lastName) {
  const full = [firstName, lastName].filter(Boolean).join(' ');
  const normalized = normalizeName(full);
  const canonical = canonicalizeName(normalized);
  return { normalized, canonical };
}

function parseSdn(xmlText) {
  const parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: true,
  });
  const doc = parser.parse(xmlText);
  const root = doc.sdnList;
  if (!root) throw new Error('Unexpected SDN XML shape: no <sdnList> root');

  // NOTE: the element name below is genuinely misspelled in OFAC's own
  // schema ("publshInformation", not "publishInformation") -- confirmed
  // live 2026-08-15, not a typo introduced in this parser.
  const pubInfo = root.publshInformation || {};
  const publishDateRaw = pubInfo.Publish_Date;
  const publishDate = parsePublishDate(publishDateRaw);
  if (!publishDate) {
    throw new Error(`Could not parse Publish_Date: ${JSON.stringify(publishDateRaw)}`);
  }
  const recordCount = pubInfo.Record_Count != null ? parseInt(pubInfo.Record_Count, 10) : null;

  const entries = [];
  const aliasesByEntry = [];

  for (const raw of asArray(root.sdnEntry)) {
    const sdnUid = parseInt(raw.uid, 10);
    if (!Number.isFinite(sdnUid)) continue; // malformed entry, skip rather than fail the whole ingest

    const firstName = raw.firstName || null;
    const lastName = raw.lastName || '';
    const { normalized, canonical } = buildNameFields(firstName, lastName);

    entries.push({
      sdn_uid: sdnUid,
      sdn_type: raw.sdnType || 'Unknown',
      first_name: firstName,
      last_name: lastName,
      program_list: raw.programList ? asArray(raw.programList.program) : [],
      dob_list: raw.dateOfBirthList ? asArray(raw.dateOfBirthList.dateOfBirthItem) : [],
      id_list: raw.idList ? asArray(raw.idList.id) : [],
      address_list: raw.addressList ? asArray(raw.addressList.address) : [],
      name_normalized: normalized,
      name_canonical: canonical,
    });

    const akas = raw.akaList ? asArray(raw.akaList.aka) : [];
    for (const aka of akas) {
      const aFirst = aka.firstName || null;
      const aLast = aka.lastName || '';
      if (!aFirst && !aLast) continue;
      const { normalized: aNorm, canonical: aCanon } = buildNameFields(aFirst, aLast);
      aliasesByEntry.push({
        sdn_uid: sdnUid,
        alias_type: aka.type || null,
        category: aka.category || null,
        first_name: aFirst,
        last_name: aLast,
        name_normalized: aNorm,
        name_canonical: aCanon,
      });
    }
  }

  return { publishDate, recordCount, entries, aliasesByEntry };
}

async function bulkInsert(client, table, columns, rows) {
  for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + INSERT_BATCH_SIZE);
    const values = [];
    const placeholders = batch.map((row, rIdx) => {
      const base = rIdx * columns.length;
      const ph = columns.map((_, cIdx) => `$${base + cIdx + 1}`);
      values.push(...row);
      return `(${ph.join(',')})`;
    });
    await client.query(
      `INSERT INTO ${table} (${columns.join(',')}) VALUES ${placeholders.join(',')}`,
      values
    );
  }
}

let snsClient = null;
function getSnsClient() {
  if (snsClient) return snsClient;
  const { SNSClient } = require('@aws-sdk/client-sns');
  snsClient = new SNSClient({ region: process.env.AWS_REGION || 'us-east-2' });
  return snsClient;
}

// REMAINING-WORK-QUEUE.md Tier 1.1: the freshness gate's BLOCK_DAYS was
// temporarily raised above its standing value (CLAIMS-INVENTORY.txt
// Addendum 36) so UAT could proceed past a stale SDN list. One of the
// three documented revert triggers -- OFAC republishing -- had no way to
// announce itself; this closes that gap. Fires once per ingest that meets
// the condition (not once total), so it re-alerts on every run until
// someone actually reverts BLOCK_DAYS -- deliberate, since a single
// missed/unread notification should not mean the override goes unnoticed
// indefinitely. Best-effort and non-fatal: an alert failure must never
// fail the ingest itself, same reasoning as emitSuccessMetric() in
// api/routes/scheduled.js.
async function alertIfRevertConditionMet(ageDays) {
  if (BLOCK_DAYS <= STANDING_BLOCK_DAYS) return; // no override active, nothing to alert on
  if (ageDays >= WARN_DAYS) return; // list isn't actually fresh yet

  const topicArn = process.env.SNS_ALERTS_TOPIC_ARN;
  if (!topicArn) {
    console.warn(JSON.stringify({
      level: 'warn',
      message: 'OFAC freshness revert condition met but SNS_ALERTS_TOPIC_ARN is not set -- cannot alert',
      ageDays, warnThresholdDays: WARN_DAYS, blockThresholdDaysCurrent: BLOCK_DAYS, blockThresholdDaysStanding: STANDING_BLOCK_DAYS
    }));
    return;
  }

  const message =
    `OFAC SDN freshness gate revert condition met: the newly-ingested list is ` +
    `${ageDays} days old (under the ${WARN_DAYS}-day warn threshold), while ` +
    `BLOCK_DAYS is still overridden at ${BLOCK_DAYS} (standing value ${STANDING_BLOCK_DAYS}). ` +
    `OFAC has republished -- this override no longer needs to be raised. ` +
    `Revert agents/ofac-screening/lib/freshness.js BLOCK_DAYS to ${STANDING_BLOCK_DAYS} ` +
    `and close CLAIMS-INVENTORY.txt Addendum 36 (coreidentity-tools/docs/).`;

  try {
    const { PublishCommand } = require('@aws-sdk/client-sns');
    const client = getSnsClient();
    await client.send(new PublishCommand({
      TopicArn: topicArn,
      Subject: 'CoreIdentity: OFAC freshness override can be reverted',
      Message: message,
    }));
    console.log(JSON.stringify({ level: 'info', message: 'Published OFAC freshness revert alert', ageDays, blockThresholdDaysCurrent: BLOCK_DAYS }));
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', message: 'Failed to publish OFAC freshness revert alert', error: err.message }));
  }
}

async function recordFailedFetch(errorMessage) {
  try {
    await db.clients.query(
      `INSERT INTO pcm_sdn_list_versions
        (fetch_status, fetch_error, source_url)
       VALUES ('failed', $1, $2)`,
      [errorMessage.slice(0, 2000), SDN_XML_URL]
    );
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', message: 'Could not even record failed-fetch row', error: e.message }));
  }
}

// Core ingestion logic, reusable by both the CLI entry point below and
// api/routes/scheduled.js's POST /sdn-ingest (the external-scheduler HTTP
// target -- same authenticateScheduler pattern as the existing /monitoring
// route). Returns a result object on success; throws on failure (callers
// decide how to translate that into a process exit code vs. an HTTP
// response).
async function runIngest() {
  console.log(JSON.stringify({ level: 'info', message: 'SDN ingest starting', url: SDN_XML_URL, at: new Date().toISOString() }));

  let text, sha256;
  try {
    ({ text, sha256 } = await fetchSdnXml());
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', message: 'SDN fetch failed', error: err.message }));
    await recordFailedFetch(`fetch: ${err.message}`);
    throw err;
  }

  let parsed;
  try {
    parsed = parseSdn(text);
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', message: 'SDN parse failed', error: err.message }));
    await recordFailedFetch(`parse: ${err.message}`);
    throw err;
  }

  const { publishDate, recordCount, entries, aliasesByEntry } = parsed;
  console.log(JSON.stringify({
    level: 'info', message: 'SDN parsed', publishDate, recordCount,
    parsedEntries: entries.length, parsedAliases: aliasesByEntry.length, sha256
  }));

  const client = await db.clients.connect();
  try {
    await client.query('BEGIN');

    const versionResult = await client.query(
      `INSERT INTO pcm_sdn_list_versions
        (publish_date, record_count, fetch_status, source_url, file_sha256)
       VALUES ($1, $2, 'success', $3, $4)
       RETURNING version_id`,
      [publishDate, recordCount, SDN_XML_URL, sha256]
    );
    const versionId = versionResult.rows[0].version_id;

    const uidToEntryId = new Map();
    const entryRows = entries.map(e => [
      versionId, e.sdn_uid, e.sdn_type, e.first_name, e.last_name,
      JSON.stringify(e.program_list), JSON.stringify(e.dob_list),
      JSON.stringify(e.id_list), JSON.stringify(e.address_list),
      e.name_normalized, e.name_canonical
    ]);

    // Inserted one batch at a time WITH RETURNING to map sdn_uid -> entry_id
    // for alias FKs -- bulkInsert() doesn't return rows, so entries are
    // inserted directly here instead of via the shared helper.
    for (let i = 0; i < entryRows.length; i += INSERT_BATCH_SIZE) {
      const batch = entryRows.slice(i, i + INSERT_BATCH_SIZE);
      const cols = ['version_id','sdn_uid','sdn_type','first_name','last_name',
                    'program_list','dob_list','id_list','address_list',
                    'name_normalized','name_canonical'];
      const values = [];
      const placeholders = batch.map((row, rIdx) => {
        const base = rIdx * cols.length;
        values.push(...row);
        return `(${cols.map((_, cIdx) => `$${base + cIdx + 1}`).join(',')})`;
      });
      const res = await client.query(
        `INSERT INTO pcm_sdn_entries (${cols.join(',')}) VALUES ${placeholders.join(',')}
         RETURNING entry_id, sdn_uid`,
        values
      );
      for (const row of res.rows) uidToEntryId.set(row.sdn_uid, row.entry_id);
    }

    const aliasRows = aliasesByEntry
      .filter(a => uidToEntryId.has(a.sdn_uid))
      .map(a => [
        uidToEntryId.get(a.sdn_uid), versionId, a.alias_type, a.category,
        a.first_name, a.last_name, a.name_normalized, a.name_canonical
      ]);

    await bulkInsert(
      client, 'pcm_sdn_aliases',
      ['entry_id','version_id','alias_type','category','first_name','last_name','name_normalized','name_canonical'],
      aliasRows
    );

    await client.query('COMMIT');

    const result = {
      version_id: versionId, publish_date: publishDate,
      entries_stored: entryRows.length, aliases_stored: aliasRows.length
    };
    console.log(JSON.stringify({ level: 'info', message: 'SDN ingest complete', ...result }));

    const ageDays = Math.round(((Date.now() - new Date(publishDate).getTime()) / (1000 * 60 * 60 * 24)) * 10) / 10;
    await alertIfRevertConditionMet(ageDays);

    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(JSON.stringify({ level: 'error', message: 'SDN ingest DB write failed', error: err.message }));
    await recordFailedFetch(`db_write: ${err.message}`);
    throw err;
  } finally {
    client.release();
  }
}

async function main() {
  try {
    await runIngest();
    process.exit(0);
  } catch (err) {
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error(JSON.stringify({ level: 'error', message: 'SDN ingest crashed', error: err.stack || err.message }));
    process.exit(1);
  });
}

module.exports = { parseSdn, parsePublishDate, runIngest };
