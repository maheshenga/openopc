#!/usr/bin/env bash
# Publish the npm package in the current working directory, in lockstep with the
# platform release version ($VERSION). Builds dist/, stages the published
# manifest (dist-pointing entrypoints + pinned workspace deps + version lock),
# dry-packs it, and publishes idempotently.
#
# Auth uses Trusted Publishing (OIDC) by default when the job grants id-token.
# A package's first publication may opt into NPM_TOKEN_BOOTSTRAP=1 so an
# explicitly supplied token can create the package before its npm Trusted
# Publisher is configured. With neither auth path, the script normally skips
# cleanly; a hard dependency can set REQUIRED_PUBLISH=1 to make missing auth
# fail the release. Re-running the same release is a no-op (it skips a version
# already on npm rather than hard-failing on E409).
#
# Run from the package directory with VERSION (and optionally NODE_AUTH_TOKEN) in
# the environment:
#
#   VERSION=1.2.3 bash ../../scripts/publish-npm-package.sh
#
set -euo pipefail

: "${VERSION:?VERSION env is required}"

# Trusted Publishing (OIDC) requires npm >= 11.5.1; node 22 ships npm 10.
npm install -g npm@latest
echo "npm $(npm --version)"

# Publish only if SOME auth path is available: OIDC (id-token granted →
# ACTIONS_ID_TOKEN_REQUEST_URL set) or a fallback automation token.
if [ -z "${NODE_AUTH_TOKEN:-}" ] && [ -z "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ]; then
  if [ "${REQUIRED_PUBLISH:-}" = "1" ]; then
    echo "::error::No npm auth is available for required package publication. Configure NPM_TOKEN or Trusted Publishing."
    exit 1
  fi
  echo "::warning::No npm auth (no OIDC, no NPM_TOKEN) — skipping publish."
  exit 0
fi

name="$(node -p "require('./package.json').name")"

# npm 11/12 selects GitHub OIDC when the Actions token-request variables are
# present, even when setup-node has also provided an NPM_TOKEN. Keep that
# default for established packages so provenance is retained; only a package
# explicitly opting into bootstrap overrides the OIDC variables.
npm_with_selected_auth() {
  if [ "${NPM_TOKEN_BOOTSTRAP:-}" = "1" ]; then
    if [ -z "${NODE_AUTH_TOKEN:-}" ]; then
      echo "::error::NPM_TOKEN_BOOTSTRAP=1 requires NODE_AUTH_TOKEN."
      return 1
    fi
    env -u ACTIONS_ID_TOKEN_REQUEST_URL -u ACTIONS_ID_TOKEN_REQUEST_TOKEN npm "$@"
  else
    npm "$@"
  fi
}

# npm Trusted Publishing must be configured in npmjs.com after a package exists.
# For a brand-new package, make an OIDC-only release fail before it builds or
# stages a manifest, with an actionable message instead of an opaque publish
# failure. When a token is available, select it only for that first publication;
# once the package exists, the normal OIDC path remains the default.
if [ "${NPM_OIDC_BOOTSTRAP_CHECK:-}" = "1" ]; then
  if [ -z "${NODE_AUTH_TOKEN:-}" ]; then
    if ! npm view "${name}" version >/dev/null 2>&1; then
      echo "::error::${name} is not published yet. Bootstrap it once with NPM_TOKEN, then configure its Trusted Publisher before using OIDC-only releases."
      exit 1
    fi
  elif ! npm view "${name}" version >/dev/null 2>&1; then
    export NPM_TOKEN_BOOTSTRAP=1
    echo "::notice::${name} is not published yet; using NPM_TOKEN for the one-time bootstrap publication."
  fi
fi

echo "Building ${name}@${VERSION}"
# Prefer build:bundles when the package declares one (today: @kortix/sdk,
# which also emits the tsup browser bundles — dist/kortix.esm.min.js and
# dist/kortix.global.js — that publishConfig.browser/unpkg/jsdelivr point at.
# stage-npm-publish.mjs promotes those fields and then verifies they exist in
# dist/, so they must be built before it runs, not just before `npm publish`
# (whose prepublishOnly lifecycle script fires too late for that check).
# Packages with no CDN bundle (@kortix/intelligence-contracts,
# @kortix/llm-catalog, @kortix/executor-sdk) have no build:bundles script and
# fall back to the plain build unchanged.
if node -e "process.exit(require('./package.json').scripts?.['build:bundles'] ? 0 : 1)"; then
  bun run build:bundles
else
  bun run build
fi

# stage-npm-publish.mjs rewrites package.json in place. Keep the checkout clean
# for local invocations and for every early exit after staging (including an
# idempotent version skip).
manifest_backup="$(mktemp)"
cp package.json "${manifest_backup}"
restore_manifest() {
  cp "${manifest_backup}" package.json
  rm -f "${manifest_backup}"
}
trap restore_manifest EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Stage the manifest npm actually publishes (dist entrypoints, pinned workspace
# deps, version lock) from the package's own publishConfig, and verify dist/.
VERSION="$VERSION" node ../../scripts/stage-npm-publish.mjs

npm pack --dry-run

# Idempotent: a re-run of the same release must not hard-fail on E409.
if npm_with_selected_auth view "${name}@${VERSION}" version >/dev/null 2>&1; then
  echo "${name}@${VERSION} already on npm — skipping (idempotent re-run)."
  exit 0
fi

# An explicit token wins for bootstrap and fallback publication; otherwise npm
# publishes through the configured Trusted Publisher (OIDC + provenance).
npm_with_selected_auth publish
echo "Published ${name}@${VERSION} ✅"
