# OFAC Screening Agent

**Vertical:** Private Capital Markets
**Agent ID:** pcm-ofac-screening
**Trigger:** `stage_2_gate`
**Pipeline Stage:** `kyc_verification`

## Description

Heuristic pre-screen only -- matches client name/country against a hardcoded list (10 countries, 4 regex patterns compiled into source). Does NOT call any external OFAC/SDN API or watchlist. A match is real signal (status: flagged); no match does NOT mean a real sanctions screen cleared this client (status: not_authoritatively_screened). Logs result to audit trail.

**CLOSE-GAP-25:** full OFAC SDN list integration is tracked separately (see docs/Instrument-Counterparty-Integrity-Agent-Spec.md §6.3) -- ingesting Treasury's actual SDN dataset and a real matching pipeline is a genuine data-integration dependency, not something this agent currently does.

## Governance

| Control | Value |
|---------|-------|
| AIS Identity | Required |
| SAL Logging | Full |
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
