# OFAC Screening Agent

**Vertical:** Private Capital Markets
**Agent ID:** pcm-ofac-screening
**Trigger:** `stage_2_gate`
**Pipeline Stage:** `kyc_verification`

## Description

Runs client name, entity, and banking partner against OFAC/sanctions watchlists via third-party API. Logs result to audit trail.

## Governance

| Control | Value |
|---------|-------|
| AIS Identity | Required |
| SAL Logging | Full |
| Sentinel | Enforced |
| PQ Signing | ML-DSA-65 |
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
