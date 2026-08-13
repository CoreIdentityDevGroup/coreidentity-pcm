# Token Minting Agent

**Vertical:** Private Capital Markets
**Agent ID:** pcm-token-minting
**Trigger:** `stage_8_trade_close`
**Pipeline Stage:** `tokenization`

## Description

Mints a classification certificate upon trade completion. Certificate is not cryptographically signed — no PQ signing backend is implemented. ID and verification only — no transferable right.

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
