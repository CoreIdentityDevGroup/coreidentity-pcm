# Document Date Validator

**Vertical:** Private Capital Markets
**Agent ID:** pcm-document-date-validator
**Trigger:** `document_upload`
**Pipeline Stage:** `appraisal_review`

## Description

Cross-checks all submitted document dates against each other. Enforces same-date rule. Flags any date discrepancies to Intake Officer.

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
