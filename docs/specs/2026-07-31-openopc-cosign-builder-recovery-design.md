# OpenOPC Cosign Builder Recovery Design

> This document amends the approved Cosign GitHub Actions builder design. It
> covers the failed live builder runs and the fail-closed fallback if recovery
> cannot be demonstrated. It does not change the approved GitHub Actions
> identity, SLSA predicate, digest, or offline-build trust model.

- **Date:** 2026-07-31
- **Status:** Approved for diagnostic implementation; independent reviewer access pending
- **Scope:** Recover or disable `openopc-cosign-v3.1.2.1` builder promotion
- **Canonical repository:** `maheshenga/openopc`

## 1. Evidence and Problem Statement

The protected workflow runs `30631289435` and `30634254315` both authenticated
the exact repository and upstream commit, then failed in both `primary` and
`replay` before artifact upload, comparison, attestation, smoke, or promotion.
The only emitted error was `OPENOPC_COSIGN_BUILD_FAILED`.

The current executor accepts only an exit code of zero and returns `false` for
every other outcome. The CLI then replaces the stage, exit code, timeout, and
subprocess output with one generic error. The available evidence points at the
module-fetch/build boundary, but does not yet prove whether the cause is DNS,
TLS, proxy/module-source access, a module verification failure, a container
resource limit, or a Go build error.

The public beta remains `not_ready`. No binary, release, tag, attestation, or
deployment may be inferred from these failed runs.

## 2. Goals and Non-Goals

Goals:

1. Produce bounded, redacted, stage-specific evidence from one diagnostic run.
2. Fix the confirmed cause with the smallest change that preserves the current
   source, image, digest, module verification, and network-boundary contracts.
3. Make a successful primary/replay run auditable from the existing SLSA
   identity through the retained release assets.
4. Disable the builder and dependent toolchain promotion cleanly if recovery is
   not demonstrated, without weakening candidate or runtime security gates.

Non-goals:

- No fallback to upstream release binaries, checksum-only trust, a local build,
  a production server, or a mutable container tag.
- No change to the GitHub Actions SLSA identity or candidate certifier identity.
- No public-beta registration, candidate certification, release publication, or
  server deployment during diagnosis.
- No reviewer invitation or permission grant without explicit authorization.

## 3. Approaches Considered

### A. Diagnostic-first recovery (selected)

Add a typed failure record and a workflow diagnostic artifact, run the workflow
once, then apply one evidence-backed remediation. This preserves the trust
contract and makes the next decision reproducible. If the evidence does not
yield a safe fix, use the closure path below.

### B. Replace the builder with an upstream binary

This would likely avoid the Go module failure, but it changes the trusted
certificate identity and would contradict the approved OpenOPC GitHub Actions
SLSA policy. It is rejected unless the trust model is explicitly redesigned and
re-approved.

### C. Close the builder immediately

Disable the workflow and toolchain promotion now. This is the fail-closed
fallback and is acceptable if no safe remediation is available, but it gives up
the Cosign-backed module publication path rather than explaining the failure.

## 4. Selected Architecture

### 4.1 Builder diagnostics

`public-beta-cosign-builder.ts` will retain its clean JSON contract on stdout.
On failure it will emit a bounded JSON diagnostic to stderr with:

- `schemaVersion` and a stable error code;
- stage: `source-verify`, `module-fetch`, `offline-build`, or `inspect`;
- executable identity (`git` or `docker`), exit code, and timeout state;
- bounded stderr/stdout excerpts after the existing credential redaction;
- a boolean indicating output-limit termination.

The record will never include environment dumps, tokens, authorization headers,
full provider responses, or unbounded command output. A failure remains a
non-zero process exit and can never produce a build result.

### 4.2 Workflow preflight and evidence retention

The primary and replay jobs will run the same bounded preflight inside the
pinned build image before module download. The preflight records the Go module
proxy/checksum configuration, DNS/TLS reachability needed for module fetch, and
the exact image digest. It must not grant network access to the offline build or
inspect stages.

Each build job will retain only a small diagnostic artifact under an
`if: always()` upload step. The upload is informational and cannot satisfy any
downstream `needs` edge. Artifact upload, comparison, attestation, smoke, and
promotion remain skipped after a build failure.

The existing boundaries remain unchanged:

- exact source commit/tree and clean module files;
- full build-image digest;
- `go mod verify` before and after download;
- `GOFLAGS=-mod=readonly` and `GOTOOLCHAIN=local`;
- `bridge` only for dependency fetch;
- `network=none` for build and inspect;
- byte-identical primary/replay output before attestation.

### 4.3 Remediation gate

After the diagnostic run, remediation is limited to the confirmed failing
boundary. Examples include correcting an explicit module proxy/TLS setting,
adjusting a bounded cache mount, or fixing a deterministic command invocation.
No retry, timeout increase, network widening, or test relaxation is accepted as
a substitute for a root-cause fix.

## 5. Closure Path

If the diagnostic evidence does not support a safe fix, or if the repaired
workflow cannot complete a full primary/replay/attestation/smoke sequence, the
following controls are applied:

1. Disable `.github/workflows/openopc-cosign-builder.yml` dispatch and remove
   its promotion path.
2. Make toolchain admission reject the absent/disabled toolchain with a stable
   reason code.
3. Keep Cosign-dependent module signing/publication lanes closed and keep the
   restricted public-beta manifest `not_ready`.
4. Leave unrelated beta surfaces unchanged; do not silently substitute another
   signing mechanism.
5. Record the failed run IDs and retained diagnostics in the release runbook.

Closure is reversible only through a separately reviewed design and an
independently approved workflow reintroduction.

## 6. Testing and Verification

The implementation follows RED -> GREEN -> focused regression:

1. Add failing unit tests for stage classification, stable failure codes,
   bounded output, and secret redaction in
   `scripts/release/public-beta-cosign-builder.test.ts`.
2. Add failing workflow-contract tests for the diagnostic artifact,
   `if: always()` retention, preflight location, and unchanged network/digest
   restrictions in `scripts/release/public-beta-workflow-contract.test.ts`.
3. Implement the smallest code/workflow changes and run the focused tests.
4. Run the complete release-script test set, formatting, and diff checks.
5. After an independently approved merge, execute one diagnostic/recovery
   workflow. A successful result requires both builds, byte comparison, SLSA
   attestations, Linux and Windows smoke, and protected promotion checks.

No fixture, local Docker result, or focused green test is live release evidence.
If the real run fails, the closure path is taken rather than claiming readiness.

## 7. Approval and Access Boundary

The design does not grant repository access. The protected environment must
retain `prevent_self_review`; a second reviewer may be added only after the user
confirms that person is authorized. Until then, no merge, promotion, or release
publication is claimed.

## 8. Acceptance Criteria

Recovery is complete only when:

- the failure is explained by retained, redacted stage evidence;
- the minimal remediation passes all focused and whole-workspace checks;
- primary and replay subjects are byte-identical;
- both subjects have the exact GitHub Actions SLSA identity and are cross-bound
  by their recorded digests;
- Linux and Windows smoke checks pass;
- protected environment approval and independent review are present; and
- the final manifest, release assets, bundles, and source control all agree by
  digest.

Otherwise the builder is disabled and the dependent beta capability remains
explicitly `not_ready`.
