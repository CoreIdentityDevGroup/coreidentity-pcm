> Superseded access/deployment findings: see LIVE-READINESS-2026-09-17.md. CoreIdentity OIDC access now verified; managed credentials already present; 84 tests pass. Provider/cutover gaps remain open.

# Production closure status — September 17, 2026

Status: IN PROGRESS. Production authorization was given by the user. No production deployment or cloud mutation has been performed. The local AWS default and root profiles both return InvalidClientTokenId; related inventory calls return UnrecognizedClientException/InvalidAccessKeyId. GitHub access works. Main remains at backend b493b60d57843d7c824ff6ee60f0dee8468a3550 and portal 481de66653bbff1b7b6996d592f36ad3a65b2ead.

## Newly closed code gaps
- Participant register, declared ownership/control graph, duplicate/invalid/cyclic declarations rejected at admission, and separate identity/authority/AML/sanctions/beneficial-ownership evidence per declared party. No beneficial owner is inferred from a transaction-level checkbox. Completeness of the declaration remains independently reviewed evidence; real registry/provider verification is not fabricated.
- Portal participant/register editing and independent fact-revision decision UI. Proposed changes freeze processing. Approval creates a new revision and invalidates all prior evidence.
- Rotating RSA signing keys from a configured HTTPS JWKS endpoint, bounded response size, short cache (60 seconds), algorithm/key validation, fail-closed outages and recent MFA enforcement. Fixed public keys remain supported. Actual IdP provisioning and MFA assurance require provider evidence; no unsupported provider-specific claims are mapped to MFA.
- Production startup/readiness verifies restricted non-owner database role, required institutional tables, forced row policies, integrity immutability and both private, versioned, KMS-protected retention-locked vaults. A separate preflight task checks the candidate before ECS service mutation. This is a bounded runtime check, not a full institutional certification.
- Deployment workflow now runs clean dependency installation, institutional tests and build, requires managed secrets instead of historical plaintext password settings, uses serialized manual deployment, checks candidate runtime before replacing the service and checks /ready afterward. Main pushes no longer automatically deploy through this workflow. The workflow changes are candidate source until merged.
- The documented temporary SDN UAT relaxation (14-day block threshold) is removed, restoring its documented 7-day baseline. Exact/near-exact matching, publication-age limitations and provider completeness remain disclosed. Successful recent daily ingestion workflows are historical evidence of ingestion, not proof of current client rescreening or this candidate's deployment.

## Evidence and boundaries
83 institutional tests pass locally, including the complete lifecycle. New coverage includes per-participant evidence requirements, invalid ownership declarations, key rotation/cache expiry/outage and database readiness under pcm_app. Database testing uses isolated PostgreSQL WASM, not production RDS. Cloud and IdP tests use controlled doubles; real cloud success, actual MFA and recovery remain unverified. Portal builds pass; authenticated browser/provider flows remain pending.

## Remaining release blockers
| Gap | Status | Required resolution |
|---|---|---|
| AWS deployment access | Evidence Required | Refresh a least-privileged CoreG login/profile; both saved profiles are rejected |
| Existing production configuration | Evidence Required | Live ECS, RDS, vault, network and backup inspection after access restoration; no secret values in reports |
| IdP configuration and enrollment | Partial | Provide approved provider/issuer/audience, signing discovery and actual MFA claims; test revocation and membership provisioning |
| Malware scanner and vault runtime | Partial | Configure approved scanner credentials and storage identity; verify clean/infected files, private IAM, generations, locked retention, KMS and actual access logs |
| Ongoing participant KYC/AML/sanctions | Partial | Select/provision provider, wire participant screening and repeat screening/cases; validate list coverage and actual beneficial-owner completeness |
| Independent agent-12 AIS identity and signatures | Evidence Required / Missing | Confirm or issue real scoped identity through the actual AIS API; implement verified governance/signing services before changing false/unsigned manifest flags |
| Custodian/regulated partner verification | Partial | Institution-specific licensing/custody verification and executed operating arrangements; no CoreG custody is implied |
| Historical record migration | Missing | Obtain actual schema/data inventory, verified tenant map, document lineage and reconciliation; stage restored data before any cutover |
| Immutable external audit checkpoint/manifest backup | Partial | Separately administered locked storage, signed checkpoints and real recovery exercise; local hash chains alone do not resist a database administrator |
| Retention, legal hold release and secure PII deletion | Partial | Approved policy and exceptions; implement/rehearse controlled release/deletion against that policy without deleting required transaction evidence |
| Backup and disaster recovery | Evidence Required | Verify encrypted backups, restore isolated copy, measure approved recovery objectives and rehearse rollback |
| Alert delivery and monitoring | Partial | Configure delivery destination/service and persistent repeat-screening/alert worker; do not treat recorded events as delivered notices |
| Specialist asset verification | Partial | Expert review, report extraction/validation and actual registry/lab/chain/custodian integrations where available; code does not certify NI 43-101, assays or title |
| Residual dependency advisories | Implemented | All six prior findings remediated with pinned overrides; npm reports zero vulnerabilities, cloud SDK loading checks and full tests pass |
| Production promotion | Evidence Required | Rehearse on real staging infrastructure, reconcile every migrated record, then coordinate API/portal cutover and monitor |

This list remains open. The release must not be represented as having closed all Required-tier gaps. Deployment authorization is already present; the outstanding requirements are access, configuration, evidence and implementation, not a repeated request for permission.

## Migration and rollback
Apply migrations 0026–0032 with a separate administrator. New participant requirements use existing revisioned records and review tables; no additional database migration is needed for this increment. Existing records without a complete participant register and party-specific reviews fail closed. Do not carry forward old verified flags, remove RLS, fake MFA claims or toggle cutover simply to make health checks pass.

Production configuration adds optional PCM_IDP_JWKS_URL (HTTPS). Configure it instead of a fixed public key for rotation; the issuer/audience and verified MFA claims remain required. Runtime database users must be pcm_app and must not own institutional tables or bypass RLS. Migrate all listed workflow credentials to Secrets Manager/SSM references before deployment. Configure both backend and portal IdP values together. The separate candidate preflight requires ECS run-task/describe/stop permissions and existing private service networking.

Before institutional writes, preserve the prior image/configuration and back up databases and object inventories. After institutional writes, freeze writes and use a reviewed forward repair or read-only maintenance. Do not roll back to a writable legacy/RC1/RC2 version that lacks newer admission requirements; preserve all evidence and reconcile it. No deployment or data migration is performed by the source installer.
