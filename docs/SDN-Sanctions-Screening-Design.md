# SDN Sanctions Screening — Design

**Status:** Approved 2026-08-15. This document is the spec — no separate spec was written before implementation; the design report below (delivered in chat, reproduced here verbatim for the record) was reviewed and approved as-is.

**Relationship to prior work:** `docs/Instrument-Counterparty-Integrity-Agent-Spec.md` §6.3 flagged full OFAC SDN list integration as a "fast-follow spec, not bundled" into the original `ofac-screening` agent hardening. This document is that fast-follow.

**Scope of this pass:** ingestion, freshness gate, exact + near-exact matching tiers, evidence, and the intake schema changes (structured given/family name, DOB, ID documents) needed to support matching. **Fuzzy matching (tier 3) is explicitly deferred** to its own dated fast-follow with a labeled validation set — see "Effort estimate" below. Building an untuned fuzzy threshold under deadline pressure was assessed as worse than shipping without it.

---

## Premise check

Original ask assumed "~12,000 entries." Verified against the live file instead of trusting that figure: current SDN.XML (published 2026-08-07, per the file's own `<Publish_Date>`/`<Record_Count>` header) has **19,199 records** — Individuals, Entities, Vessels, and Aircraft together, aliases nested inside each record rather than counted separately. Design is sized against 19,199.

---

## 1. Ingestion

**Verified live, not assumed from training data:**

| File | URL | Size (at verification) | Format |
|---|---|---|---|
| SDN.XML | `https://sanctionslistservice.ofac.treas.gov/api/download/sdn.xml` | 28.8 MB | Individuals/Entities/Vessels/Aircraft, aka list, DOB, ID docs, addresses |
| SDN.CSV | `https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV` | 5.6 MB | Flattened, one row per name — loses structure |
| SDN_ADVANCED.XML | `.../api/download/sdn_advanced.xml` | 125.9 MB | Fully relational (DistinctParties/Features/Relationships) |

Both URL styles tested (`/api/download/...` and `/api/PublicationPreview/exports/...`) resolve to the **same backing file** on S3 (`wc2h-sls-prod-public-published`), confirmed by identical ETag. The legacy `www.treasury.gov/ofac/downloads/sdn.xml` still 302s to the same current file. No auth, no rate limit encountered.

**Decision: ingest `sdn.xml` (basic), not CSV or Advanced.** Confirmed directly (fetched a real Individual record, UID 2674 "Abu ABBAS") that basic XML already carries structured `firstName`/`lastName`, `dateOfBirthList`/`dateOfBirth` (e.g. `10 Dec 1948`), `idList` (passport/national-ID numbers), and `akaList` with a `category: strong|weak` field OFAC itself assigns per alias — a real, usable reliability signal from the source. CSV flattens all of this into unstructured text; Advanced XML carries ownership/relationship graphs not needed for name/DOB matching, at 4.4x the size.

**Version identifier — use the file's own, don't invent one:**
- In-body: `<publshInformation><Publish_Date>08/07/2026</Publish_Date><Record_Count>19199</Record_Count></publshInformation>` (the `publshInformation` typo is genuinely in OFAC's schema)
- HTTP/S3 metadata: `x-amz-meta-publication-id: 941`, `Last-Modified`, `x-amz-meta-delta-name` (a same-day delta file also exists — useful for a future incremental-fetch optimization, not used in v1's full-replace approach)

**Fetch schedule:** daily. No rate limit forces a lighter touch, and there's no benefit to polling faster than we can act on.

---

## 2. Freshness Gate

**Real evidence, not a guess:** pulled OFAC's `recent-actions` listing and computed actual gaps between publication events over ~3 weeks (2026-07-23 → 2026-08-12):

```
07-23 → 07-24 : 1 day      07-30 → 08-03 : 4 days (weekend)
07-24 → 07-27 : 3 days     08-03 → 08-05 : 2 days
07-27 → 07-29 : 2 days     08-05 → 08-06 : 1 day
07-29 → 07-30 : 1 day      08-06 → 08-07 : 1 day
                            08-07 → 08-12 : 5 days
```
Max observed gap: **5 days**, business-day pattern (gaps widen across weekends), no fixed schedule.

**Second finding:** the SDN.XML served at verification time (2026-08-15) still carried `Publish_Date = 08/07/2026` — 8 days old — even though `recent-actions` showed an event on 08-12. The gap between "OFAC announced something" and "the bulk downloadable file reflects it" is real and outside our control.

**Threshold: WARN at 4 days, HARD BLOCK at 7 days**, measured off the list's own `Publish_Date`, not our retrieval timestamp (those are different failure modes — retrieval timestamp only proves we succeeded at fetching, not that the underlying list is current).
- 4-day WARN: past the typical mid-week gap, non-blocking, dashboard-visible.
- 7-day BLOCK: ~2 days of margin over the worst observed gap, so ordinary cadence variance doesn't halt onboarding, while still catching a genuinely stalled ingestion pipeline within one business week.

**Approved as the launch value 2026-08-15**, with the stated caveat that it derives from one 3-week observation window and should be revisited once real fetch history accumulates. Known cost: a 7-day hard block means the entire onboarding pipeline halts if OFAC goes quiet for an extended stretch (has happened around holidays), independent of whether anything is actually wrong with our pipeline — a deliberate fail-closed tradeoff consistent with this system's existing philosophy (Sentinel fail-closed, dual-control everywhere), accepted knowingly rather than discovered later.

---

## 3. Matching — tiered, and reported honestly

**Structural constraint that shapes everything else:** live intake (pre-this-pass) captured exactly `full_name` (single free-text string), `email`, `country_of_origin` — no DOB, no structured given/family name, no ID numbers. SDN data has all of that, structured. This pass adds the corresponding intake fields (see "Intake changes" below) specifically because this asymmetry is the biggest weak point in the whole design.

**Tier 1 — Exact.** Normalize both sides (NFKD, case-fold, whitespace-collapse, strip punctuation) and compare against every SDN primary name and every alias. Deterministic, explainable, indexed lookup. Catches almost nothing alone — real names essentially never arrive byte-identical to a government record — but it's free and zero-risk, so it runs first.

**Tier 2 — Near-exact.** Same normalization plus a bounded, explicitly non-exhaustive set of known transliteration-equivalence rules (common Arabic/Persian/Cyrillic romanization variants, honorific/title stripping, given/family word-order permutation). Precomputed at ingest time into a `name_canonical` column on SDN entries/aliases, so this tier is still a deterministic indexed lookup, not a similarity score — no ambiguity is introduced at this tier by design.

**Tier 3 — Fuzzy, deferred.** Composite scoring (Jaro-Winkler + token-set comparison + Double Metaphone, combined by max not average) is designed but not built this pass. Threshold requires a labeled validation set (known-true-positive transliteration pairs, known-false-positive common-name near-misses) from this platform's own population — that set doesn't exist yet and building it under time pressure would produce an unjustified number, which is worse than no fuzzy tier at all.

### Where this design is weak — stated plainly, not solved

- **Common-name collision volume.** ~19K SDN entries include globally common names. Fuzzy tier (when built) will need DOB/ID-number disambiguation to avoid alert-fatigue-driven rubber-stamping — this pass adds the intake fields but does not yet wire DOB into any matching logic beyond recording it as evidence.
- **DOB is available from OFAC** (confirmed structured in basic XML) **but was a dead end on our side until this pass** — now captured at intake, but only exact/near-exact tiers ship this pass, and neither currently uses DOB as a filter (name-string tiers don't need it to determine a string match; it's recorded for future use and human review context).
- **Transliteration coverage is inherently incomplete.** A creative or uncommon romanization can fall through both tiers with zero signal generated — no review case is ever created, and nothing in the evidence trail shows a gap occurred. This is the scenario to worry about most, and no algorithm closes it completely.
- **Nicknames aren't covered** by either tier. A curated nickname-equivalence table is out of scope here.
- **Name-only screening.** A sanctioned individual operating through a newly-formed, unlisted shell entity won't appear on the SDN under that shell's name — a beneficial-ownership problem (OFAC's 50% Rule), out of scope for this design entirely.
- **Vessels/aircraft:** SDN vessel/aircraft records aren't matched against anything in this pass — only client name/DOB. If PCM ever finances vessel/aircraft-backed instruments, the asset itself (IMO number, tail number) isn't screened. Flagged as an open scoping question.
- **List staleness is structurally outside our control** — even a correctly-implemented, on-schedule pipeline can be checking against a list that's already a week-plus behind the newest actual designation (see freshness-gate evidence above).

---

## 4. Review Queue

Interpretation approved: "exact and near-exact clears pass automatically" means the **no-match** outcome at those tiers auto-passes (the routine case). An actual exact/near-exact **hit** is a hard flag, not something that auto-clears — same `flagged` status and same dual-control override path (`POST /:id/ofac/override` → `PATCH .../countersign`, CLOSE-GAP-19a) that already exists, unchanged.

Because fuzzy matching is deferred, the "ambiguous match, could resolve either way" case doesn't exist yet in this pass — so the either-outcome extension to the dual-control mechanism described in the original design report is **not built this pass**. It becomes part of the fuzzy fast-follow, when it's actually needed.

`attested_out_of_band` (the existing out-of-band dual-control attestation) stops being the routine path for OFAC screening now that `clear` can be produced honestly by a real engine, and becomes the exception path — for cases the automated engine can't resolve (e.g. a freshness hard-block).

---

## 5. Evidence

Every screening writes a `pcm_ofac_results` row with:
- `list_version_id` (FK to the ingested version used — reconstructible even after later fetches replace "current")
- `screened_at` (existing column) plus the version's own `retrieved_at`/`publish_date` (joined via the FK) — retrieval time and publish time are different facts, both needed
- `match_method` (`exact` | `near_exact` | `null` for a freshness-block non-run)
- `match_score` (unused until the fuzzy tier ships; column exists now so the fast-follow is additive, not another migration)
- `compared_fields` (JSONB — normalized input name, matched SDN uid + name/alias if any, which tier fired, DOB if present)

Given a `result_id`, the exact list version, exact normalized strings compared, and exact tier that fired can be reconstructed without re-fetching OFAC or trusting a log line.

---

## Effort estimate (from the original design report)

| Piece | Estimate | Why |
|---|---|---|
| Ingestion | 2–3 days | Real ETL; format confirmed live and well-structured |
| Freshness gate | 0.5 day | Small threshold check wired into the existing gate |
| Exact + near-exact matching | 2–3 days | Deterministic and testable; the transliteration table takes real curation time to be worth anything |
| Review queue extension | 1–2 days | **Deferred** — not needed until fuzzy ships |
| Evidence/schema | 1 day | Additive columns on an existing table |
| **Fuzzy matching + scoring** | **1.5–2.5 weeks** | Composite scorer is the easy part; a labeled validation set and responsible threshold tuning is the actual work — this is the piece most dangerous to rush |

**Decision, approved 2026-08-15:** ship ingestion, freshness gate, exact + near-exact matching, evidence, and the intake schema changes this pass. Fuzzy matching ships as its own dated fast-follow, building the labeled validation set as part of that work, not this one.

---

## Intake changes made this pass (addition to original design report, approved 2026-08-15)

- `pcm_clients` gains `given_name`, `family_name`, `date_of_birth` — nullable at the DB level (the one existing test client has no known DOB and it would be fabrication to invent one), enforced as required at the application layer for all new intake going forward, matching this codebase's existing convention for required-field validation (`full_name`/`email`/`country_of_origin` are enforced the same way, not via `NOT NULL`).
- New `pcm_client_id_documents` table for structured ID-document capture (doc type, ID number, issuing country, expiry — plus file-vault metadata matching `pcm_kyc_documents`' existing pattern), since OFAC's `idList` gives us real ID numbers to compare against and we had no structured way to capture a client's own ID number at all before this pass.
- Rationale for doing this now rather than deferring: schema changes get materially harder once real clients exist. With exactly one test client in production at the time of this change, backfilling and tightening is nearly free; it would not be after onboarding volume begins.
