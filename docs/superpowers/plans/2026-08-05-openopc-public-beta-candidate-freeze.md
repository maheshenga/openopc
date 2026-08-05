# OpenOPC Public-Beta Candidate Freeze And Clean Verification Plan

**Goal:** Convert the verified dirty local source state into one reviewable
candidate commit without absorbing unrelated work, then reproduce the local
public-beta gates from an isolated clean worktree.

**Current branch:** `design/desktop-release-deferred`

**Current HEAD:** `4e827cf685b195a1b913fc1f6f0bb89426554dce`

**Upstream:** `openopc/design/desktop-release-deferred` (`18` commits behind
local HEAD)

## Non-Negotiable Boundaries

- Preserve every current modified and untracked file.
- Do not use `git reset`, `git clean`, `git stash`, or broad checkout/restore.
- Do not use `git add -A`, `git add .`, or a directory-wide add.
- Do not read, edit, stage, or commit
  `docs/superpowers/plans/2026-08-01-openopc-developer-sdk-newapi-zpay.md`.
- Do not push, open or merge a PR, publish npm packages, deploy, change DNS,
  install production secrets, rebuild Desktop, or call live AI/payment
  providers during candidate preparation.
- Candidate composition, staging, and commits require explicit authorization.
- Overlapping files must be staged by reviewed patch or exact path after their
  full diff is assigned to one candidate slice.

## Task 1: Restore Git Object Integrity

- [x] Reproduce the known broken link from commit `6a8c5a65` to missing tree
  `8f1519aa` with `git fsck --full --no-reflogs`.
- [x] Validate the configured `github.com` SSH alias and read-only GitHub
  authentication through `ssh.github.com:443`.
- [x] Fetch `design/desktop-release-deferred` through a one-shot SSH URL.
- [x] Use `git fetch --refetch` after ordinary negotiation does not resend the
  missing tree.
- [x] Verify `git cat-file -e 8f1519aa...` and full `git fsck` both pass.

Evidence:

```text
before: cat-file exit 1; fsck exit 2; one broken link and one missing tree
after:  cat-file exit 0; fsck exit 0; zero integrity issues
```

The refetch updated only the local object database and `FETCH_HEAD`; it did not
move the branch, index, or worktree.

## Task 2: Partition The Dirty Worktree

- [x] Capture branch, HEAD, upstream, index, and worktree counts.
- [x] Compare every dirty path with the completed public-beta, onboarding,
  package-upload, SDK-readiness, and browser-bootstrap plans.
- [x] Keep plan-mapped OpenOPC work separate from the API test-harness support
  slice and from paths requiring independent ownership review.
- [x] Confirm the protected plan is untracked and has zero Git history entries.

Pre-plan snapshot:

```text
tracked worktree changes: 74
untracked paths: 26
index entries: 0
literal matches to completed OpenOPC plans: 51 paths
paths requiring manual classification: 49 paths
```

Literal plan matching is navigation evidence only. A path is not eligible for
the candidate until its live diff is reviewed, because several files contain
overlapping changes from more than one completed slice.

## Task 3: Review The OpenOPC Core Slice

Do not stage this slice yet. Review the complete live diff for these exact
groups and assign every hunk to package upload, SDK readiness/request
lifecycle, browser bootstrap, or closure evidence:

```text
.github/workflows/deploy-prod.yml
.github/workflows/package-tests.yml
apps/admin/src/app/admin-surface.test.tsx
apps/admin/src/features/developer-center/applications/application-detail-page.tsx
apps/admin/src/features/developer-center/applications/application-pages.test.tsx
apps/api/src/developer/app.ts
apps/api/src/developer/artifacts.test.ts
apps/api/src/developer/artifacts.ts
apps/api/src/developer/index.test.ts
apps/api/src/index.ts
apps/api/src/module-domains/host.test.ts
apps/api/src/module-domains/host.ts
apps/api/src/module-services/browser-cors.test.ts
apps/api/src/module-services/browser-cors.ts
apps/web/package.json
apps/web/scripts/e2e/fixtures/
apps/web/scripts/e2e/module-bootstrap-browser-smoke.ts
apps/web/src/features/developer-center/publisher/access.test.ts
apps/web/src/features/developer-center/publisher/onboarding-panel.test.tsx
apps/web/src/features/developer-center/publisher/submit-page.connected.test.tsx
apps/web/src/features/developer-center/publisher/submit-page.test.tsx
apps/web/src/features/developer-center/publisher/submit-page.tsx
apps/web/src/features/project-modules/module-bootstrap-bridge.test.ts
apps/web/src/features/project-modules/module-bootstrap-bridge.ts
apps/web/src/features/project-modules/module-service-bridge.ts
apps/web/src/features/project-modules/project-module-host.test.ts
apps/web/src/features/project-modules/project-module-host.ts
packages/openopc-developer-sdk/
packages/sdk/src/core/client/kortix.ts
packages/sdk/src/core/http/api-client.ts
packages/sdk/src/core/rest/projects-client/developer-modules.test.ts
packages/sdk/src/core/rest/projects-client/developer-modules.ts
packages/sdk/src/public-type-surface.snapshot.json
pnpm-lock.yaml
supabase/config.toml
```

Acceptance criteria:

- No provider credential, merchant credential, production secret, or private
  endpoint appears in runtime output, tests, examples, docs, or workflow args.
- Package-upload capability remains fail closed for missing, loading, error,
  false, and account-mismatch states.
- Browser bootstrap accepts only the exact reviewed iframe source and immutable
  canonical release origin, with no public origin override and no credentialed
  module CORS.
- SDK package output remains self-contained and contains no runtime workspace
  dependency.
- Workflow changes do not publish unless their existing explicit release gates
  authorize the package row.

## Task 4: Review The API Hermetic-Test Support Slice

This slice made the default API gate deterministic on Windows without loading
the encrypted repository environment. It must be reviewed and committed
separately from product behavior:

```text
apps/api/package.json
apps/api/scripts/test.sh
apps/api/scripts/test-runner.mjs
apps/api/scripts/test-runner.test.mjs
apps/api/src/__tests__/*.test.ts (only the currently modified exact files)
apps/api/src/platform/providers/e2b.test.ts
apps/api/src/snapshots/__tests__/cli-executor-closure.test.ts
```

Review the small production hunks independently before deciding whether they
belong to the support commit or need their own commits:

```text
apps/api/src/billing/routes/account-state.ts
apps/api/src/llm-gateway/wire.ts
```

Acceptance criteria:

- Default tests receive only explicit non-secret test values and an empty Bun
  env file.
- Integration/live modes continue to require the encrypted operator
  environment and are never silently converted into unit tests.
- Test discovery fails when a requested mode finds zero files.
- The standard package command executes the same `425` default files that
  produced `3775 pass / 14 skip / 0 fail` in the latest local gate.
- No assertion, skip rule, timeout, or production authorization check is
  weakened merely to make the suite green.

## Task 5: Quarantine Unassigned Work

Do not automatically include these paths in the OpenOPC candidate. They are
independent behavior, generated surfaces, comment-only edits, or pre-existing
work that needs an explicit owner and verification record:

```text
apps/admin/next.config.ts
apps/admin/src/i18n/
apps/api/src/projects/lib/access.ts
apps/api/src/shared/account-limits.ts
apps/sandbox/slack-cli/channels/slack.ts
apps/sandbox/slack-cli/channels/teams.ts
apps/web/public/schema/kortix.schema.json
apps/web/public/schema/kortix.v1.schema.json
apps/web/public/schema/kortix.v2.schema.json
apps/web/src/features/workspace/customize/sections/view/agent-editor-catalog.ts
docs/specs/2026-07-13-enterprise-vpc-single-tenant-deployment.md
packages/manifest-schema/src/constants.ts
packages/starter/src/embedded.generated.json
packages/starter/templates/base/.kortix/opencode/skills/kortix-system/references/capabilities.md
```

The protected `2026-08-01` plan is a separate hard exclusion, not an ownership
review candidate.

## Task 6: Freeze The Candidate After Authorization

These steps are intentionally not authorized or executed yet.

- [x] Re-read `git status --short --branch` and confirm the index is empty.
- [x] Review the OpenOPC core slice hunk by hunk, including every untracked file.
- [x] Review and either include or quarantine the hermetic API test support
  slice; do not mix an unresolved support hunk into a product commit.
- [x] Obtain an explicit decision for every path in Task 5.
- [x] Stage only an exact reviewed path or patch at a time.
- [x] Run `git diff --cached --check` and inspect `git diff --cached` in full.
- [x] Assert the protected path is absent from `git diff --cached --name-only`.
- [x] Create intentionally scoped commits in dependency order.
- [x] Record the resulting candidate SHA and prove the root worktree is
  otherwise preserved.

Freeze evidence:

```text
ea657fe83 fix(api): stabilize the hermetic default suite
28aeaa10a feat(openopc): complete the developer module workflow
Task 5 decision: quarantine every listed path
protected plan: absent from both commits
root worktree: preserved; no reset, clean, stash, push, or deployment
```

Recommended dependency order after approval:

1. Hermetic API test runner and independently reviewed baseline fixes.
2. Package-upload capability and API/SDK/Web contract.
3. Self-contained OpenOPC developer SDK and request lifecycle.
4. Browser bootstrap, host bridge, CSP/CORS, and deterministic browser smoke.
5. Plans, specs, snapshots, lockfile, and append-only evidence that correspond
   exactly to the preceding source commits.

## Task 7: Reproduce Gates From The Exact Candidate

After the candidate SHA exists, create an isolated clean worktree at that SHA.
Do not clean or reset the current root worktree.

- [ ] Install with the committed lockfile using the repository's frozen/offline
  policy where available.
- [ ] Run API, SDK, Web, Worker, and Desktop focused closure suites.
- [ ] Run API, SDK, and Web typechecks and full tests.
- [ ] Run both SDK packed install/import smoke gates.
- [ ] Run the browser-module Playwright smoke and verify nonblank desktop/mobile
  screenshots or canvas/page evidence where the harness produces them.
- [ ] Run static provider/origin/sandbox scans and `git diff --check`.
- [ ] Record exact counts, the candidate SHA, tool versions, and all real skips.
- [ ] Remove the isolated worktree only after resolving and validating its exact
  absolute path; never target the root worktree.

A current dirty-worktree pass is supporting evidence, not a substitute for this
exact-SHA reproduction.

## Task 8: Preserve The External Release Boundary

Even after a clean candidate passes, the following remain separately
authorized production work:

- Git push, PR, protected checks, review, and merge;
- first npm publication and Trusted Publisher configuration;
- wildcard DNS and certificate validation;
- Worker/API deployment and production secrets/configuration;
- one reviewed real `sandboxed-web` module on an immutable release origin;
- live NewAPI model/list/text/stream calls;
- controlled Z-Pay validation;
- Desktop rebuild, signing, publication, installation, and public Web load.

Local source readiness remains `YES`. Exact candidate readiness remains
`NOT YET` until Task 7 completes on one recorded commit. Production
public-beta readiness remains `NOT YET` until the separately authorized live
release checks pass on that same commit.
