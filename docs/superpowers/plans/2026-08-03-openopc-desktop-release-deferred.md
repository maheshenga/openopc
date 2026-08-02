# OpenOPC Deferred Desktop Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Desktop CI green while Web deployment is deferred, and ensure future OpenOPC installers publish and update from `maheshenga/openopc` without breaking legacy desktop compatibility identifiers.

**Architecture:** Add one lightweight GitHub Actions preflight job that classifies the repository URL variable as absent, invalid, or valid before any platform runner starts. Keep packaging ownership changes limited to Electron metadata and documentation; retain the existing app IDs, `kortix://` scheme, user-agent token, user-data mapping, and internal workspace package name.

**Tech Stack:** GitHub Actions YAML, Electron Builder, Node.js CommonJS, Bun test, pnpm, Biome, Python/PyYAML for YAML syntax verification.

## Global Constraints

- Do not deploy Web, API, gateway, database, DNS, TLS, or any server component.
- Do not configure or read production secrets, signing keys, or `OPENOPC_WEB_URL`.
- Do not publish installers, GitHub releases, tags, or container images.
- An absent `OPENOPC_WEB_URL` is a successful deferred state; a non-empty invalid URL remains a hard failure.
- Never substitute a placeholder, upstream Kortix URL, or reserved `.invalid` URL.
- Preserve stable app ID `com.kortix.desktop` and development app ID `com.kortix.desktop.dev`.
- Preserve deep-link scheme `kortix://`, user-agent token `KortixDesktop/0.1.0`, legacy user-data mapping, and package name `@kortix/desktop-electron`.
- Keep partial matrix publication behavior when preflight is enabled and one operating-system target fails.
- Never read, modify, stage, or remove `docs/superpowers/plans/2026-08-01-openopc-developer-sdk-newapi-zpay.md`.
- Stage only the exact paths listed in each task; never use `git add .` or `git add -A`.
- Do not push, open a PR, merge, or deploy without separate authorization.
- Treat the two task commits as local review checkpoints. If PR integration is later authorized, use a squash merge so the approved design remains one reversible change on `main`.

---

## File Map

- `.github/workflows/desktop.yml`: owns deferred-release preflight, platform build gating, and prerelease publication gating.
- `apps/desktop-electron/src/app-policy.test.js`: existing desktop policy and workflow contract tests; add RED assertions here before each implementation change.
- `apps/desktop-electron/electron-builder.yml`: owns packaged app identity, updater provider, artifact naming, and visible copyright metadata.
- `apps/desktop-electron/package.json`: owns npm/Electron author and repository metadata.
- `apps/desktop-electron/README.md`: documents Web URL configuration and stable updater repository behavior.

### Task 1: Defer Desktop CI Before Platform Runners Start

**Files:**
- Modify: `apps/desktop-electron/src/app-policy.test.js:113-121`
- Modify: `apps/desktop-electron/src/app-policy.test.js:361-386`
- Modify: `.github/workflows/desktop.yml:34-242`

**Interfaces:**
- Consumes: `normalizeOpenOpcReleaseUrl(value: string): string | null` from `apps/desktop-electron/src/app-policy.js`.
- Produces: GitHub Actions job output `needs.preflight.outputs.enabled`, represented as the strings `'true'` or `'false'`.
- Preserves: build job environment variable `DESKTOP_URL: ${{ vars.OPENOPC_WEB_URL }}` and the current partial matrix artifact publication behavior.

- [ ] **Step 1: Add the failing workflow contract test**

Add this test inside `describe('desktop visible brand and compatibility identity', ...)`, after the existing release-workflow branding test:

```javascript
test('defers desktop publication until an operator-owned Web URL exists', () => {
  const desktopWorkflow = readRepoFile(path.join('.github', 'workflows', 'desktop.yml'));
  const preflightStart = desktopWorkflow.indexOf('\n  preflight:\n');
  const buildStart = desktopWorkflow.indexOf('\n  build:\n');
  const publishStart = desktopWorkflow.indexOf('\n  publish:\n');

  expect(preflightStart).not.toBe(-1);
  expect(buildStart).toBeGreaterThan(preflightStart);
  expect(publishStart).toBeGreaterThan(buildStart);

  const preflightBlock = desktopWorkflow.slice(preflightStart, buildStart);
  const buildBlock = desktopWorkflow.slice(buildStart, publishStart);

  expect(preflightBlock).toContain('name: Desktop release preflight');
  expect(preflightBlock).toContain('enabled: ${{ steps.release.outputs.enabled }}');
  expect(preflightBlock).toContain('if [ -z "$DESKTOP_URL" ]; then');
  expect(preflightBlock).toContain('echo "configured=false" >> "$GITHUB_OUTPUT"');
  expect(preflightBlock).toContain('echo "configured=true" >> "$GITHUB_OUTPUT"');
  expect(preflightBlock).toContain('## Desktop release deferred');
  expect(preflightBlock).toContain("if: steps.config.outputs.configured == 'true'");
  expect(preflightBlock).toContain('normalizeOpenOpcReleaseUrl');
  expect(preflightBlock.indexOf('normalizeOpenOpcReleaseUrl')).toBeLessThan(
    preflightBlock.indexOf('id: release'),
  );
  expect(buildBlock).not.toContain('- name: Validate OpenOPC Web URL');
  expect(desktopWorkflow).toContain("if: needs.preflight.outputs.enabled == 'true'");
  expect(desktopWorkflow).toContain('needs: [preflight, build]');
  expect(desktopWorkflow).toContain(
    "if: always() && needs.preflight.result == 'success' && needs.preflight.outputs.enabled == 'true' && needs.build.result != 'cancelled'",
  );
  expect(desktopWorkflow.match(/- name: Validate OpenOPC Web URL/g)).toHaveLength(1);
});
```

Keep the existing `locks production source and workflow policy to OpenOPC configuration` test unchanged; it continues to prove the configured path uses `normalizeOpenOpcReleaseUrl`.

- [ ] **Step 2: Run the new test and confirm RED**

Run:

```powershell
pnpm.cmd --filter @kortix/desktop-electron exec bun test ./src/app-policy.test.js --test-name-pattern "defers desktop publication"
```

Expected: FAIL because `.github/workflows/desktop.yml` has no `preflight:` job and still validates separately inside every matrix target.

- [ ] **Step 3: Add the minimal preflight state machine**

Insert this job immediately under `jobs:` in `.github/workflows/desktop.yml`:

```yaml
  preflight:
    name: Desktop release preflight
    runs-on: ubuntu-22.04
    env:
      DESKTOP_URL: ${{ vars.OPENOPC_WEB_URL }}
    outputs:
      enabled: ${{ steps.release.outputs.enabled }}
    steps:
      - name: Inspect OpenOPC Web URL configuration
        id: config
        shell: bash
        run: |
          if [ -z "$DESKTOP_URL" ]; then
            echo "configured=false" >> "$GITHUB_OUTPUT"
            {
              echo "## Desktop release deferred"
              echo
              echo '`OPENOPC_WEB_URL` is not configured, so installer build and publication were skipped.'
              echo 'Configure it to the canonical HTTPS `/projects` URL after Web deployment is ready.'
            } >> "$GITHUB_STEP_SUMMARY"
          else
            echo "configured=true" >> "$GITHUB_OUTPUT"
          fi

      - uses: actions/checkout@v7
        if: steps.config.outputs.configured == 'true'

      - uses: actions/setup-node@v4
        if: steps.config.outputs.configured == 'true'
        with:
          node-version: 22

      - name: Validate OpenOPC Web URL
        if: steps.config.outputs.configured == 'true'
        shell: bash
        run: |
          node <<'NODE'
          const { normalizeOpenOpcReleaseUrl } = require('./apps/desktop-electron/src/app-policy');
          const value = process.env.DESKTOP_URL || '';
          if (!normalizeOpenOpcReleaseUrl(value)) {
            throw new Error('OPENOPC_WEB_URL must be canonical HTTPS with the exact /projects path');
          }
          NODE

      - name: Export Desktop release gate
        id: release
        if: success()
        shell: bash
        env:
          CONFIGURED: ${{ steps.config.outputs.configured }}
        run: echo "enabled=$CONFIGURED" >> "$GITHUB_OUTPUT"
```

Modify the existing `build` job header to depend on and obey preflight:

```yaml
  build:
    name: Build dev desktop ${{ matrix.target_pretty }}
    needs: preflight
    if: needs.preflight.outputs.enabled == 'true'
```

Delete the existing matrix-level `Validate OpenOPC Web URL` step. Preflight now validates once before any macOS, Windows, or Linux runner starts.

Modify the `publish` job header while preserving partial matrix publication:

```yaml
  publish:
    name: Publish desktop-dev-latest
    needs: [preflight, build]
    if: always() && needs.preflight.result == 'success' && needs.preflight.outputs.enabled == 'true' && needs.build.result != 'cancelled'
```

- [ ] **Step 4: Run the focused test and confirm GREEN**

Run:

```powershell
pnpm.cmd --filter @kortix/desktop-electron exec bun test ./src/app-policy.test.js --test-name-pattern "defers desktop publication|locks production source"
```

Expected: PASS for both the new deferred-state contract and the existing strict URL-policy contract.

- [ ] **Step 5: Parse the workflow as YAML**

Run:

```powershell
python -c "from pathlib import Path; import yaml; yaml.safe_load(Path('.github/workflows/desktop.yml').read_text(encoding='utf-8')); print('desktop workflow YAML valid')"
```

Expected: exit `0` and output `desktop workflow YAML valid`.

- [ ] **Step 6: Run the full desktop package suite**

Run:

```powershell
pnpm.cmd --filter @kortix/desktop-electron test
```

Expected baseline: Node tests `54/54` pass and Bun tests `123/123` pass after adding the new test, with zero failures.

- [ ] **Step 7: Check formatting and whitespace**

Run:

```powershell
pnpm.cmd exec biome check apps/desktop-electron/src/app-policy.test.js
git diff --check -- .github/workflows/desktop.yml apps/desktop-electron/src/app-policy.test.js
```

Expected: both commands exit `0` with no errors.

- [ ] **Step 8: Commit Task 1**

Run:

```powershell
git add -- .github/workflows/desktop.yml apps/desktop-electron/src/app-policy.test.js
git diff --cached --check
git diff --cached --name-only
git commit -m "fix(ci): defer desktop release without web URL"
```

Expected staged paths before commit:

```text
.github/workflows/desktop.yml
apps/desktop-electron/src/app-policy.test.js
```

### Task 2: Move Desktop Packaging Ownership to OpenOPC

**Files:**
- Modify: `apps/desktop-electron/src/app-policy.test.js:71-82`
- Modify: `apps/desktop-electron/electron-builder.yml:8-19`
- Modify: `apps/desktop-electron/package.json:7-8`
- Modify: `apps/desktop-electron/README.md:44-49`
- Modify: `apps/desktop-electron/README.md:79-104`

**Interfaces:**
- Consumes: Electron Builder GitHub provider fields `owner` and `repo`.
- Produces: packaged `app-update.yml` metadata targeting `maheshenga/openopc` for stable builds.
- Preserves: all compatibility identifiers asserted by the adjacent `keeps stable desktop identifiers used by installed apps and OAuth callbacks` test.

- [ ] **Step 1: Change packaging assertions to the desired OpenOPC ownership and confirm RED**

Replace the author and copyright assertions in `packages installers and shortcuts under the OpenOPC product name` and add repository/updater assertions:

```javascript
test('packages installers and shortcuts under OpenOPC ownership', () => {
  const packageJson = JSON.parse(readDesktopFile('package.json'));
  const builder = readDesktopFile('electron-builder.yml');
  const readme = readDesktopFile('README.md');

  expect(packageJson.productName).toBe('OpenOPC');
  expect(packageJson.description).toContain('OpenOPC');
  expect(packageJson.author).toBe('OpenOPC');
  expect(packageJson.repository).toBe('https://github.com/maheshenga/openopc');
  expect(topLevelYamlScalar(builder, 'productName')).toBe('OpenOPC');
  expect(topLevelYamlScalar(builder, 'copyright')).toBe('© OpenOPC');
  expect(builder).toMatch(
    /publish:\s*[\s\S]*provider: github\s*[\s\S]*owner: maheshenga\s*[\s\S]*repo: openopc/,
  );
  expect(builder).toContain('title: OpenOPC ${version}');
  expect(builder).toContain('artifactName: ${productName}-Setup-${version}.${ext}');
  expect(readme).toContain('maheshenga/openopc');

  for (const source of [JSON.stringify(packageJson), builder, readme]) {
    expect(source).not.toContain('Kortix AI Corp');
    expect(source).not.toContain('kortix-ai/suna');
  }
});
```

Run:

```powershell
pnpm.cmd --filter @kortix/desktop-electron exec bun test ./src/app-policy.test.js --test-name-pattern "packages installers"
```

Expected: FAIL showing the current `Kortix AI Corp` author/copyright and `kortix-ai/suna` repository metadata.

- [ ] **Step 2: Update package and Electron Builder metadata**

Change `apps/desktop-electron/package.json` to:

```json
"author": "OpenOPC",
"repository": "https://github.com/maheshenga/openopc",
```

Change the ownership block in `apps/desktop-electron/electron-builder.yml` to:

```yaml
appId: com.kortix.desktop
productName: OpenOPC
copyright: © OpenOPC

publish:
  provider: github
  owner: maheshenga
  repo: openopc
```

Do not change `appId`, protocol configuration, artifact names, targets, or signing configuration.

- [ ] **Step 3: Update the desktop release documentation**

After the existing `OPENOPC_WEB_URL` explanation in `apps/desktop-electron/README.md`, add:

```markdown
When `OPENOPC_WEB_URL` is absent, the Desktop workflow records a successful
`Desktop release deferred` preflight and skips platform runners, artifacts,
tags, and prerelease publication. Configuring a non-empty value re-enables the
strict canonical HTTPS `/projects` validation before any installer build starts.
```

Replace the auto-update feed sentence with:

```markdown
**GitHub Releases** as its feed (the `publish: github` block in
`electron-builder.yml` bakes an `app-update.yml` pointing at
`maheshenga/openopc`).
```

- [ ] **Step 4: Run the focused ownership test and confirm GREEN**

Run:

```powershell
pnpm.cmd --filter @kortix/desktop-electron exec bun test ./src/app-policy.test.js --test-name-pattern "packages installers"
```

Expected: PASS.

- [ ] **Step 5: Prove compatibility identifiers remain unchanged**

Run:

```powershell
pnpm.cmd --filter @kortix/desktop-electron exec bun test ./src/app-policy.test.js --test-name-pattern "keeps stable desktop identifiers|keeps legacy user data|keeps a packaged development build"
```

Expected: all compatibility tests pass with `com.kortix.desktop`, `kortix://`, and legacy user-data mappings unchanged.

- [ ] **Step 6: Run full verification**

Run:

```powershell
pnpm.cmd --filter @kortix/desktop-electron test
python -c "from pathlib import Path; import yaml; yaml.safe_load(Path('.github/workflows/desktop.yml').read_text(encoding='utf-8')); yaml.safe_load(Path('apps/desktop-electron/electron-builder.yml').read_text(encoding='utf-8')); print('desktop YAML valid')"
pnpm.cmd exec biome check apps/desktop-electron/src/app-policy.test.js apps/desktop-electron/package.json
git diff --check -- .github/workflows/desktop.yml apps/desktop-electron/src/app-policy.test.js apps/desktop-electron/electron-builder.yml apps/desktop-electron/package.json apps/desktop-electron/README.md
```

Expected:

- Node tests `54/54` pass.
- Bun tests `123/123` pass.
- Both YAML files parse successfully.
- Biome and `git diff --check` exit `0`.

Run the upstream-brand residue check:

```powershell
$brandResidue = git grep -n -I -E "kortix-ai/suna|Kortix AI Corp" -- apps/desktop-electron/package.json apps/desktop-electron/electron-builder.yml apps/desktop-electron/README.md
if ($LASTEXITCODE -eq 0) {
  $brandResidue
  throw 'Scoped desktop packaging files still contain upstream ownership metadata'
}
if ($LASTEXITCODE -ne 1) {
  throw "git grep failed with exit code $LASTEXITCODE"
}
Write-Output 'No scoped upstream ownership residue'
```

Expected: exit `0` and output `No scoped upstream ownership residue`.

- [ ] **Step 7: Commit Task 2**

Run:

```powershell
git add -- apps/desktop-electron/src/app-policy.test.js apps/desktop-electron/electron-builder.yml apps/desktop-electron/package.json apps/desktop-electron/README.md
git diff --cached --check
git diff --cached --name-only
git commit -m "fix(desktop): point releases to OpenOPC repository"
```

Expected staged paths before commit:

```text
apps/desktop-electron/README.md
apps/desktop-electron/electron-builder.yml
apps/desktop-electron/package.json
apps/desktop-electron/src/app-policy.test.js
```

- [ ] **Step 8: Verify final branch state without publishing**

Run:

```powershell
git log --oneline --decorate openopc/main..HEAD
git diff --stat openopc/main...HEAD
git status --porcelain=v1 --branch
```

Expected:

- The branch contains the design commit, the implementation-plan commit, and the two implementation commits.
- The implementation diff contains only the five approved implementation paths plus the approved design and plan documents.
- The only unrelated working-tree entry remains the protected untracked `2026-08-01` plan file.
- No push, PR, tag, release, artifact publication, or deployment has occurred.
