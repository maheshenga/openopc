# OpenOPC Canonical Repository Identity Migration Design

**Status:** Approved for local-only implementation on 2026-07-31 by the
user's instruction to continue with the recommended complete migration.

## Decision

The only production GitHub trust identity is `maheshenga/openopc`.
The previous assumed identity `openopc/platform` is invalid and must be
rejected anywhere a workflow run, builder manifest, SLSA predicate,
attestation, release manifest, or admission CLI is authenticated.

The repository identity remains a compile-time and workflow-time constant.
It is not configurable through an environment variable, workflow input,
manifest field, or CLI override. This preserves the existing fail-closed
security boundary and prevents a caller from selecting its own trust root.

## Exact Identity Contract

- Repository: `maheshenga/openopc`
- Protected ref: `refs/heads/main`
- Builder workflow: `.github/workflows/openopc-cosign-builder.yml`
- Certificate identity:
  `https://github.com/maheshenga/openopc/.github/workflows/openopc-cosign-builder.yml@refs/heads/main`
- Signer workflow:
  `maheshenga/openopc/.github/workflows/openopc-cosign-builder.yml`
- Trigger: input-free `workflow_dispatch`
- Environment: `toolchain-release`

The migration does not change the toolchain ID, upstream Cosign source,
Go version, build-image digest, action pins, build targets, release tag,
or artifact names.

## Surfaces

The migration is closed over 15 current runtime and contract files:

- GitHub workflow-run authentication and its tests;
- Cosign toolchain parser, schemas, fixtures, and tests;
- admission verifier, production CLI adapter, and tests;
- protected builder workflow guards and emitted manifest identity;
- public-beta artifact, evidence, release-manifest, and workflow contract
  fixtures/tests that represent the production repository.

Historical SDD reviews and ledgers retain `openopc/platform` as evidence of
the invalid earlier assumption. Current implementation docs point to this
design as the superseding identity decision.

## Data Flow

1. GitHub reports a workflow run from `maheshenga/openopc` on `main`.
2. The authenticator snapshots and validates that exact repository/ref/path.
3. The workflow emits a manifest and SLSA identity using the same repository
   and workflow identity.
4. The toolchain parser accepts only those exact literal values.
5. Admission invokes GitHub attestation verification with the same repository,
   certificate identity, signer workflow, ref, and control SHA.
6. Any legacy or alternate repository fails before publication or execution.

## Failure Behavior

- `openopc/platform`, `kortix-ai/suna`, forks, and arbitrary repositories are
  rejected.
- Case normalization remains limited to comparison of the expected canonical
  repository name; accepted output is normalized to `maheshenga/openopc`.
- A repository mismatch never falls back to the local `origin` URL.
- No real trust output is generated locally.

## Verification

Implementation uses incremental TypeScript TDD. Each boundary first receives
a literal, behavior-level expectation for `maheshenga/openopc` and rejection
of `openopc/platform`; that focused test must fail against the old production
identity before the minimum source/config change makes it pass.

The final local gate includes all affected contract tests, the prior Task 5
native/admission/archive/authentication/toolchain/safe-file regression gate,
Biome, whitespace checks, an exact legacy-identity scan over runtime surfaces,
an empty Git index, and absence of the three real production trust outputs.

## Authorization Boundary

This design authorizes local unstaged edits and local tests only. It does not
authorize staging, amending or creating a commit, adding/changing a remote,
pushing, changing branch or environment protection, dispatching a workflow,
publishing a release, deployment, or registration.
