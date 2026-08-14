# POF Verifier

**Vertical:** Private Capital Markets
**Agent ID:** pcm-pof-verifier
**Trigger:** `stage_2_gate`
**Pipeline Stage:** `kyc_verification`

## Description

Validates Proof of Funds document against bank assignment and declared asset value. Flags inconsistencies.

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
