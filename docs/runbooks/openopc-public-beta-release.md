# OpenOPC Public-Beta Release Runbook

This runbook is for the protected `production` approval workflow. It never
deploys production by itself. The release remains disabled unless the exact
candidate commit, evidence ledger, artifact set, policies, regional records,
rollback target, and human approval all agree.

## Preflight

1. Record the staging workflow run ID and the full candidate commit.
2. Confirm the candidate bundle contains `release-candidate.json` and
   `evidence.v2.json`; do not use `tests/public-beta/*.fixture.json` as staging
   evidence.
3. Confirm all G1-G12 and B1-B10 lanes are current, passed, and bound to the
   same commit and `openopc-public-beta-staging` environment.
4. Confirm the Web, Admin, API, module host, worker, WASI Runner, OCI Runner,
   and Windows Desktop artifact digests, SBOM/provenance records, and rollback
   manifest are present.

## Backup And Migration

Before rollout, record the measured PostgreSQL backup/PITR state, object-store
restore state, RPO/RTO result, and migration lint/apply/idempotency result. A
backup plan without a successful isolated restore does not satisfy B7. Stop the
release if migration guards, restore consistency, or post-restore smoke fail.

## Current Automation Blockers

This release path is fail-closed. The repository does not yet contain the
canonical `.github/workflows/openopc-public-beta-gates.yml` producer, so there
is no valid `candidate_run_id` or `openopc-public-beta-staging-bundle` to
approve. Do not substitute another staging or QA workflow.

The following required operational controls are also absent and keep the
candidate `not_ready`:

- B7: automated PostgreSQL PITR and object-store backup, isolated restore,
  consistency verification, measured RPO/RTO, and cleanup evidence.
- G10: the public-beta release lifecycle, canary, consent-diff, and rollback
  manifest tooling needed to prove a reversible module release.
- B10: resumable two-node rollout checkpoints, execution drain, public/private
  exposure verification, and capture plus restoration of prior feature flags.
- G3/G10: a trusted provenance verifier that recomputes and cross-binds the
  evidence schema and artifact-set digests, rollback manifest, and regional
  evidence to the exact candidate. Until it exists, the CLI returns
  `PUBLIC_BETA_RELEASE_PROVENANCE_VERIFIER_REQUIRED` and cannot return `ready`.
- G3/G10: raw candidate ZIP download verification against the authenticated
  GitHub Actions artifact digest. `download-artifact` warning-only digest output
  is not sufficient evidence of archive authenticity.
- B10: a remote-artifact transport that pins each vetted resolved address (or a
  registry client with an equivalent address policy). A pre-fetch DNS check
  reduces SSRF exposure but does not by itself eliminate DNS rebinding.

Do not replace these controls with manual statements in the evidence ledger.
Implement the tools, run the real staging drills, retain their raw artifacts,
and only then produce the corresponding Gate evidence.

## Gate Failures

Keep every failed or blocked attempt and its raw artifact. Do not delete a
failure or rerun until a flaky pass hides it. A candidate with any stale,
mixed-commit, `not-run`, missing, or unresolved Gate evidence remains
`not_ready`; the validator must report the owning reason.

## Rollback Target

The candidate must name a different, immutable rollback commit and manifest
digest. Verify that target can be fetched and that its schema, artifact set,
policy versions, and migration rollback procedure are compatible before
requesting approval.

## Regional And Policy Preconditions

Record the exact Terms, Privacy Notice, Acceptable Use Policy, module rules,
retention/deletion rules, security contact, and abuse-reporting versions. Attach
the external regional evidence for domain, filing, privacy, content governance,
and incident notification. For a mainland-China deployment, include the
applicable ICP and related service approvals. Missing or expired regional
evidence keeps registration closed.

## Protected Approval

Before dispatching, configure the repository `production` environment with
**required reviewers**, enable **Prevent self-review**, restrict deployment
branches to protected `main`, and disable administrator bypass. Do not rely on
the workflow dispatcher as evidence of approval: the approval job queries the
workflow-run review history and records the actual non-dispatching reviewer.

Dispatch `.github/workflows/openopc-public-beta-approval.yml` with
`candidate_run_id` and the full `expected_commit`. The `production` environment
is reached only after the read-only `validate` job succeeds; it then pauses for
an authorized approver. Both jobs download the same immutable run-id bundle and
apply bundle-root containment plus reparse-point checks. Both jobs run the
validator and digest helper from the protected `main` workflow SHA, not from
the candidate checkout; the attestation records that control ref/SHA and the
first approval-run attempt. The workflow verifies SHA-256 values and invokes
the validator as
`pnpm.cmd exec bun scripts/release/public-beta-release-manifest.ts ...`, which
preserves the Bun CLI's `0`/`2`/`64`/`65` exit contract and one-line JSON stdout.
After the missing provenance and archive controls are implemented, the expected
pre-approval exit is `2`, and its JSON result includes exactly
`PUBLIC_BETA_HUMAN_APPROVAL_REQUIRED`; no other unresolved reason is allowed.
Until then, do not waive the additional blocking reason. After approval it
creates an attestation bound to the canonical pre-approval manifest, then
reruns validation.

## Rollout And Smoke

After the workflow reports `ready`, deploy in this order: backup/preflight,
backward-compatible migrations, API and workers, Web/Admin, Runners, then
feature enablement. Verify Web without Desktop, Admin hostname isolation,
realtime/TLS, private dependency exposure, module-host boundaries, telemetry,
and the packaged Windows Desktop smoke. Keep public registration and default-
off runtime/commercial flags disabled until the smoke is complete.

## Rollback Decision

Rollback immediately when health, authorization, tenant isolation, migration
consistency, runtime isolation, data recovery, or public exposure checks fail.
Drain execution work, apply the recorded rollback manifest, restore the prior
feature flags, rerun Web/Admin/API/Runner smoke, and retain the incident and
approval artifacts. Never substitute a different commit or silently overwrite
the candidate evidence.

The repository's existing production surface rollback is dispatched from
PowerShell with:

```powershell
gh workflow run rollback-prod.yml --repo kortix-ai/suna --ref main `
  -f version=vX.Y.Z -f reason="<incident>" -f confirm="ROLLBACK PROD"
```

That workflow reuses released API, Gateway, and Frontend artifacts. It does not
reverse database migrations, drain OpenOPC executions, or restore OpenOPC
feature flags. Until the G10/B10 controls above exist and have been drilled,
this command is only one component of rollback and cannot make the public-beta
candidate releasable.
