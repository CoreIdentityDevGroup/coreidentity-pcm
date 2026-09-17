# Interim external document tracking — September 17, 2026

Release candidate only. No MEGA connection, file movement, cloud provisioning or production deployment is included.

User-reported setup: MEGA Free, owner account has 2FA, Al uses a separate login, shared CoreG folder access has been removed. Account settings and Al's MFA have not been independently verified. Browser policy prevents this agent from inspecting MEGA.

## Implemented in this change
Compliance/legal users with existing recent verified MFA and tenant authorization can register an opaque document code, category and successive external version against an admitted transaction. CoreG suggests CoreG/<transaction UUID>/<DOC-code>/v<number>; a human creates the folder and places the corresponding file in MEGA. There is no automatic file transfer or confirmation that the file exists. Never put a person's name in the reference code.

References and independent review declarations are appended to the existing tenant audit chain under a transaction row lock. There is no update/delete route. A separate reviewer can mark only the latest pending version in the current transaction revision. Completed transactions reject changes. Events are included in the existing Master Transaction File's events array. This preserves reference history, not the actual external file versions or MEGA access history.

Only compliance/legal roles can use these endpoints; do not provision unverified identities or bypass MFA to enable them. Unknown input fields, URLs and credentials are rejected by the narrow metadata contract. Optional SHA-256 values are declared, not verified by CoreG. Both API and UI explicitly report storage unverified, not scanned and ineligible for compliance evidence. External IDs are not inserted into institutional.documents and cannot substitute for vault evidence in reviews or partner approvals.

## Partial / missing / evidence required
Partial: CoreG reference and review history. Missing: direct MEGA integration, automated scans, externally locked file retention, file access attribution, automatic migration. Evidence required: actual account permissions, capacity, retention/recovery practices and provider suitability. No claim of institutional vault equivalence.

## Migration and deployment
No SQL schema migration or new dependency. Uses existing institutional.events policies and immutable triggers; requires the complete existing candidate migrations and identity authorization. Existing production readiness requirements still apply. This feature cannot be deployed alone to the current legacy app, and it does not resolve the paused AWS rollout. Test locally before any release. No sensitive documents were accessed or transferred.

Future vault migration must retrieve each source version through an authorized process, scan it, calculate its actual hash, record a distinct vault document ID and preserve the external reference/version mapping. Only independently approved vault evidence may satisfy compliance requirements. Retain original metadata and record discrepancies; do not fabricate pre-migration access history.

## Rollback
Revert the external-document route mount and portal component/import/tab via the scripted release process, then rebuild both repositories. Keep all recorded audit events and Master Transaction Files; no destructive database rollback is needed. Old events remain available to authorized audit readers. Existing gate and vault behavior is unchanged.
