# Intake Parser

**Vertical:** Private Capital Markets
**Agent ID:** pcm-intake-parser
**Trigger:** `new_intake_submission`
**Pipeline Stage:** `intake`

## Description

Reads inbound emails and uploaded documents. Extracts keywords. Identifies asset type. Routes to correct pipeline category.

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
