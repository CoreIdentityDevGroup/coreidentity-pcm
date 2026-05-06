# Deletion Certification Agent

**Vertical:** Private Capital Markets
**Agent ID:** pcm-deletion-certification
**Trigger:** `trade_closure_event`
**Pipeline Stage:** `completed`

## Description

Executes automated deletion of sensitive vault contents at trade closure. Generates cryptographic deletion certificate.

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
