# The twelfth CoreG agent — evidence and resolution

Date: 2026-09-16. Scope: repository history and this local institutional release candidate. Live deployment was not inspected or changed.

## Identification and history
The twelfth agent is **Instrument & Counterparty Integrity Agent**, runtime key instrument-integrity, manifest ID pcm-instrument-integrity. It is a deterministic screening engine, not an LLM.

- July 31: commit c726bbc added the financial-instrument engine, typology library and build registration. The associated July 31 discussion identified the need for early fraud-pattern screening and independent-channel institution verification. Cached discussion is design history, not deployment proof.
- August 13: commit ba949b4 includes the twelfth entry in agent-orchestrator.js. Commit b3eae42 explicitly wires it into asset creation; its commit message explains that the appraisal gate otherwise blocked assets without running screening. Thus build inventory and actual invocation were separate milestones.
- August 13–14: 37dc6a8 and 944cfe8 corrected manifest governance claims. AIS verification, SAL service logging and per-agent Sentinel enforcement were not working controls; those flags remain false.
- Current baseline: legacy asset creation calls classifier, then bank routing, then integrity in a single fire-and-forget chain. Earlier failure skips integrity; ordinary edits do not rescreen. The appraisal gate reads the status. A human verification endpoint exists in pipeline.js, despite older planning text saying it was missing. It updates the legacy result rather than retaining separate immutable review evidence.
- Inventory mismatch: the orchestrator lists 12 modules; ais-agent-registry.json and ais-registration-manifest.json list 11 historical identities. A module count is not proof of 12 active workflows or 12 issued AIS credentials. The historical registries were preserved rather than adding a fabricated identity.
- Institutional RC1 gap: its v2 routes retire production v1 data routes but did not invoke agent 12. This was a gap in RC1 and is corrected in RC2.

Repository source baseline: b493b60d57843d7c824ff6ee60f0dee8468a3550. Relevant paths: agents/instrument-integrity, agent-orchestrator.js, api/routes/assets.js, api/routes/pipeline.js, ais-agent-registry.json, ais-registration-manifest.json and docs/Implementation-Plan-Instrument-Integrity.md. The July 31 discussion was located in the local Claude export under conversation 4acb0e8f-a6b2-4aef-be40-22389b1651de, titled July 31, 2026 - MTN bond issuance scam detection. No confidential transaction documents are reproduced here.

## RC2 implementation
Registration and independently approved fact revisions synchronously invoke the existing agent through institutional-integrity.js without legacy database side effects. A record lock and the same database transaction cover the record, screening and audit event. Engine errors roll back; a hard-block result is preserved with the record for remediation. No automatic verified outcome exists.

Immutable screenings bind the asset, revision, canonical record hash, engine/adapter/typology fingerprint, actor and result. Every stage advance, matching and monetization gate requires a current nonblocked screening plus independent-channel evidence approved by a second compliance/legal reviewer. Corrected facts require a separately approved revision and fresh screening/reviews. New engine/typology versions invalidate current clearance; they do not rewrite earlier screenings.

The portal exposes screening status, limitations and independent verification fields. All screenings are included in CoreG-MTF-2 manifests. Screening does not create a ninth stage: the eight canonical stages and cross-lifecycle AEG governance remain unchanged.

## API and migration
Apply additive migration 0032 after 0026–0031 with the independent migration role. It creates integrity_screenings with row policies and append-only protections, adds reviews.integrity_attestation, and prevents evidence substitution during review decisions. No historical verified flags become institutional approval.

Existing admitted transactions fail closed until POST /api/v2/institutional/transactions/:id/integrity-screening is called with the current revision by an authorized editor. This is idempotent per asset/revision. It cannot replace a previous result or reopen completed records. If an engine change makes a screening stale, independently approve a new revision (even if the facts are unchanged) and obtain fresh evidence approval. Completed RC1 records lacking screening require an approved exceptional remediation plan; this release deliberately provides no silent reopening or retroactive approval.

For a human proposal, POST /transactions/:id/reviews with check_name instrument_integrity, current revision, scanned evidence_document_id, future expires_at, and integrity_attestation containing current screening_id, independent_channel true, source and note. The source must identify a channel obtained independently of submitted documents; the note records findings. A different compliance/legal reviewer uses the existing review decision endpoint. The system enforces distinct accounts and evidence binding; it cannot prove that a human actually performed the described call.

Optional normalized screening inputs are record.integrity_input.isin, cusip, swift_mt_type and swift_raw_message. Existing top-level/details aliases are also screened; conflicting values fail closed. Generic securities identifiers of 12 or 9 characters are treated as ISIN/CUSIP candidates, respectively; other identifier schemes still require human authentication. The full record text is included in typology matching. Unknown/incomplete SWIFT checks block processing rather than count as clearance.

Rollback: freeze institutional writes, retain migration 0032, screenings and manifests, and use a reviewed forward repair or read-only maintenance. Do not restore RC1 as a writable service: it lacks the integrity gate. Do not remove immutable evidence to regain access. The consolidated source installer performs no database migration or deployment.

## Control status
| Item | Status | Boundary |
|---|---|---|
| Local twelfth module and legacy runtime registration | Implemented | Source and Git history; not current deployment proof |
| Synchronous institutional invocation and enforcement | Implemented | Registration/revision, immutable result, all advances and matching; tested with isolated PostgreSQL/API |
| Independent-channel review workflow | Implemented | Document binding, distinct maker/reviewer, expiry/revision/screening binding; humans remain responsible for verification |
| Financial fraud screening | Partial | Seeded regex typologies, checksums and limited field-presence tests; thresholds not calibrated, no full SWIFT grammar or issuer registry authentication |
| Nonfinancial asset fraud detection | Partial | Submission text screening and required human review; no claim of specialized fraud typologies for every family |
| External AIS identity for agent 12 | Evidence Required | Historical registry has 11 entries; no credential invented or registration performed |
| Per-agent AIS/SAL/PQ/Sentinel integrations | Missing | Manifest retains truthful false/unsigned flags; stage-level Sentinel remains a separate control |
| Production execution, provider assurance and immutable cloud retention | Evidence Required | No live deployment, provider test or current production trace obtained |
