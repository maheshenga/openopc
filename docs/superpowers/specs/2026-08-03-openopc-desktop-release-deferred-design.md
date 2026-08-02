# OpenOPC Deferred Desktop Release Design

Date: 2026-08-03
Status: Approved design, pending implementation plan

## Context

OpenOPC deployment is intentionally deferred. The repository therefore has no
`OPENOPC_WEB_URL` repository variable yet. The current Desktop workflow still
starts all three platform runners and then fails after dependency installation
because the required Web URL is empty. This creates a red `main` workflow while
producing no usable installer.

The desktop packaging metadata also still names the upstream Kortix repository
and company. A stable OpenOPC installer built from that metadata would check the
wrong GitHub release feed and expose upstream ownership in packaged metadata.

## Goals

- Make the Desktop workflow finish successfully and visibly when deployment is
  deferred and `OPENOPC_WEB_URL` is unset.
- Keep strict URL validation once an operator configures the variable.
- Avoid starting macOS, Windows, or Linux runners when no usable installer can
  be produced.
- Point stable desktop update metadata at `maheshenga/openopc`.
- Remove externally visible `Kortix AI Corp` and `kortix-ai/suna` packaging
  metadata.
- Preserve compatibility identifiers required by existing installations,
  OAuth callbacks, local state, and Web/native feature detection.

## Non-Goals

- Deploy the Web application or any server component.
- Configure `OPENOPC_WEB_URL`, DNS, TLS, production secrets, or signing keys.
- Produce or publish a new installer during this change.
- Rename internal workspace packages or refactor desktop runtime behavior.
- Replace the legacy deep-link scheme or installed-application identity.

## Workflow Design

Add a lightweight `preflight` job to `.github/workflows/desktop.yml`.

The preflight job has three states:

1. **URL absent**
   - Detect an empty `vars.OPENOPC_WEB_URL`.
   - Set an `enabled=false` job output.
   - Write a GitHub step summary explaining that desktop publication is deferred
     until the Web deployment has a canonical HTTPS `/projects` URL.
   - Exit successfully.

2. **URL present but invalid**
   - Check out the repository and validate the value with the existing
     `normalizeOpenOpcReleaseUrl` policy.
   - Fail the preflight job with the existing canonical HTTPS error.
   - Do not start any platform build jobs.

3. **URL present and valid**
   - Set `enabled=true`.
   - Allow the existing platform matrix to build installers.

The build job will depend on preflight and run only when
`needs.preflight.outputs.enabled == 'true'`.

The publish job will depend on both preflight and build. Its condition will keep
the existing partial-artifact behavior while adding the missing preflight gate:
publication may run only when preflight enabled desktop release and the matrix
was not cancelled. When deployment is deferred, no tag, release, checksum, or
artifact operation may run.

This preserves the current behavior where artifacts from successful operating
systems may still be published if another matrix target fails. It only removes
the erroneous no-artifact publish attempt when the URL is deliberately absent.

## Packaging Ownership

Update externally visible packaging metadata as follows:

- `apps/desktop-electron/electron-builder.yml`
  - GitHub publish owner: `maheshenga`
  - GitHub publish repository: `openopc`
  - Copyright branding: `OpenOPC`
- `apps/desktop-electron/package.json`
  - Repository: `https://github.com/maheshenga/openopc`
  - Author branding: `OpenOPC`
- `apps/desktop-electron/README.md`
  - Describe the OpenOPC repository as the stable updater feed.
  - Explain that missing `OPENOPC_WEB_URL` intentionally defers CI packaging.

The stable Electron updater will therefore read releases from the OpenOPC
repository. The mutable `desktop-dev-latest` channel remains excluded from
automatic updates by the existing channel policy.

## Compatibility Boundary

The following identifiers remain unchanged:

- Stable app ID: `com.kortix.desktop`
- Development app ID: `com.kortix.desktop.dev`
- Deep-link scheme: `kortix://`
- Desktop user-agent token: `KortixDesktop/0.1.0`
- Existing production and development user-data directory mapping
- Internal workspace package name: `@kortix/desktop-electron`

These values are compatibility contracts rather than visible product branding.
Changing them now could break OAuth return routing, side-by-side dev installs,
existing user sessions, updater continuity, or Web/native detection. Their
replacement requires a separate migration design.

## Error Handling

- An absent URL is an expected deferred state and produces a successful,
  explanatory preflight result.
- A non-empty invalid URL remains a configuration error and fails closed.
- Build and signing failures retain their existing platform-specific behavior.
- Publication never runs when preflight disabled the release.
- No placeholder or upstream URL is substituted automatically.

## Verification

Extend the desktop contract tests to prove:

- the workflow contains the explicit preflight output and build gate;
- an absent URL is represented as deferred rather than invalid;
- a configured URL still uses `normalizeOpenOpcReleaseUrl`;
- publication is gated by preflight while retaining partial matrix artifacts;
- Electron publish metadata targets `maheshenga/openopc`;
- package repository and author metadata use OpenOPC ownership;
- visible packaging metadata no longer contains `Kortix AI Corp` or
  `kortix-ai/suna`;
- legacy app IDs, deep-link scheme, user-agent token, and user-data mapping stay
  unchanged.

Focused verification command:

```powershell
pnpm.cmd --filter @kortix/desktop-electron test
```

The implementation will also run the repository formatter or linter against
the changed files if those tools support YAML, JSON, Markdown, and JavaScript in
the affected paths.

## Acceptance Criteria

- With no `OPENOPC_WEB_URL`, a Desktop workflow run succeeds after preflight,
  starts no platform matrix, and mutates no release or tag.
- With an invalid non-empty URL, preflight fails before platform runners start.
- With a canonical HTTPS URL ending exactly in `/projects`, the existing build
  and publish path remains enabled.
- Stable packaged metadata resolves updates from `maheshenga/openopc`.
- No externally visible desktop packaging metadata claims Kortix AI ownership.
- All focused desktop tests pass with zero failures.
- No deployment, DNS, secret, signing, release, or installer publication action
  occurs as part of this task.

## Rollback

The change is configuration-only and can be rolled back by reverting its single
implementation commit. Reverting restores the prior fail-on-missing-URL workflow
and upstream packaging metadata; it does not require database, server, or user
data migration.
