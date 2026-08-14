# Bank Routing Agent

**Vertical:** Private Capital Markets
**Agent ID:** pcm-bank-routing
**Trigger:** `stage_4_gate`
**Pipeline Stage:** `bank_assignment`

## Description

Recommends appropriate trader bank based on client geography, asset type, and trade program requirements.

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
