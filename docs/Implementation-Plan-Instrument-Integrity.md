# Implementation Plan — Instrument Integrity Gap Closure

**Status:** Phase 0 built, tested, and validated against real `npm run build`. Not yet deployed.

---

## Phase 0 — Built and validated today (ready to deploy as one unit)

Everything below is **already written, idempotency-tested (each script run twice, second run no-ops cleanly), and passes the actual project build** (`npm run build` → 12/12 agents validated, confirmed by running it, not assumed).

| # | Deliverable | What it does |
|---|---|---|
| 1 | `close-gap-01-remove-classifier-fallback.js` | Removes `asset-classifier`'s value-based auto-PROCEED fallback (§6.2 of spec) |
| 2 | `close-gap-02a-migrate-instrument-integrity-schema.js` | Adds `pcm_assets.instrument_integrity_status` column + `pcm_instrument_integrity_results` audit table |
| 3 | `close-gap-02b-wire-integrity-gate.js` | Wires the new status into the `appraisal_review` gate — real enforcement, not advisory |
| 4 | `agents/instrument-integrity/` (index.js, manifest.json, typologies/financial-instruments.json) | v1 agent: ISIN/CUSIP checksum validation (tested against real Apple/BMW/BAE/Treasury identifiers), SWIFT MT field-presence validation, fraud-typology scoring seeded from the UniCredit case pattern |
| 5 | `close-gap-03-register-agent-in-build.js` | Registers the agent in `npm run build` so it's enforced the same as the other 11 |

**Hard dependency — must ship together, not staggered:** Scripts 02a, 02b, and the agent itself. Deploying 02b without the agent (or without 02a's column existing) hard-blocks every asset at `appraisal_review` with no path through. This is intentional fail-closed behavior, not a bug — but it means these three deploy as one atomic unit, on the ops box, in this order:

```
1. node scripts/close-gap-01-remove-classifier-fallback.js
2. node scripts/close-gap-02a-migrate-instrument-integrity-schema.js   # requires DB env vars live
3. node scripts/close-gap-02b-wire-integrity-gate.js
4. node scripts/close-gap-03-register-agent-in-build.js
5. npm run build                                                       # must pass before deploy
6. git add -A && git commit -m "Instrument integrity v1: gap closure per audit findings"
```

**Blocking dependency before this can go live in production:** there is currently no path to ever set `instrument_integrity_status = 'verified'`. The agent can only reach `blocked` or `pending_human_verification`, by design — verification requires a human confirming through an independent channel. **The human-review confirmation endpoint does not exist yet.** Deploying Phase 0 to production without it means every asset entering `appraisal_review` gets permanently stuck. This is Phase 1's first item, not optional follow-on work.

---

## Phase 1 — Required before production deploy (next)

1. **Human-review confirmation endpoint.** A new route (likely `api/routes/pipeline.js` or a new `api/routes/instrument-review.js`) that lets an authorized role (`program_manager` or higher, matching the existing role hierarchy in `pipeline.js`) record a confirmed independent-channel verification and set `instrument_integrity_status = 'verified'`. Must write to `pcm_instrument_integrity_results.reviewed_by` / `reviewed_at` / `verification_channel_note` — those columns already exist in the migration, unused until this ships.
2. **Scoring threshold calibration.** Current `block_threshold: 50` / `review_threshold: 20` in `financial-instruments.json` are starting values, not validated against real transaction history. Needs a review pass once there's live data, or at minimum a walk-through against 5–10 past legitimate transactions to confirm they wouldn't have false-positived.
3. **SWIFT structural validation hardening.** v1 checks field *presence* only (`:16R:`, `:20C:`, etc. exist somewhere in the message). Full ISO 15022 grammar/sequence validation is not yet built — a well-formed-looking fake with the right field tags in the wrong order would currently pass structural checks and rely on typology scoring alone to catch it.
4. **Typology dataset expansion.** v1's `financial-instruments.json` is seeded from the one demonstrated case, not a real FBI IC3/FinCEN dataset pull. Needs actual sourcing before we'd call this "comprehensive."

## Phase 2 — Fast-follow (per §6.3 decision to not bundle)

5. **`ofac-screening` hardening.** Immediate part (fuzzy/phonetic name matching, expanded risk-category list) can ship as its own scripted transform, same pattern as today's work. Full OFAC SDN list integration is a genuine external data-ingestion dependency — separate spec, own timeline.

## Phase 3 — Typology expansion (per spec §2 sequencing)

6. Real estate title typology module
7. Precious-metals assay typology module
8. Private equity cap-table typology module

Each reuses the same `agents/instrument-integrity/index.js` engine — only a new `typologies/*.json` file and asset-class-specific structural validators are needed, not a new agent from scratch.

## Side-finding, not yet actioned

`asset-classifier/manifest.json` (and likely other agent manifests) reference `"runtime": "vertex-ai"`, `"model": "gemini-2.0-flash"` — a live GCP/Vertex AI reference, which is on the explicit kill-list (GCP fully decommissioned). The new `instrument-integrity` manifest was deliberately written as `"runtime": "node"` to avoid repeating this. **Recommend a full manifest audit across all 12 agents** to find and correct any other stale GCP references — not scoped or done as part of this work, flagging so it doesn't get lost.
