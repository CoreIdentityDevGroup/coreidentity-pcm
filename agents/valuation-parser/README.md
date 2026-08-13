# Valuation Parser

**Vertical:** Private Capital Markets
**Agent ID:** pcm-valuation-parser
**Trigger:** `stage_3_gate`
**Pipeline Stage:** `appraisal_review`

## Description

Extracts declared value, appraiser identity, and appraisal date from uploaded valuation documents. Stores parsed output in Asset DB.

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
