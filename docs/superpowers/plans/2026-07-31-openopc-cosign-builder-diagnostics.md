# OpenOPC Cosign Builder Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the protected Cosign builder retain safe, stage-specific failure evidence so one authenticated run can identify the current module-fetch/build failure without weakening the SLSA trust chain.

**Architecture:** Preserve the existing fail-closed build-result API and add a detailed discriminated execution result for the CLI and tests. Run bounded DNS/TLS checks inside the existing pinned fetch container, emit one canonical redacted JSON failure on stderr, and retain it through a failure-only GitHub artifact that has no promotion edge.

**Tech Stack:** Bun 1.3.14, TypeScript, `bun:test`, GitHub Actions YAML, Docker, Go 1.26.0, pinned `actions/upload-artifact`.

## Global Constraints

- Canonical repository is exactly `maheshenga/openopc`; protected ref is exactly `refs/heads/main`.
- Upstream remains `sigstore/cosign` v3.1.2 at commit `193d2153431f8bb0d945a4c1ee721872f73add67` and tree `6647db468973d11edb5e737293fcf4b05c69a84a`.
- Build image remains `golang:1.26.0-bookworm@sha256:2a0ba12e116687098780d3ce700f9ce3cb340783779646aafbabed748fa6677c`.
- Fetch alone may use Docker `bridge`; build and inspect remain `network=none`.
- Preserve both `go mod verify` calls, `GOFLAGS=-mod=readonly`, and `GOTOOLCHAIN=local`.
- Success stdout remains one canonical build-result JSON document. Failure remains non-zero and emits one bounded canonical diagnostic JSON document on stderr.
- Never emit environment dumps, command arguments, credentials, authorization headers, OIDC material, or raw provider responses.
- Do not add retries, increase timeouts, widen network access, weaken tests, use a production server, publish a release, or claim beta readiness during diagnosis.
- Do not invite or grant access to a reviewer until the user explicitly authorizes that identity.
- Do not rerun the remote builder until this change is independently reviewed and merged.

## File Structure

- `scripts/release/public-beta-cosign-builder.ts`: stage classification, bounded diagnostics, fetch preflight, detailed execution, CLI rendering.
- `scripts/release/public-beta-cosign-builder.test.ts`: RED/GREEN coverage for failure evidence and the real CLI contract.
- `.github/workflows/openopc-cosign-builder.yml`: primary/replay diagnostic capture and failure-only upload.
- `scripts/release/public-beta-workflow-contract.test.ts`: static proof that diagnostics cannot weaken job failure, permissions, or artifact edges.

## Scope Boundary

This plan is the evidence-gathering phase required by systematic debugging. It ends with one authenticated run because the exact remediation cannot be specified honestly before that run exposes the failing boundary. If the run fails, immediately disable further dispatch while writing a separate RED-first remediation or permanent-closure plan from the retained evidence. That follow-up must implement the design's stable disabled-toolchain reason and protected-source removal of the promotion path; those changes are not guessed in this plan.

---

### Task 1: Typed Builder Diagnostics

**Files:**
- Modify: `scripts/release/public-beta-cosign-builder.test.ts`
- Modify: `scripts/release/public-beta-cosign-builder.ts`

**Interfaces:**
- Consumes: `PublicBetaBuilderCommand`, `PublicBetaBuilderProcessResult`, `PublicBetaCosignBuildPlan`, `PublicBetaCosignBuildResultV1`.
- Produces: `PublicBetaCosignBuildFailureV1`, `PublicBetaCosignBuildExecutionV1`, and `executePublicBetaCosignBuildPlanDetailed(plan, runner, now)`.
- Preserves: `executePublicBetaCosignBuildPlan(...): Promise<PublicBetaCosignBuildResultV1 | false>` as a compatibility wrapper.

- [ ] **Step 1: Write the failing process and output tests**

Add a test in `public-beta-cosign-builder.test.ts` that makes only `plan.fetch` fail:

```ts
const execution = await executePublicBetaCosignBuildPlanDetailed(
  plan,
  async (command) =>
    command === plan.fetch
      ? {
          exitCode: 1,
          timedOut: false,
          stdout: '',
          stderr: 'go: https://user:download-secret@proxy.invalid?token=query-secret failed',
        }
      : baseRunner(command),
  () => new Date('2026-07-30T10:00:00.000Z'),
);
expect(execution.ok).toBe(false);
if (execution.ok) throw new Error('TEST_COSIGN_FAILURE_EXPECTED');
expect(execution.failure).toMatchObject({
  schemaVersion: 1,
  code: 'OPENOPC_COSIGN_BUILD_PROCESS_FAILED',
  stage: 'module-fetch',
  operation: 'module-fetch',
  executable: 'docker',
  exitCode: 1,
  timedOut: false,
  outputLimited: false,
});
expect(execution.failure.stderrExcerpt).not.toContain('download-secret');
expect(execution.failure.stderrExcerpt).not.toContain('query-secret');
expect(Buffer.byteLength(JSON.stringify(execution.failure), 'utf8')).toBeLessThanOrEqual(8_192);
expect(Object.isFrozen(execution.failure)).toBe(true);
```

Add three independent cases:

- `plan.build` timeout maps to `offline-build` / `offline-build` and `OPENOPC_COSIGN_BUILD_PROCESS_FAILED`.
- output exceeding `command.maxOutputBytes` maps to `OPENOPC_COSIGN_BUILD_OUTPUT_LIMIT_EXCEEDED` with `outputLimited: true` and empty excerpts.
- successful `plan.fetch` returning `not-a-digest\n` maps to `OPENOPC_COSIGN_BUILD_OUTPUT_INVALID`.

- [ ] **Step 2: Write the failing fetch-preflight and black-box CLI tests**

Assert `plan.fetch.args.join(' ')` contains, in order before `go mod download`:

```ts
expect(fetch).toContain('timeout 10 getent hosts proxy.golang.org');
expect(fetch).toContain("curl --fail --silent --show-error --max-time 20 --proto '=https' https://proxy.golang.org/");
expect(fetch).toContain("curl --fail --silent --show-error --max-time 20 --proto '=https' https://sum.golang.org/supported");
expect(fetch.indexOf('timeout 10 getent hosts proxy.golang.org')).toBeLessThan(fetch.indexOf('go mod download'));
```

Add `mkdirSync` to the `node:fs` import. Spawn the real CLI with three fresh non-overlapping directories and `OPENOPC_COSIGN_PLATFORM=linuxAmd64`; leave the source directory as a non-Git directory. Assert exit code 1, empty stdout, one stderr line, and parsed fields:

```ts
expect(JSON.parse(stderr)).toMatchObject({
  schemaVersion: 1,
  code: 'OPENOPC_COSIGN_BUILD_PROCESS_FAILED',
  stage: 'source-verify',
  operation: 'source-commit',
  executable: 'git',
});
```

- [ ] **Step 3: Verify RED**

Run:

```powershell
bun test scripts/release/public-beta-cosign-builder.test.ts
```

Expected: FAIL because the detailed API and preflight do not exist and the CLI still emits `OPENOPC_COSIGN_BUILD_FAILED`.

- [ ] **Step 4: Add exact diagnostic types**

Add these contracts near the process-runner types:

```ts
export type PublicBetaCosignBuildStage =
  | 'source-verify'
  | 'module-fetch'
  | 'offline-build'
  | 'inspect';

export type PublicBetaCosignBuildOperation =
  | 'source-commit'
  | 'source-tree'
  | 'source-clean'
  | 'module-files-worktree'
  | 'module-files-index'
  | 'source-timestamp'
  | 'module-fetch'
  | 'offline-build'
  | 'inspect';

export type PublicBetaCosignBuildFailureCode =
  | 'OPENOPC_COSIGN_BUILD_PROCESS_FAILED'
  | 'OPENOPC_COSIGN_BUILD_OUTPUT_INVALID'
  | 'OPENOPC_COSIGN_BUILD_OUTPUT_LIMIT_EXCEEDED'
  | 'OPENOPC_COSIGN_BUILD_RUNNER_FAILED';

export interface PublicBetaCosignBuildFailureV1 {
  schemaVersion: 1;
  code: PublicBetaCosignBuildFailureCode;
  stage: PublicBetaCosignBuildStage;
  operation: PublicBetaCosignBuildOperation;
  executable: PublicBetaBuilderCommand['executable'];
  exitCode: number | null;
  timedOut: boolean;
  outputLimited: boolean;
  stdoutExcerpt: string;
  stderrExcerpt: string;
}

export type PublicBetaCosignBuildExecutionV1 =
  | Readonly<{ ok: true; value: Readonly<PublicBetaCosignBuildResultV1> }>
  | Readonly<{ ok: false; failure: Readonly<PublicBetaCosignBuildFailureV1> }>;
```

- [ ] **Step 5: Implement byte-bounded redaction and detailed execution**

Split one 4,096-byte UTF-8 budget between the two retained excerpts after applying the current URL, query-key, and bearer redaction. Also redact `Authorization:` lines and `gh*_` / `github_pat_` token shapes. Oversized combined process output must set `outputLimited: true` and retain neither stream.

Move the current execution body into `executePublicBetaCosignBuildPlanDetailed`. Map the six existing source commands to the six source operations by their exact argument patterns. Return frozen `{ ok: false, failure }` values for process failure, timeout, output limit, invalid semantic output, and runner exceptions. Preserve every current commit/tree/clean/module/timestamp/digest/inspection check.

Keep the old function as:

```ts
const execution = await executePublicBetaCosignBuildPlanDetailed(plan, runner, now);
return execution.ok ? execution.value : false;
```

`executePublicBetaCosignBuildPlanDetailed` accepts only plans returned by `createPublicBetaCosignBuildPlan`. If plan metadata, `runner`, or `now` is invalid, throw `OPENOPC_COSIGN_BUILD_INPUT_INVALID`; the compatibility wrapper catches that condition and returns `false`, preserving its existing misuse behavior.

- [ ] **Step 6: Add the fetch preflight inside the pinned container**

Insert after `umask 022` and before the first `go mod verify`:

```ts
'printf "OPENOPC_COSIGN_GO_VERSION=%s\\n" "$(go version)" >&2',
'printf "OPENOPC_COSIGN_GOPROXY=%s\\n" "$(go env GOPROXY)" >&2',
'printf "OPENOPC_COSIGN_GOSUMDB=%s\\n" "$(go env GOSUMDB)" >&2',
'timeout 10 getent hosts proxy.golang.org >/dev/null || { echo OPENOPC_COSIGN_MODULE_DNS_FAILED >&2; exit 72; }',
"curl --fail --silent --show-error --max-time 20 --proto '=https' https://proxy.golang.org/ >/dev/null || { echo OPENOPC_COSIGN_MODULE_PROXY_TLS_FAILED >&2; exit 73; }",
"curl --fail --silent --show-error --max-time 20 --proto '=https' https://sum.golang.org/supported >/dev/null || { echo OPENOPC_COSIGN_SUMDB_TLS_FAILED >&2; exit 74; }",
```

Do not pass host proxy variables or credentials into Docker. Leave `bridge`/`none`, the image digest, and timeouts unchanged.

- [ ] **Step 7: Emit canonical failure JSON from the CLI**

Use the detailed result in the `build` branch:

```ts
const execution = await executePublicBetaCosignBuildPlanDetailed(plan, defaultProcessRunner);
if (!execution.ok) {
  console.error(canonicalPublicBetaJson(execution.failure));
  return 1;
}
console.log(canonicalPublicBetaJson(execution.value));
return 0;
```

Keep the top-level catch for argument, lock, input-file, predicate, and comparison failures.

- [ ] **Step 8: Verify GREEN and commit**

```powershell
bun test scripts/release/public-beta-cosign-builder.test.ts
pnpm.cmd exec biome check --formatter-enabled=false scripts/release/public-beta-cosign-builder.ts scripts/release/public-beta-cosign-builder.test.ts
git diff --check -- scripts/release/public-beta-cosign-builder.ts scripts/release/public-beta-cosign-builder.test.ts
git add -- scripts/release/public-beta-cosign-builder.ts scripts/release/public-beta-cosign-builder.test.ts
git commit -m "fix(release): expose cosign builder diagnostics"
```

Expected: tests and Biome pass; diff check is silent.

---

### Task 2: Failure-Only Workflow Artifacts

**Files:**
- Modify: `scripts/release/public-beta-workflow-contract.test.ts`
- Modify: `.github/workflows/openopc-cosign-builder.yml`

**Interfaces:**
- Consumes: the one-line CLI stderr contract from Task 1 and the existing pinned upload action.
- Produces: `upload-diagnostics` steps in `primary` and `replay`, with no job output or downstream consumer.
- Preserves: existing successful `upload` step IDs and exact artifact-ID chain.

- [ ] **Step 1: Write the failing workflow test**

Add `if?: string` to `WorkflowStep`. For both `primary` and `replay`, assert:

```ts
const diagnostic = step(job, 'upload-diagnostics');
expect(step(job, 'build').run).toContain(`_${name}/diagnostics/linux-amd64.json`);
expect(step(job, 'build').run).toContain(`_${name}/diagnostics/windows-amd64.json`);
expect(step(job, 'build').run).toContain('cat "$diagnostic" >&2');
expect(diagnostic.uses).toBe(UPLOAD);
expect(diagnostic.if).toBe("failure() && steps.build.outcome == 'failure'");
expect(diagnostic.with).toMatchObject({
  path: `_${name}/diagnostics`,
  'if-no-files-found': 'error',
  overwrite: false,
  'retention-days': 7,
});
expect(job.outputs).toEqual({ 'artifact-id': '${{ steps.upload.outputs.artifact-id }}' });
expect(job.outputs).not.toHaveProperty('diagnostic-artifact-id');
```

Retain the existing assertions forbidding `continue-on-error`, secrets, unpinned actions, and alternate job edges.

- [ ] **Step 2: Verify RED**

```powershell
bun test scripts/release/public-beta-workflow-contract.test.ts
```

Expected: FAIL because neither diagnostic step exists.

- [ ] **Step 3: Capture diagnostics around each builder invocation**

Create `_primary/diagnostics` and `_replay/diagnostics`. Wrap each Linux/Windows builder command with this pattern:

```bash
diagnostic='_primary/diagnostics/linux-amd64.json'
if ! OPENOPC_COSIGN_PLATFORM=linuxAmd64 bun scripts/release/public-beta-cosign-builder.ts build _upstream _primary-module-cache _primary/linux > _primary/linux-build.json 2> "$diagnostic"; then
  cat "$diagnostic" >&2
  exit 1
fi
rm -f -- "$diagnostic"
mv _primary/linux/cosign-linux-amd64 _primary/cosign-linux-amd64
```

Use the correct Windows platform/output names, then repeat under `_replay`. A failed invocation retains and logs its diagnostic; success removes the empty diagnostic file.

- [ ] **Step 4: Add failure-only uploads**

After each build step and before its existing success upload, add the pinned upload action with:

```yaml
      - id: upload-diagnostics
        if: failure() && steps.build.outcome == 'failure'
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a
        with:
          name: openopc-cosign-primary-diagnostics-${{ github.run_id }}-${{ github.run_attempt }}
          path: _primary/diagnostics
          if-no-files-found: error
          overwrite: false
          retention-days: 7
```

Use `replay` names and paths in replay. Do not expose the diagnostic artifact ID through job outputs or `needs`.

- [ ] **Step 5: Verify GREEN and commit**

```powershell
bun test scripts/release/public-beta-workflow-contract.test.ts scripts/release/public-beta-cosign-builder.test.ts
pnpm.cmd exec biome check --formatter-enabled=false .github/workflows/openopc-cosign-builder.yml scripts/release/public-beta-workflow-contract.test.ts scripts/release/public-beta-cosign-builder.ts scripts/release/public-beta-cosign-builder.test.ts
git diff --check -- .github/workflows/openopc-cosign-builder.yml scripts/release/public-beta-workflow-contract.test.ts
git add -- .github/workflows/openopc-cosign-builder.yml scripts/release/public-beta-workflow-contract.test.ts
git commit -m "ci(release): retain cosign builder failure evidence"
```

Expected: focused tests and Biome pass; both build jobs still fail when the builder fails.

---

### Task 3: Full Verification and Review Package

**Files:**
- Verify only; no production-file changes expected.

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces: a clean, locally verified branch; no workflow dispatch or release.

- [ ] **Step 1: Run the complete release trust regression set**

```powershell
bun test scripts/release/public-beta-github-actions.test.ts scripts/release/public-beta-cosign-toolchain.test.ts scripts/release/public-beta-cosign-builder.test.ts scripts/release/public-beta-cosign-toolchain-admission.test.ts scripts/release/public-beta-workflow-contract.test.ts scripts/release/public-beta-cosign.test.ts scripts/release/public-beta-cosign-windows-launcher.test.ts scripts/release/public-beta-sigstore-policy.test.ts scripts/release/public-beta-canonical-json.test.ts scripts/release/public-beta-safe-files.test.ts scripts/release/public-beta-safe-files-open-guard.test.ts
```

Expected: all tests pass with no weakened or skipped security assertion.

- [ ] **Step 2: Run final static checks**

```powershell
pnpm.cmd exec biome check --formatter-enabled=false .github/workflows/openopc-cosign-builder.yml scripts/release/public-beta-cosign-builder.ts scripts/release/public-beta-cosign-builder.test.ts scripts/release/public-beta-workflow-contract.test.ts
git diff --check openopc/main...HEAD
git status --short --branch
```

Expected: Biome exits 0, diff check is silent, and the worktree is clean.

- [ ] **Step 3: Review the scoped history**

```powershell
git diff --stat openopc/main...HEAD
git log --oneline openopc/main..HEAD
```

Confirm the branch contains only the approved design, plan, builder/test, and workflow-contract changes. Obtain independent security review before merge or completion claims.

---

### Task 4: Protected Merge and One Diagnostic Run

**Files:**
- External GitHub state only; no local file changes expected.

**Interfaces:**
- Consumes: clean reviewed branch, required checks, and an explicitly authorized independent reviewer.
- Produces: exactly one authenticated builder run and either full success evidence or failure-only diagnostic artifacts.

- [ ] **Step 1: Confirm reviewer authorization**

Ask whether `markokraemer` is the intended reviewer. If authorized, grant only the minimum permission needed to read and approve, retain `prevent_self_review=true`, and replace the self-only `toolchain-release` reviewer. If not authorized, do not weaken protection; move to the closure decision.

After explicit authorization, resolve the immutable user ID and apply the minimum access/environment policy:

```powershell
gh api --method PUT repos/maheshenga/openopc/collaborators/markokraemer -f permission=pull
$reviewerId = gh api users/markokraemer --jq '.id'
$environmentPolicy = @{
  wait_timer = 0
  prevent_self_review = $true
  reviewers = @(@{ type = 'User'; id = [int64]$reviewerId })
  deployment_branch_policy = @{ protected_branches = $true; custom_branch_policies = $false }
} | ConvertTo-Json -Depth 5 -Compress
$environmentPolicy | gh api --method PUT repos/maheshenga/openopc/environments/toolchain-release --input -
```

Verify the invitation has been accepted before treating `markokraemer` as a reviewer; a pending invitation is not approval capability.

- [ ] **Step 2: Push, open the PR, and wait for protected checks**

Push `fix/cosign-builder-diagnostics` to `openopc`, then create the PR with the required evidence:

```powershell
git push openopc fix/cosign-builder-diagnostics
gh pr create --repo maheshenga/openopc --base main --head fix/cosign-builder-diagnostics --title "fix(release): diagnose protected Cosign builds" --body "Adds bounded stage-specific diagnostics for failed runs 30631289435 and 30634254315.`n`nPreserves the pinned image/source, module verification, fetch-only bridge network, offline build/inspect, replay comparison, SLSA identity, and protected promotion. No workflow was rerun before review.`n`nVerification commands and exact results are recorded in the task handoff."
$prNumber = gh pr view fix/cosign-builder-diagnostics --repo maheshenga/openopc --json number --jq '.number'
gh pr checks $prNumber --repo maheshenga/openopc --watch
gh pr view $prNumber --repo maheshenga/openopc --json reviewDecision,statusCheckRollup,mergeStateStatus,headRefOid
```

Require:

- `CI / Detect changes`;
- `Package Unit Tests / every change ships with tests`;
- one non-author and last-push approval;
- zero unresolved conversations;
- no admin bypass.

- [ ] **Step 3: Merge linearly and capture the exact main SHA**

Use squash merge, then query `repos/maheshenga/openopc/commits/main` and record the returned 40-character SHA as `controlSha`. Verify the merged diff matches the reviewed PR.

```powershell
gh pr merge $prNumber --repo maheshenga/openopc --squash --delete-branch
$controlSha = gh api repos/maheshenga/openopc/commits/main --jq '.sha'
gh pr view $prNumber --repo maheshenga/openopc --json mergeCommit,mergedAt,state
```

- [ ] **Step 4: Dispatch exactly one run**

```powershell
gh workflow run openopc-cosign-builder.yml --repo maheshenga/openopc --ref main
gh run list --repo maheshenga/openopc --workflow openopc-cosign-builder.yml --branch main --event workflow_dispatch --limit 1 --json databaseId,headSha,status,conclusion,url
```

Require `headSha == controlSha`. Do not dispatch a second unchanged run after failure.

- [ ] **Step 5: Classify success or download exact diagnostics**

Success requires primary/replay byte equality, two SLSA attestations, Linux and Windows smoke, protected promotion approval, immutable release assets, and a cross-bound final manifest.

On failure, download the exact primary/replay diagnostic artifacts for that run ID and attempt. Parse their canonical JSON and compare stage, operation, exit code, timeout, output-limit flag, and redacted excerpts. Form one root-cause hypothesis and write a new RED-first remediation plan; do not rerun unchanged.

```powershell
$runId = gh run list --repo maheshenga/openopc --workflow openopc-cosign-builder.yml --branch main --event workflow_dispatch --limit 1 --json databaseId --jq '.[0].databaseId'
$diagnosticRoot = Join-Path $env:TEMP "openopc-cosign-diagnostic-$runId"
New-Item -ItemType Directory -Path $diagnosticRoot | Out-Null
gh run download $runId --repo maheshenga/openopc --name "openopc-cosign-primary-diagnostics-$runId-1" --dir (Join-Path $diagnosticRoot 'primary')
gh run download $runId --repo maheshenga/openopc --name "openopc-cosign-replay-diagnostics-$runId-1" --dir (Join-Path $diagnosticRoot 'replay')
Get-ChildItem -LiteralPath $diagnosticRoot -Recurse -Filter *.json | ForEach-Object { Get-Content -Raw -LiteralPath $_.FullName | ConvertFrom-Json }
```

- [ ] **Step 6: Apply the closure fallback if safe recovery is unavailable**

If no bounded remediation exists, or the subsequent independently reviewed remediation run fails:

```powershell
gh workflow disable openopc-cosign-builder.yml --repo maheshenga/openopc
gh workflow view openopc-cosign-builder.yml --repo maheshenga/openopc --yaml
```

Do not delete historical runs, artifacts, environments, or protection rules. Keep Cosign-dependent module publication closed and restricted public beta `not_ready`; remove code or promotion definitions only through a separate reviewed closure change.
