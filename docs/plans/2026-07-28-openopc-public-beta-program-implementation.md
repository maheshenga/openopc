# OpenOPC Public-Beta Program Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Coordinate the five independently testable OpenOPC workstreams into one commit-bound, human-approved public-beta release without weakening Kortix compatibility.

**Architecture:** The program layer does not duplicate application logic. It defines a typed stage manifest, consumes the public-beta evidence v2 validator, assembles one release-candidate manifest, and fails closed until every stage, artifact, policy, regional prerequisite, rollback target, and `G1-G12`/`B1-B10` record is current for the same commit.

**Tech Stack:** TypeScript, Bun test, JSON Schema 2020-12, GitHub Actions, SHA-256, existing pnpm workspace tooling.

## Global Constraints

- Work in `E:\code\agentk\suna-studio-platform` on branch `studio-platform`.
- The approved source contract is `docs/specs/2026-07-28-openopc-public-beta-baota-design.md`.
- Preserve all existing Kortix projects, sessions, Agents, multi-Agent collaboration, connectors, skills, files, sandboxes, automations, IAM, billing identities, SDK transport, CLI behavior, and Desktop login flows.
- Keep `@kortix/*`, the `kortix` database schema, `KORTIX_*`, `kortix.yaml`, `.kortix`, `KortixDesktop`, `kortix://`, and existing Kortix `/v1` contracts compatible.
- Do not restore the cancelled first-party video, voice, professional 3D, digital-human, or batch-remix pages.
- Android and iOS native acceptance and all real-money movement remain out of scope.
- Do not use `git reset`, `git checkout`, `git restore`, `git stash`, or `git clean`.
- Do not modify `docs/plans/2026-07-21-openopc-milestone-a-implementation-plan.md`, `docs/specs/2026-07-21-openopc-frontier-ai-technology-selection.md`, or `tests/module-beta/evidence.json`.
- Preserve the current uncommitted Module Runner Task 8 work. Do not edit its overlapping runtime files until the user authorizes and completes a dedicated checkpoint commit.
- Use `pnpm.cmd` in PowerShell, invoke `bun` directly, and use `cargo +1.97.1` for Runner work.
- Run fixed risk-based lanes, not the full monorepo test suite.
- Every commit step below is a proposed boundary. Do not execute a commit until the user explicitly authorizes commits for the implementation session.
- Default-off runtime and commercial flags remain disabled until their complete stage and corresponding gates pass.
- Public-beta status remains `not_ready` until every current gate is valid and an authorized human approval is verified.

---

## Existing Implemented Prerequisite

`docs/plans/2026-07-28-module-runner-execution-bundle-dispatch-implementation.md` is the completed Task 8 execution-bundle/dispatch prerequisite. Its 59/59 steps and focused real PostgreSQL/API/two-Runner gates are already implemented in the current uncommitted worktree. Do not rewrite or fold those changes into this program. Before any overlapping runtime task, rerun its listed gates and preserve it in a dedicated user-authorized checkpoint commit; until then, treat every overlapping file as read-only.

## Dependency Order

1. `2026-07-28-openopc-public-beta-evidence-operations-implementation.md` Tasks 1-2 establish evidence v2 and the compatibility inventory.
2. `2026-07-28-openopc-public-beta-foundation-surfaces-implementation.md` completes registration, Admin, Web/Desktop boundaries, branding, and developer admission.
3. `2026-07-28-openopc-module-app-cli-lifecycle-implementation.md` completes the Module Bridge, Module App host, public tooling, consent, and lifecycle.
4. `2026-07-28-openopc-module-sandbox-ledger-implementation.md` completes durable sandbox commerce and statements.
5. `2026-07-28-openopc-oci-runner-two-node-implementation.md` completes independent OCI execution and the two-node service boundary.
6. `2026-07-28-openopc-public-beta-evidence-operations-implementation.md` completes staging, observability, recovery, all Gate lanes, and release evidence.
7. This plan assembles and verifies the release candidate; a human then approves or rejects it.

## File Map

- `scripts/release/public-beta-program.ts`: canonical stage and Gate ownership registry.
- `scripts/release/public-beta-program.test.ts`: exact coverage and dependency-order tests.
- `scripts/release/public-beta-release-manifest.ts`: strict release-candidate parser and readiness decision.
- `scripts/release/public-beta-release-manifest.test.ts`: stale, mixed-commit, missing-artifact, rollback, policy, regional, and approval tests.
- `tests/public-beta/release-candidate.fixture.json`: deterministic negative/default fixture; it is never staging evidence.
- `tests/public-beta/release-candidate.schema.json`: machine-readable release-candidate contract.
- `package.json`: focused validation scripts only.
- `.github/workflows/openopc-public-beta-approval.yml`: protected-environment human approval lane.
- `docs/runbooks/openopc-public-beta-release.md`: exact operator sequence and rollback decision points.

### Task 1: Encode the program stages and Gate ownership

**Files:**
- Create: `scripts/release/public-beta-program.ts`
- Create: `scripts/release/public-beta-program.test.ts`

**Interfaces:**
- Consumes: `PublicBetaGateId` from `scripts/release/public-beta-evidence-v2.ts` after the evidence plan's Task 1.
- Produces: `PublicBetaStageId`, `PUBLIC_BETA_STAGES`, and `validatePublicBetaProgram()`.
- Invariant: every `G1` through `G12` and `B1` through `B10` has exactly one owning stage and one canonical lane.

- [ ] **Step 1: Write the failing coverage test**

```ts
import { describe, expect, test } from 'bun:test';
import { PUBLIC_BETA_STAGES, validatePublicBetaProgram } from './public-beta-program';

describe('public beta program', () => {
  test('owns every required gate exactly once in dependency order', () => {
    expect(validatePublicBetaProgram(PUBLIC_BETA_STAGES)).toEqual({ valid: true });
    expect(PUBLIC_BETA_STAGES.flatMap((stage) => stage.gates).sort()).toEqual([
      'B1','B10','B2','B3','B4','B5','B6','B7','B8','B9',
      'G1','G10','G11','G12','G2','G3','G4','G5','G6','G7','G8','G9',
    ]);
  });
});
```

- [ ] **Step 2: Run RED**

Run: `bun test scripts/release/public-beta-program.test.ts`

Expected: FAIL because `public-beta-program.ts` does not exist.

- [ ] **Step 3: Implement the typed registry and exact dependency validation**

```ts
import type { PublicBetaGateId } from './public-beta-evidence-v2';

export type PublicBetaStageId =
  | 'evidence-foundation'
  | 'foundation-surfaces'
  | 'module-app-cli-lifecycle'
  | 'module-sandbox-ledger'
  | 'oci-runner-two-node'
  | 'evidence-closure';

export interface PublicBetaStage {
  id: PublicBetaStageId;
  plan: `docs/plans/${string}.md`;
  dependsOn: readonly PublicBetaStageId[];
  gates: readonly PublicBetaGateId[];
}

export function validatePublicBetaProgram(stages: readonly PublicBetaStage[]): { valid: true } {
  const positions = new Map(stages.map((stage, index) => [stage.id, index]));
  const gates = stages.flatMap((stage) => stage.gates);
  const expected = [
    ...Array.from({ length: 12 }, (_, index) => `G${index + 1}`),
    ...Array.from({ length: 10 }, (_, index) => `B${index + 1}`),
  ];
  if (new Set(gates).size !== gates.length || expected.some((gate) => !gates.includes(gate as PublicBetaGateId))) {
    throw new Error('PUBLIC_BETA_GATE_OWNERSHIP_INVALID');
  }
  for (const stage of stages) {
    const index = positions.get(stage.id);
    if (index === undefined || stage.dependsOn.some((id) => (positions.get(id) ?? index) >= index)) {
      throw new Error('PUBLIC_BETA_STAGE_ORDER_INVALID');
    }
  }
  return { valid: true };
}
```

Populate `PUBLIC_BETA_STAGES` with this exact ownership and dependency order:

```ts
[
  { id:'evidence-foundation', dependsOn:[], gates:[] },
  { id:'foundation-surfaces', dependsOn:['evidence-foundation'], gates:['B1','B2','B3','G11','B9'] },
  { id:'module-app-cli-lifecycle', dependsOn:['foundation-surfaces'], gates:['G7','G8','G10','B4'] },
  { id:'module-sandbox-ledger', dependsOn:['module-app-cli-lifecycle'], gates:['G9','B6'] },
  { id:'oci-runner-two-node', dependsOn:['module-sandbox-ledger'], gates:['G6','B5'] },
  { id:'evidence-closure', dependsOn:['foundation-surfaces','module-app-cli-lifecycle','module-sandbox-ledger','oci-runner-two-node'], gates:['G1','G2','G3','G4','G5','G12','B7','B8','B10'] },
]
```

Both evidence stages reference the evidence/operations plan; the first establishes contracts and the last owns the cross-cutting real Gate closure.

- [ ] **Step 4: Run GREEN**

Run: `bun test scripts/release/public-beta-program.test.ts`

Expected: PASS with one program coverage test.

- [ ] **Step 5: Commit boundary**

```powershell
git add scripts/release/public-beta-program.ts scripts/release/public-beta-program.test.ts
git commit -m "test(release): encode public beta program ownership"
```

### Task 2: Define the strict release-candidate manifest

**Files:**
- Create: `tests/public-beta/release-candidate.schema.json`
- Create: `tests/public-beta/release-candidate.fixture.json`
- Create: `scripts/release/public-beta-release-manifest.ts`
- Create: `scripts/release/public-beta-release-manifest.test.ts`

**Interfaces:**
- Consumes: `PublicBetaGateId` and `validatePublicBetaEvidenceLedgerV2()` from the evidence plan.
- Produces: `PublicBetaReleaseManifestV1`, `parsePublicBetaReleaseManifest()`, and `evaluatePublicBetaReadiness()`.

```ts
export interface PublicBetaReleaseManifestV1 {
  schemaVersion: 1;
  candidateId: string;
  commit: string;
  environment: 'openopc-public-beta-staging';
  artifacts: Array<{ name: string; digest: `sha256:${string}`; imageOrPath: string }>;
  evidencePath: string;
  evidenceDigest: `sha256:${string}`;
  rollbackTarget: { commit: string; manifestDigest: `sha256:${string}` };
  policyVersions: { terms: string; privacy: string; acceptableUse: string; moduleRules: string };
  regionalEvidence: Array<{ id: string; status: 'satisfied'|'not_applicable'; artifactDigest: `sha256:${string}` }>;
  approval: null | { environment: 'production'; actor: string; approvedAt: string; manifestDigest: `sha256:${string}` };
}
```

- [ ] **Step 1: Write failing parser and readiness tests**

Test exact-key rejection, non-SHA artifact rejection, mixed commits, missing Web/Admin/API/WASI Runner/OCI Runner/Desktop/worker artifacts, absent policies, empty regional evidence, evidence digest mismatch, no rollback target, and approval whose `manifestDigest` does not bind the canonical pre-approval manifest.

```ts
test('remains not ready before a matching human approval', () => {
  const manifest = parsePublicBetaReleaseManifest(fixture);
  expect(evaluatePublicBetaReadiness(manifest, validEvidence, NOW)).toEqual({
    status: 'not_ready', reasons: ['PUBLIC_BETA_HUMAN_APPROVAL_REQUIRED'],
  });
});
```

- [ ] **Step 2: Run RED**

Run: `bun test scripts/release/public-beta-release-manifest.test.ts`

Expected: FAIL because the parser is absent.

- [ ] **Step 3: Implement canonical parsing and readiness**

Use the same exact-key, bounded-string, RFC3339, and SHA-256 patterns as `scripts/release/module-beta-targets.ts`, but do not accept `not-run`, nullable commit metadata, unknown artifacts, or another environment. Recompute `evidenceDigest` from raw ledger bytes and the approval binding digest from canonical JSON with the `approval` field set to `null`.

- [ ] **Step 4: Run GREEN**

Run: `bun test scripts/release/public-beta-release-manifest.test.ts scripts/release/public-beta-program.test.ts`

Expected: PASS for all program and manifest tests.

- [ ] **Step 5: Commit boundary**

```powershell
git add tests/public-beta/release-candidate.schema.json tests/public-beta/release-candidate.fixture.json scripts/release/public-beta-release-manifest.ts scripts/release/public-beta-release-manifest.test.ts
git commit -m "feat(release): add strict public beta candidate manifest"
```

### Task 3: Add one focused program validation command

**Files:**
- Modify: `package.json`
- Modify: `scripts/release/public-beta-release-manifest.ts`

**Interfaces:**
- Produces CLI: `pnpm.cmd public-beta:validate --manifest <path> --evidence <path> --now <RFC3339>`.
- Exit codes: `0=ready`, `2=valid but not ready`, `64=usage`, `65=invalid input`.

- [ ] **Step 1: Add a failing black-box test**

Add to `scripts/release/public-beta-release-manifest.test.ts` a spawned-process test that asserts the fixture exits `2` and emits one JSON object with `status: "not_ready"`.

- [ ] **Step 2: Run RED**

Run: `bun test scripts/release/public-beta-release-manifest.test.ts`

Expected: FAIL because the executable entry point and package script are absent.

- [ ] **Step 3: Implement deterministic CLI output**

```json
"public-beta:validate": "bun scripts/release/public-beta-release-manifest.ts"
```

The CLI must write human diagnostics to stderr, one JSON result to stdout, and never read the current Git state implicitly; commit and time are explicit manifest/argument inputs.

- [ ] **Step 4: Run GREEN**

Run: `pnpm.cmd public-beta:validate --manifest tests/public-beta/release-candidate.fixture.json --evidence tests/public-beta/evidence.fixture.json --now 2026-07-28T00:00:00Z`

Expected: exit `2` and JSON `{"status":"not_ready",...}` because fixture evidence is not real staging evidence and approval is absent.

- [ ] **Step 5: Commit boundary**

```powershell
git add package.json scripts/release/public-beta-release-manifest.ts scripts/release/public-beta-release-manifest.test.ts
git commit -m "chore(release): expose public beta readiness validator"
```

### Task 4: Protect the human production approval

**Files:**
- Create: `.github/workflows/openopc-public-beta-approval.yml`
- Create: `docs/runbooks/openopc-public-beta-release.md`
- Modify: `scripts/release/public-beta-release-manifest.test.ts`

**Interfaces:**
- Consumes a candidate and evidence artifact produced for the exact workflow commit.
- Produces an approval attestation artifact; it does not deploy or mutate production by itself.

- [ ] **Step 1: Write the failing workflow contract test**

Parse the workflow as YAML and assert `workflow_dispatch`, `environment: production`, read-only default permissions, artifact download by run ID, SHA-256 verification, `pnpm.cmd public-beta:validate`, and an approval attestation upload. Assert no `pull_request_target`, no unpinned third-party action, and no production secret printed to output.

- [ ] **Step 2: Run RED**

Run: `bun test scripts/release/public-beta-release-manifest.test.ts`

Expected: FAIL because the protected approval workflow does not exist.

- [ ] **Step 3: Implement the protected approval lane and runbook**

The workflow must require the repository `production` environment, accept `candidate_run_id` and `expected_commit`, download the immutable staging bundle, verify all artifact digests, run readiness validation with approval temporarily null, create a canonical approval attestation from GitHub actor/run/environment metadata, then rerun validation. The runbook must list preflight, backup state, migration result, staged Gate failures, rollback target, regional evidence, approval, rollout, smoke, and rollback decision commands.

- [ ] **Step 4: Run GREEN**

Run: `bun test scripts/release/public-beta-release-manifest.test.ts`

Expected: PASS for workflow permission and attestation-binding tests.

- [ ] **Step 5: Commit boundary**

```powershell
git add .github/workflows/openopc-public-beta-approval.yml docs/runbooks/openopc-public-beta-release.md scripts/release/public-beta-release-manifest.test.ts
git commit -m "ci(release): require protected public beta approval"
```

### Task 5: Execute the cross-plan closure without hiding failures

**Files:**
- Modify only when a real failure proves a defect in the owning plan's files.
- Record evidence only through the v2 evidence tooling from the evidence plan.

**Interfaces:**
- Consumes all five child-plan focused gates and all canonical staging lanes.
- Produces one release-candidate bundle for the same commit.

- [ ] **Step 1: Verify the Task 8 checkpoint before overlap**

Run:

```powershell
git status --short
git diff --check
```

Expected: Task 8 changes are either present and untouched or preserved in a user-authorized dedicated commit. If still dirty, do not edit `apps/api/src/module-runtime/executions*`, `runner-protocol*`, `apps/module-runner/src/client.rs`, `apps/module-runner/src/dispatcher.rs`, or the two database integration tests.

- [ ] **Step 2: Execute each child plan in dependency order**

Use the exact RED/GREEN commands and review checkpoints in each named plan. Preserve the first failure from every real lane. A rerun may demonstrate the fix but may not replace the failed artifact.

- [ ] **Step 3: Run the focused local program gate**

```powershell
bun test scripts/release/public-beta-program.test.ts scripts/release/public-beta-release-manifest.test.ts scripts/release/public-beta-evidence-v2.test.ts
pnpm.cmd migrate:lint
pnpm.cmd --filter @kortix/db typecheck
pnpm.cmd --filter kortix-api typecheck
pnpm.cmd --filter Kortix-Computer-Frontend typecheck
pnpm.cmd --filter @kortix/sdk typecheck
```

Expected: every command exits `0`; this is still not staging acceptance.

- [ ] **Step 4: Run every canonical staging lane once for the candidate commit**

Dispatch `public-beta-g1-migration` through `public-beta-g12-upstream-compatibility` and `public-beta-b1-registration` through `public-beta-b10-two-node-deployment`. Any fail or blocked result leaves the candidate `not_ready`; diagnose it in the owning plan rather than rerunning until green.

- [ ] **Step 5: Assemble and validate the candidate**

Run:

```powershell
pnpm.cmd public-beta:validate --manifest artifacts/public-beta/release-candidate.json --evidence artifacts/public-beta/evidence.v2.json --now <current-RFC3339>
```

Expected before approval: exit `2`, with the only remaining reason `PUBLIC_BETA_HUMAN_APPROVAL_REQUIRED`. Any other reason returns work to the owning stage.

- [ ] **Step 6: Request human approval and revalidate**

Dispatch `.github/workflows/openopc-public-beta-approval.yml` for the exact candidate run. After the protected environment approver acts, validation must exit `0` with `status: "ready"`. A rejection or missing regional prerequisite keeps public registration disabled.

- [ ] **Step 7: Close the execution checkpoint without a repository commit**

Real evidence, external prerequisite documents, and the approval attestation remain retained CI/release artifacts under their digests; they are not committed to the source repository. Record the approved release manifest URL and digest in the deployment system, then verify `git status --short` contains no evidence bundle or secret file added by this task.

## Program Completion Gate

The program is complete only when:

- all five child plans have their own focused and integration gates;
- all required artifacts are independently deployable and bind the same commit;
- every `G1-G12` and `B1-B10` record is current, raw, digest-bound, and from `openopc-public-beta-staging`;
- the real restore satisfies `RPO <= 15 minutes` and `RTO <= 4 hours`;
- the v2 validator returns ready for the human-approved candidate;
- `git diff --check` passes and the protected-file audit shows no unauthorized edits.

Until then, the product status is **not ready for public beta**.
