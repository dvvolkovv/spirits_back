#!/usr/bin/env bash
# Smoke runner — unit, then API+DB, then browser. Fail-fast.
# Use: bash tests/smoke/run.sh [layer]
#   layer = unit | api | browser | all (default)
#
# Env: BASE_URL (default https://my.linkeon.io), TEST_PHONE (default 70000000000)

set -uo pipefail

LAYER="${1:-all}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BASE_URL="${BASE_URL:-https://my.linkeon.io}"
TEST_PHONE="${TEST_PHONE:-70000000000}"

print_header() {
  echo
  echo "════════════════════════════════════════════════════════════════════"
  echo "  $1"
  echo "════════════════════════════════════════════════════════════════════"
}

FAILED=0

if [[ "$LAYER" == "unit" || "$LAYER" == "all" ]]; then
  print_header "LAYER 1/3 — Backend unit tests (Jest)"
  if ! npx jest unit/ --silent; then
    echo "  ✗ unit failed"
    FAILED=1
  fi
fi

if [[ "$LAYER" == "api" || "$LAYER" == "all" ]]; then
  print_header "LAYER 2/3 — API + DB smoke (Node)"
  if ! BASE_URL="$BASE_URL" TEST_PHONE="$TEST_PHONE" node smoke/smoke.js; then
    echo "  ✗ api/db failed"
    FAILED=1
  fi
fi

if [[ "$LAYER" == "browser" || "$LAYER" == "all" ]]; then
  print_header "LAYER 3/3 — Browser smoke (Playwright)"
  if ! BASE_URL="$BASE_URL" TEST_PHONE="$TEST_PHONE" \
       npx playwright test --config=playwright/playwright.config.js --reporter=list; then
    echo "  ✗ browser failed"
    FAILED=1
  fi
fi

echo
if [[ $FAILED -eq 0 ]]; then
  echo "════════════════════════════════════════════════════════════════════"
  echo "  ✓ ALL SMOKE LAYERS GREEN"
  echo "════════════════════════════════════════════════════════════════════"
  exit 0
else
  echo "════════════════════════════════════════════════════════════════════"
  echo "  ✗ SMOKE FAILURES — see above"
  echo "════════════════════════════════════════════════════════════════════"
  exit 1
fi
