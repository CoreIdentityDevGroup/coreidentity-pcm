# OFAC Screening Agent

**Vertical:** Private Capital Markets
**Agent ID:** pcm-ofac-screening
**Trigger:** `stage_2_gate`
**Pipeline Stage:** `kyc_verification`

## Description

Real screening against OFAC's actual SDN list. `scripts/ofac-sdn-ingest.js` fetches and versions the list (`pcm_sdn_list_versions`/`pcm_sdn_entries`/`pcm_sdn_aliases`); this agent screens each client against the most recent successfully-ingested version at `lib/matcher.js`'s exact and near-exact tiers. See `docs/SDN-Sanctions-Screening-Design.md` for the full design, endpoint verification, threshold derivation, and stated weak points.

**Freshness gate** (`lib/freshness.js`): screening against a list older than 7 days blocks (`not_authoritatively_screened`) rather than clears; 4–7 days old warns without blocking.

**Tiers implemented:** exact (normalized string match) and near-exact (normalization + a bounded, explicitly non-exhaustive transliteration-equivalence table). A match at either tier is a hard flag (`flagged`) resolved via the existing dual-control override flow (`POST /:id/ofac/override`). **Fuzzy matching (tier 3) is not built** — explicit, separately-dated fast-follow requiring a labeled validation set; see the design doc's effort estimate for why it wasn't rushed into this pass.

**What this does NOT catch, stated plainly:** transliteration variants outside the curated table; nicknames; beneficial-ownership/shell-entity structures (name-only screening); DOB is captured at intake but not yet used as a matching filter. See the design doc's "weak points" section for the full list.

**CLOSE-GAP-25 (superseded):** this was the fast-follow spec referenced in docs/Instrument-Counterparty-Integrity-Agent-Spec.md §6.3 — now implemented for the exact/near-exact tiers.

## Governance

| Control | Value |
|---------|-------|
| AIS Identity | Not required (aisVerify() targets a nonexistent ais-api endpoint and is unreachable ESM code in this CJS repo; see manifest.json ais_required_reason) |
| SAL Logging | None (sal-client.js is a stub with no real backend; see manifest.json sal_logging_reason) |
| PQ Signing | UNSIGNED-NO-PQ-BACKEND-V1 |
| Human Gate | Per pipeline stage |
| Reversible Actions | Yes — no irreversible actions without human gate |

## Inputs

See `manifest.json` — inputs field.

## Outputs

See `manifest.json` — outputs field.

## Implementation Status

- [ ] `execute()` function implemented
- [ ] Input schema defined in manifest.json
- [ ] Output schema defined in manifest.json
- [ ] AIS registration completed
- [ ] SAL logging verified
- [ ] Unit tests written
- [ ] Integration test passed
