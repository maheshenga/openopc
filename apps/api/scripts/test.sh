#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

args=("${1:-default}")
if [ "${COVERAGE:-}" = "1" ]; then
  args+=("--coverage")
fi
exec node scripts/test-runner.mjs "${args[@]}"
