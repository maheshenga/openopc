# OpenOPC Canonical Repository Identity Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the invalid `openopc/platform` production trust identity
with the exact canonical identity `maheshenga/openopc` across every current
public-beta Cosign builder and admission boundary.

**Architecture:** Keep repository identity fail-closed and literal at every
trust boundary. Migrate authentication, manifest/schema parsing, workflow
guards, attestation verification, and their independent fixtures in small
RED-GREEN cycles; do not add runtime configurability or a multi-repository
allowlist.

**Tech Stack:** TypeScript, Bun 1.3.14 test runner, JSON Schema, GitHub Actions
YAML, Biome, PowerShell.

## Global Constraints

- Canonical repository is exactly `maheshenga/openopc`.
- Protected ref is exactly `refs/heads/main`.
- Builder workflow is exactly `.github/workflows/openopc-cosign-builder.yml`.
- Certificate identity is exactly
  `https://github.com/maheshenga/openopc/.github/workflows/openopc-cosign-builder.yml@refs/heads/main`.
- Signer workflow is exactly
  `maheshenga/openopc/.github/workflows/openopc-cosign-builder.yml`.
- Legacy `openopc/platform` must fail closed in runtime and CLI behavior.
- Preserve all upstream source, image digest, action pins, release tag,
  artifacts, user dirty work, and the empty Git index.
- Do not create real trust outputs or perform any remote mutation.
- Do not stage or commit without a separate exact authorization.

---

### Task 1: Authenticate the Correct GitHub Repository

**Files:**
- Modify: `scripts/release/public-beta-github-actions.test.ts`
- Modify: `scripts/release/public-beta-github-actions.ts`

**Interfaces:**
- Produces: `PublicBetaAuthenticatedToolBuilderRun.repository` literal
  `maheshenga/openopc`.
- Produces: `authenticatePublicBetaToolBuilderRun()` accepts the canonical
  repository and rejects the legacy repository.

- [ ] **Step 1: Write the failing authentication expectation**

Change the independent test fixture to:

```ts
const REPOSITORY = 'maheshenga/openopc';
```

Change the case-normalization vector to
`Maheshenga/OpenOPC`/`MAHESHENGA/OPENOPC`, and add the legacy repository to the
existing rejected builder mutations:

```ts
['legacy repository', {
  repository: { full_name: 'openopc/platform', id: 711 },
  head_repository: { full_name: 'openopc/platform', id: 711 },
}],
```

- [ ] **Step 2: Verify RED**

Run:

```powershell
bun test scripts/release/public-beta-github-actions.test.ts
```

Expected: the canonical builder authentication test fails because production
still returns/requires `openopc/platform`.

- [ ] **Step 3: Implement the minimum authentication migration**

Replace the builder repository literal type and all builder request/snapshot
checks in `public-beta-github-actions.ts` with `maheshenga/openopc`. Preserve
the source/certifier caller-supplied exact repository contract and all other
metadata validation.

- [ ] **Step 4: Verify GREEN**

Run the same test file. Expected: all tests pass, including explicit rejection
of `openopc/platform`.

### Task 2: Migrate Toolchain and SLSA Schema Identity

**Files:**
- Modify: `scripts/release/public-beta-cosign-toolchain.test.ts`
- Modify: `scripts/release/public-beta-cosign-toolchain.ts`
- Modify: `tests/public-beta/cosign-toolchain.v1.fixture.json`
- Modify: `tests/public-beta/cosign-toolchain.v1.schema.json`
- Modify: `tests/public-beta/cosign-slsa-predicate.v1.fixture.json`
- Modify: `tests/public-beta/cosign-slsa-predicate.v1.schema.json`

**Interfaces:**
- Produces: `canonicalPublicBetaCosignBuilderIdentity()` returns the corrected
  certificate identity.
- Produces: `parsePublicBetaCosignToolchain()` accepts only the corrected
  repository and certificate identity.

- [ ] **Step 1: Write the failing canonical identity expectation**

Use hand-derived literals in the test:

```ts
expect(canonicalPublicBetaCosignBuilderIdentity()).toBe(
  'https://github.com/maheshenga/openopc/.github/workflows/openopc-cosign-builder.yml@refs/heads/main',
);
```

Update the schema-contract expectations to require repository
`maheshenga/openopc` and the same corrected certificate identity.

- [ ] **Step 2: Verify RED**

Run:

```powershell
bun test scripts/release/public-beta-cosign-toolchain.test.ts
```

Expected: canonical identity/schema agreement fails against the old source and
JSON files.

- [ ] **Step 3: Implement the minimum parser/schema migration**

Change only the repository and derived certificate identity literals in the
toolchain source, the two schemas, and the two fixtures. Add/retain a negative
parser vector proving a manifest with `openopc/platform` is rejected.

- [ ] **Step 4: Verify GREEN**

Run the same test file. Expected: all parser, closed-schema, fixture, and
predicate tests pass.

### Task 3: Migrate the Admission Verifier and CLI

**Files:**
- Modify: `scripts/release/public-beta-cosign-toolchain-admission.test.ts`
- Modify: `scripts/release/public-beta-cosign-toolchain-admission.ts`

**Interfaces:**
- Produces: CLI accepts only `--repository maheshenga/openopc`.
- Produces: production GitHub API paths and `gh attestation verify` arguments
  bind the corrected repository, certificate identity, and signer workflow.

- [ ] **Step 1: Write the failing CLI boundary expectation**

Change the successful CLI call and frozen dependency expectation to
`maheshenga/openopc`; add this existing-invalid vector:

```ts
['--run-id', '101', '--repository', 'openopc/platform', '--output-root', 'C:/out'],
```

Update independent manifest/verification fixtures to the corrected literal
identity.

- [ ] **Step 2: Verify RED**

Run:

```powershell
bun test scripts/release/public-beta-cosign-toolchain-admission.test.ts
```

Expected: the canonical success path fails with
`OPENOPC_COSIGN_ADMISSION_USAGE_INVALID` while production still accepts only
the legacy repository.

- [ ] **Step 3: Implement the minimum admission migration**

Replace the closed CLI value, authenticated-run snapshot value, verification
certificate identity, `--repo`, `--signer-workflow`, and all production
`repos/...` GitHub API paths with their `maheshenga/openopc` forms. Preserve
timeouts, output bounds, retained-handle verification, and publication logic.

- [ ] **Step 4: Verify GREEN**

Run the same admission test file. Expected: all tests pass and the legacy CLI
repository is rejected before any dependency side effect.

### Task 4: Migrate the Protected Workflow and Cross-Contract Fixtures

**Files:**
- Modify: `.github/workflows/openopc-cosign-builder.yml`
- Modify: `scripts/release/public-beta-workflow-contract.test.ts`
- Modify: `scripts/release/public-beta-artifacts.test.ts`
- Modify: `scripts/release/public-beta-evidence-v2.test.ts`
- Modify: `scripts/release/public-beta-release-manifest.test.ts`

**Interfaces:**
- Produces: every workflow job guard requires
  `github.repository == 'maheshenga/openopc'`.
- Produces: pre-promotion manifest builder identity matches Tasks 1-3.

- [ ] **Step 1: Write the failing workflow behavior expectation**

Set the independent guard literal to:

```ts
const GUARD = "github.repository == 'maheshenga/openopc' && github.ref == 'refs/heads/main' && github.workflow_sha == github.sha";
```

Update the top-level protected-repository assertion and cross-contract
fixtures to `maheshenga/openopc`.

- [ ] **Step 2: Verify RED**

Run:

```powershell
bun test scripts/release/public-beta-workflow-contract.test.ts scripts/release/public-beta-artifacts.test.ts scripts/release/public-beta-evidence-v2.test.ts scripts/release/public-beta-release-manifest.test.ts
```

Expected: workflow guard/manifest identity checks fail while YAML still embeds
`openopc/platform`.

- [ ] **Step 3: Implement the minimum workflow migration**

Change all six job guards, emitted builder repository/certificate identity,
and promotion-time revalidation literals. Preserve job graph, permissions,
environment, action pins, upstream inputs, release flow, and shell scripts.

- [ ] **Step 4: Verify GREEN**

Run the same four test files. Expected: all tests pass.

### Task 5: Full Local Gate and Review Package

**Files:**
- Verify: all 15 files listed in the design
- Update: `.superpowers/sdd/2026-07-31-openopc-canonical-repository-identity-migration/progress.md`

- [ ] **Step 1: Run the affected contract gate**

```powershell
bun test scripts/release/public-beta-github-actions.test.ts scripts/release/public-beta-cosign-toolchain.test.ts scripts/release/public-beta-cosign-toolchain-admission.test.ts scripts/release/public-beta-workflow-contract.test.ts scripts/release/public-beta-artifacts.test.ts scripts/release/public-beta-evidence-v2.test.ts scripts/release/public-beta-release-manifest.test.ts
```

- [ ] **Step 2: Run the prior Task 5 regression gate**

```powershell
bun test scripts/release/public-beta-native-filesystem-windows.test.ts scripts/release/public-beta-native-filesystem-linux.test.ts scripts/release/public-beta-cosign-toolchain-admission.test.ts scripts/release/public-beta-archive-directory-race.test.ts scripts/release/public-beta-archive.test.ts scripts/release/public-beta-archive-fd-limit.test.ts scripts/release/public-beta-archive-fd-ownership.test.ts scripts/release/public-beta-github-actions.test.ts scripts/release/public-beta-cosign-toolchain.test.ts scripts/release/public-beta-safe-files.test.ts
```

- [ ] **Step 3: Run static and boundary gates**

Run Biome over the changed TypeScript and JSON files; run `git diff --check`
over tracked paths; scan the 15 runtime/contract files and require zero
`openopc/platform` matches; require an empty Git index; require the three real
trust outputs (`toolchain.json`, `linux-amd64.jsonl`, `windows-amd64.jsonl`) to
remain absent.

- [ ] **Step 4: Independently review the exact unstaged migration**

Create a review package containing the pre-edit hashes, exact scoped diff,
test evidence, and authorization boundary. Review all identity propagation,
legacy rejection, and unrelated-change preservation. Fix every Critical or
Important finding with a scoped RED-GREEN cycle and re-review.

- [ ] **Step 5: Stop before staging or remote mutation**

Record final file hashes and present the replacement control-commit scope for
separate user authorization. Do not stage, commit, add a remote, push, change
GitHub settings, dispatch, or publish.
