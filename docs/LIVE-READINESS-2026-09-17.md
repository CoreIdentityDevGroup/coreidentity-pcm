# CoreIdentity / CoreG live readiness — September 17, 2026

## Verified access and live state
CoreIdentity GitHub OIDC authentication succeeded in account 636058550262 using github-actions-pcm-api-deploy from main. Local default/root credential failures were not evidence that this federation path was unavailable. The role's established trust is main-ref only, without a GitHub Environment. No trust policy was widened.

Audit: https://github.com/CoreIdentityDevGroup/coreidentity-pcm/actions/runs/35232997554

Production pcm-api is ACTIVE with desired/running count 1 and no pending tasks, task definition coreidentity-prod-pcm-api:71, running image b493b60d57843d7c824ff6ee60f0dee8468a3550. Database passwords, JWT_SECRET and Sentinel credentials already use managed secret references. The live task does not reference the new institutional IdP, scanner, vault buckets, keys or cutover configuration. This absence does not establish that those services do not exist elsewhere in CoreIdentity.

The scoped deployment role denied RDS, Cognito and broader secret/storage inventory. The existing infrastructure IAM audit authenticated successfully and inspected the runtime role without retrieving secret values:
https://github.com/CoreIdentityDevGroup/coreidentity-infrastructure/actions/runs/35233219165

## Database evidence
The existing infrastructure Terraform workflow was invoked with target=prod, resource_target=aws_db_instance.pcm, plan_only=true. It refreshed the selected resources, reported no changes, and explicitly skipped Terraform Apply. No infrastructure changes were applied.
https://github.com/CoreIdentityDevGroup/coreidentity-infrastructure/actions/runs/35233470042

Its source revision a5e7f1b0e4d0b690f1a0c84493a610f0e4fb8edb configures encryption at rest with KMS, private access, deletion protection and seven-day automated backup retention. The successful no-change refresh supports those managed configuration values. It does not establish actual backup restoration, recovery time/point objectives, schema readiness, complete row-policy enforcement or operational DR. Multi-AZ is false in the current configuration.

## Repository changes actually made
Audit-only PR #3 was merged to main. It adds a manual read-only inventory workflow and removes automatic main-push application deployment. It changes no application code, schema or AWS resources:
https://github.com/CoreIdentityDevGroup/coreidentity-pcm/pull/3

The institutional application remains in backend draft PR #2 and portal draft PR #2. The backend candidate has been reconciled with main and corrected to preserve the working main-ref OIDC identity. A regression test prevents reintroduction of automatic deployment or an incompatible GitHub Environment. All 84 institutional tests pass locally and the updated branch's CI checks pass.

An earlier transform failed to remove the automatic push trigger because its idempotence check matched a substring. This was caught in the actual workflow audit and corrected before merging application changes. RC3's archived workflow settings are superseded: use the current reviewed repository branch, not the old archive as a production deployment entry point.

## Still required before staging/cutover
- Identify approved existing CoreIdentity human IdP, malware scanner, vault and KYC/AML/sanctions services, or approve an AWS-native design for the missing services. No unearned MFA claims or provider results will be fabricated.
- Verify/provision actual service identities, buckets/keys, retention policy and scanner integration; test them in staging.
- Provide/reconcile actual historical data and tenant ownership, rehearse migrations and backups/restoration in isolation.
- Implement/verify the remaining continuous screening, independent audit anchoring, specialist verification, retention/hold/deletion and custodian integrations documented in PRODUCTION-CLOSURE.md.
- Confirm scoped permissions for the separate candidate preflight task. Existing application deploy permissions alone do not prove permission to run that task.
- Coordinate API and portal promotion only after those requirements pass. No institutional application deployment has occurred.
