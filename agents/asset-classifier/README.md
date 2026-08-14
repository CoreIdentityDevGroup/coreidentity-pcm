# Asset Classifier

**Vertical:** Private Capital Markets
**Agent ID:** pcm-asset-classifier
**Trigger:** `post_intake_parse`
**Pipeline Stage:** `intake`

## Description

Classifies asset as RE, Precious Metals, Cash/Wealth, SBLC, or SKR. Assigns pipeline parameters based on asset type.

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
