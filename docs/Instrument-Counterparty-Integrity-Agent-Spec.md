# Instrument & Counterparty Integrity Agent — Technical Specification

**Agent ID:** `instrument-integrity` (Agent #12)
**Platform:** CoreIdentity PCM (`coreidentity-pcm`)
**Status:** DRAFT — pending validation
**Audit basis:** Direct source review of all 11 existing PCM agents, `github.com/IMG2025/coreidentity-pcm`, confirmed via `git clone`

---

## 1. Why This Agent Exists

A direct audit of all 11 live PCM agents (`asset-classifier`, `bank-routing`, `contract-monitoring`, `deletion-certification`, `document-date-validator`, `intake-parser`, `ofac-screening`, `pof-verifier`, `token-minting`, `transaction-monitoring`, `valuation-parser`) confirmed **zero agents perform instrument authenticity or fraud-typology validation**. Every existing agent checks one of: field presence, date consistency, pipeline staleness, keyword classification, or a static routing table.

**Concretely demonstrated failure mode:** a submitted €29B "MTN Bond" offer (UniCredit Bank Germany, prime-bank-instrument fraud hallmarks — non-negotiable 90% LTV, rushed DOA/BCL, garbled MT542 syntax, mismatched ISIN/CUSIP, CDS terminology bleeding into a bond confirmation) would be processed as follows under current agents:

| Agent | Behavior on this input |
|---|---|
| `intake-parser` | Passes — required fields present |
| `asset-classifier` | Keyword-matches "swift," "bond," "sovereign" → classifies as `bond` or `sblc`; **or**, if no keywords hit, the declared value (€29B ≥ $50M threshold) triggers an **automatic `sblc` classification with `action: PROCEED`** — the fraud is waved through on size alone |
| `ofac-screening` | Passes — no sanctioned country/name pattern match |
| `document-date-validator` | Passes — dates aren't the failure point |
| `bank-routing` | Passes — routes to a correspondent bank by jurisdiction, doesn't validate the instrument itself |
| `pof-verifier`, `valuation-parser`, `token-minting`, `transaction-monitoring`, `contract-monitoring`, `deletion-certification` | Not instrument-authenticity checks; none intercept this |

**Net result: the transaction reaches token-minting / capital deployment stages with no agent ever asking "is this instrument real?"** This is the highest-severity, highest-frequency risk category for a capital markets platform, and it is currently unguarded. This spec closes that gap.

---

## 2. Scope and Position in Pipeline

**Placement:** Upstream of `asset-classifier`, immediately after `intake-parser`. Nothing reaches classification, routing, or valuation until it clears authenticity screening. This is a **structural change to pipeline order**, not just a new independent check — a fraudulent instrument must not reach agents downstream that assume good-faith content.

```
intake-parser → [NEW] instrument-integrity → asset-classifier → bank-routing → valuation-parser → pof-verifier → token-minting
                        │
                        └─ fail-closed hard block → human review queue (does NOT auto-clear)
```

**Architecture decision — all asset classes are in scope, via a shared framework, not one monolithic ruleset.**

Cramming financial-instrument fraud, real estate title fraud, precious-metals assay fraud, and private equity cap-table fraud into a single flat `fraud-typology.json` would violate the same single-responsibility principle every other PCM agent already follows, and would make the typology file unmanageable and unauditable. The correct first-principles design: **one shared integrity framework, with a pluggable typology module per asset class.** All asset classes share the same fraud-scoring engine, structural-validation harness, independent-verification enforcement, and fail-closed gate logic — only the typology rules and structural checks differ per domain.

```
agents/instrument-integrity/
  index.js                          ← shared engine (scoring, verification-channel enforcement, fail-close logic)
  typologies/
    financial-instruments.json      ← MTN/SBLC/BG/SKR/LC/DLC, SWIFT/ISIN/CUSIP (v1 — built first, per §1 failure mode)
    real-estate-title.json          ← title chain-of-custody fraud, forged deed/lien patterns
    precious-metals-assay.json      ← forged assay certs, vault-receipt fraud, phantom bullion
    private-equity-captable.json    ← forged cap tables, phantom share classes, fake fund NAV statements
    structural-validators/          ← per-domain structural checks (SWIFT/ISIN/CUSIP now; deed registry format, assay-lab certificate format, cap-table schema validation as added)
```

**In scope (all, via the framework above):**
- Bank/financial instruments (MTN bonds, SBLC, BG, SKR, LC, DLC) — **v1 build priority**, given the demonstrated live failure mode in §1
- SWIFT-referenced instruments (MT7xx, MT5xx series, MT542, MT760, MT799)
- Real estate title and deed fraud
- Precious-metals assay and vault-receipt fraud
- Private equity cap-table and fund-interest fraud
- Any submission with a declared value that would trigger `asset-classifier`'s value-based auto-classification fallback (see §6 — this fallback should be removed regardless of asset class)
- Corporate action / bond issuance documentation

**Sequencing, not scope-cutting:** financial instruments ship first because that's the proven live gap. Real estate, precious-metals, and PE typology modules are v1.1–v1.3 follow-ons under the *same agent and same engine* — not a future "maybe" agent with its own infrastructure to rebuild from scratch. This keeps everything genuinely in scope while not blocking the urgent fix on building four typology libraries at once.

---

## 3. Core Capabilities

### 3.1 Fraud-Typology Pattern Matching
Maintained, versioned library of known fraud structures, scored against submission content and metadata — not just keyword presence, but *combinations* of structural and linguistic markers:

- **Prime bank instrument / monetization fraud markers:** "non-negotiable" fee/LTV language, "monetization" of a sovereign/bank bond by a private intermediary, instant-liquidity claims, urgency-to-sign framing (DOA/BCL/CIS bundled with a compressed timeline), unsolicited-offer origin
- **Advance-fee fraud markers:** upfront "commission," "due diligence fee," or "processing fee" required before any verified counterparty contact
- **Document-internal inconsistency markers:** terminology mismatches (e.g., CDS/derivative language inside a bond purchase confirmation), corporate action types that don't correspond to any real action taxonomy, ISIN/CUSIP present but structurally invalid (see §3.2)
- Each match contributes to a **composite fraud-risk score**, not a single boolean — avoids single-point false negatives/positives

**Data source requirement:** typology library must be **versioned and updateable** (not hardcoded like `ofac-screening`'s current static country list) — new fraud patterns get added as they're identified, without a full redeploy. Store as external config (`fraud-typology.json`), loaded at runtime.

### 3.2 Structural/Syntax Validation
Real validation, not string matching:

- **SWIFT MT message parsing** — actual field-block grammar validation for MT542, MT760, MT799, MT7xx series (sender/receiver BIC format, mandatory field presence per message type, field-length/format compliance). A garbled or field-incomplete MT message is a hard fail, not a "medium confidence."
- **ISIN validation** — 12-character format (2-letter country code + 9 alphanumeric + 1 check digit) with **checksum verification** (modulus 10 Luhn-style, per ISO 6166)
- **CUSIP validation** — 9-character format with checksum verification (per ANSI X9.6)
- **BIC/SWIFT code format validation** — 8 or 11 character structure, valid country/location code
- Any instrument citing an ISIN/CUSIP that fails checksum is a hard fail — this alone would have caught the UniCredit doc's mismatched identifiers.

### 3.3 Independent-Channel Counterparty Verification
- For any instrument-backed transaction above a defined threshold (recommend: any MTN/SBLC/bond instrument regardless of value, given the demonstrated failure mode — value thresholds are how the fraud got auto-classified as legitimate), the agent **requires confirmation through a channel independently sourced from the deal documents.**
- **Explicit rule:** contact information supplied *within* the submitted package (email, phone, "G-Meet" link) may never be used for verification. Verification contact must be pulled from an independently maintained registry (e.g., issuing bank's official corporate/institutional banking directory) or human-confirmed via out-of-band lookup.
- Until independently verified, transaction status is `PENDING_VERIFICATION` — not `PROCEED`, not silently continuing to next stage.

### 3.4 Fail-Closed Enforcement
- **Critical departure from existing agent pattern.** Every current agent that flags an issue (e.g., `ofac-screening`) returns a `flagged` status but does not appear to block pipeline progression on its own — that's enforced elsewhere, inconsistently. This agent's flag state must be **binding**: `fraud_risk_score ≥ threshold` OR `structural_validation = FAIL` OR `verification_status = UNVERIFIED` → hard block, transaction cannot advance to `asset-classifier` or any downstream stage regardless of other agent outputs.
- Ambiguous cases (partial structural failure, moderate typology score) escalate to **mandatory human review** — the agent does not self-clear ambiguity, only confirms or blocks.

---

## 4. Explicit Non-Goals

- This agent does not replace `ofac-screening` (sanctions/PEP screening is a distinct control) — but §6 flags that `ofac-screening`'s current implementation also needs hardening.
- This agent does not perform legal/regulatory compliance mapping (Reg D, MiFID II, etc.) — that's a separate control plane concern.
- This agent is not a general "AI judgment call" — every block/pass decision must be traceable to a specific rule (typology match ID, checksum failure, unverified-channel flag) for audit purposes, consistent with SAL's audit-trail requirement.

---

## 5. Technical Implementation Requirements

Per standing engineering rules:
- **Zero hand edits** — delivered via scripted transform, not manual file creation in the repo
- **Idempotent** — script must be safely re-runnable without duplicating the agent directory or corrupting pipeline config
- **Ends with `npm run build`**
- **Enterprise-grade** — proper error handling, no silent failures, structured logging consistent with `shared/agent-base.js` pattern already used by the other 11 agents
- New agent directory: `agents/instrument-integrity/index.js`, following the existing `execute(context)` interface pattern
- New config file: `agents/instrument-integrity/fraud-typology.json` (versioned, externally editable)
- Pipeline registration: insert into orchestration order between `intake-parser` and `asset-classifier` (exact file TBD — needs confirmation of where pipeline stage order is defined; not yet located in this audit)
- Must integrate with `shared/sal-client.js` for authorization/audit-trail logging of block/pass decisions (SAL governs authorization — this agent's decisions should be recorded there, not just in agent-local output)

---

## 6. Findings for Validation — Confirmed Gaps, Prioritized for Immediate Closure

Per direction: these are not deferred to "future work." Status below reflects what can close immediately vs. what has a hard dependency blocking "ASAP."

### 6.1 — RESOLVED: Pipeline enforcement mechanism located and confirmed real (was Finding 3)
Direct source review of `api/services/pipeline.js` confirms genuine fail-closed enforcement: `GATE_REQUIREMENTS` defines a checker function per pipeline stage; `validateGate()` runs it inside `advancePipeline()`; any non-empty `errors` array returns HTTP 422 and **blocks the database stage transition** — this is not advisory logging, it is a real gate. OFAC's `flagged` status is already wired into the `kyc_verification` gate this way.

**The actual gap:** none of the six existing `GATE_REQUIREMENTS` entries (`kyc_verification`, `appraisal_review`, `bank_assignment`, `collateralization`, `monetization`, `securitization`) check instrument authenticity, classification confidence, or any fraud-typology result. They check document counts, OFAC status, and date-validation status only.

**Closure action (immediate, low-risk, no new infrastructure needed):** add `instrument_integrity_status` as a required condition inside the existing `appraisal_review` gate function — this is the earliest existing gate after intake/KYC, and it already blocks on missing valuation, so adding one more `errors.push()` condition follows the established pattern exactly (see §8 for the scripted transform). This closes the binding-enforcement question **as soon as the agent ships** — no separate orchestration-layer project required, which was the risk flagged in the prior draft.

### 6.2 — CLOSE NOW: `asset-classifier` value-based auto-PROCEED fallback
Confirmed: any submission with no keyword match and declared value ≥ $50M auto-classifies as `sblc` with `action: PROCEED` — this is the exact mechanism that would have waved the €29B instrument through with zero scrutiny. This is a small, isolated, low-risk change independent of the new agent's build timeline.

**Closure action (ship immediately, separate scripted transform, do not wait on the full agent):** remove the value-based fallback entirely. Replace with `action: 'REQUEST_MANUAL_CLASSIFICATION'` regardless of declared value when no keyword match is found. No transaction should ever reach `PROCEED` on size alone. See §8, Script 1.

### 6.3 — HARDEN NOW, FULL FIX HAS A DEPENDENCY: `ofac-screening`
Confirmed: hardcoded 10-country list, four regex name patterns (`al-qaeda`, `taliban`, `isis`, `hezbollah`, `hamas`, literal "SDN/SDGT/OFAC" string), no real OFAC SDN list integration, no fuzzy name matching.

**What closes immediately:** expand the static list to the full country/entity risk categories, add fuzzy/phonetic name matching (e.g., Levenshtein or Jaro-Winkler threshold matching, not exact regex) against the existing pattern set — this alone catches transliteration variants the current exact-match misses.

**What cannot close "ASAP" honestly:** full OFAC SDN list integration requires ingesting Treasury's actual SDN dataset (CSV/XML, updated by OFAC directly) and a real matching pipeline against it — that is a genuine data-integration dependency, not a same-day script. Flagging this now rather than overstating a timeline: recommend this ships as a fast-follow spec immediately after this agent, not bundled into it, so the financial-instrument fraud gap (the proven live failure) isn't delayed waiting on SDN data-source integration.

---

## 7. Open Items Before Build

- [x] ~~Locate and confirm pipeline orchestration/stage-order definition file~~ — **RESOLVED**: `api/services/pipeline.js`
- [x] ~~Confirm whether agent flagged/fail statuses are enforced at orchestration level~~ — **RESOLVED**: real fail-closed gates via `GATE_REQUIREMENTS`/`validateGate`, confirmed in §6.1
- [ ] Source or build initial fraud-typology library, financial-instruments module (v1 dataset — recommend starting from FBI IC3, FinCEN advisories, and documented prime-bank-instrument fraud case patterns)
- [ ] Define fraud-risk composite scoring thresholds (what score = hard block vs. human review)
- [ ] Confirm independent-verification registry source (issuing-bank official directories) and who performs manual out-of-band confirmation
- [ ] Source typology data for real-estate-title, precious-metals-assay, and private-equity-captable modules (v1.1–v1.3, per §2)
- [ ] `ofac-screening` full SDN integration — confirmed as fast-follow spec, not bundled (§6.3)
- [ ] **Discovered during v1 build/testing:** ISIN/CUSIP checksum validation confirms format correctness only, not that the identifier is actually registered to a real security (e.g., `000000000` is checksum-valid but not a real CUSIP). A live registry lookup (ISIN/CUSIP database service) is required to close this fully — flagging now so this isn't overstated as "verifies the instrument is real" when it only verifies "the number is well-formed"
- [ ] Build the human-review confirmation endpoint — the only path that may set `instrument_integrity_status = 'verified'`. The agent itself can only reach `blocked` or `pending_human_verification`; this endpoint does not yet exist and is required before any asset can pass the new gate

## 8. Immediate Closure Scripts (ship ahead of full agent build)

Both follow standing engineering rules: scripted transform, idempotent, ends with `npm run build`. These are small, isolated, and should not wait on the full `instrument-integrity` agent or typology library sourcing.

**Script 1 — remove `asset-classifier` value-based auto-PROCEED fallback (§6.2)**
- Target: `agents/asset-classifier/index.js`
- Change: delete the `if (!best_match && value > 0)` block; replace terminal fallback with `action: 'REQUEST_MANUAL_CLASSIFICATION'`
- Idempotency check: script should detect if the fallback block is already absent and no-op cleanly rather than error

**Script 2 — add `instrument_integrity_status` condition to `appraisal_review` gate (§6.1)**
- Target: `api/services/pipeline.js`, `GATE_REQUIREMENTS.appraisal_review`
- Change: add a DB check (new column `instrument_integrity_status` on `pcm_assets`, default `'pending'`) — push a gate error if status is not `'verified'`
- Requires: a migration script for the new column (idempotent — `ADD COLUMN IF NOT EXISTS`)
- **Note:** this gate condition can be added and deployed now, defaulting all assets to `'pending'` until the full `instrument-integrity` agent ships and starts writing `'verified'`/`'flagged'` values — this means the gate will hard-block *all* assets at `appraisal_review` the moment it's deployed, until the agent exists to clear them. **This sequencing needs an explicit decision before deployment**: either (a) ship the gate and the minimum-viable agent together, or (b) ship the gate in a non-blocking "log only" mode first, then flip to enforcing once the agent is live. Recommend (a) — a gate that doesn't yet block anything defeats the purpose of closing this "ASAP," and the whole reason for this spec is that we don't want a window where the gate exists but doesn't enforce.
