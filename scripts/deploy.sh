#!/usr/bin/env bash
# Full deploy + smoke pipeline for my.linkeon.io.
#
#   1. Build frontend (spirits_front)
#   2. rsync frontend dist → prod
#   3. rsync backend source → prod (excludes node_modules / dist / .git)
#   4. SSH: npm run build && pm2 restart linkeon-api
#   5. Wait for /webhook/agents health (≤30s)
#   6. Run smoke: unit → api → browser
#
# Env overrides:
#   FRONT_DIR    default ~/Downloads/spirits_front
#   BACK_DIR     default ~/Downloads/spirits_back
#   PROD_HOST    default dvolkov@212.113.106.202
#   FRONT_PATH   default /home/dvolkov/spirits_front
#   BACK_PATH    default /home/dvolkov/spirits_back
#   BASE_URL     default https://my.linkeon.io
#   SKIP_SMOKE   set to 1 to skip the smoke stage
#   SMOKE_ONLY   set to 1 to skip build+deploy, only run smoke
#
# Run: bash scripts/deploy.sh

set -uo pipefail

FRONT_DIR="${FRONT_DIR:-$HOME/Downloads/spirits_front}"
BACK_DIR="${BACK_DIR:-$HOME/Downloads/spirits_back}"
PROD_HOST="${PROD_HOST:-dvolkov@212.113.106.202}"
FRONT_PATH="${FRONT_PATH:-/home/dvolkov/spirits_front}"
BACK_PATH="${BACK_PATH:-/home/dvolkov/spirits_back}"
BASE_URL="${BASE_URL:-https://my.linkeon.io}"

bold()  { printf "\033[1m%s\033[0m\n" "$1"; }
green() { printf "\033[32m%s\033[0m\n" "$1"; }
red()   { printf "\033[31m%s\033[0m\n" "$1"; }

if [[ -z "${SMOKE_ONLY:-}" ]]; then
  bold "1/6 Building frontend"
  cd "$FRONT_DIR"
  echo "VITE_BACKEND_URL=${BASE_URL}" > .env
  pnpm build || { red "frontend build failed"; exit 1; }

  bold "2/6 Deploying frontend to ${PROD_HOST}:${FRONT_PATH}"
  rsync -az --delete --timeout=30 "$FRONT_DIR/dist/" "${PROD_HOST}:${FRONT_PATH}/" || { red "frontend rsync failed"; exit 1; }

  bold "3/6 Syncing backend source to ${PROD_HOST}:${BACK_PATH}"
  rsync -az --timeout=30 \
    --exclude='.git/' --exclude='node_modules/' --exclude='dist/' \
    --exclude='tests/node_modules/' --exclude='public/generated/' \
    "$BACK_DIR/" "${PROD_HOST}:${BACK_PATH}/" || { red "backend rsync failed"; exit 1; }

  bold "4/6 Building + restarting backend on prod"
  ssh "$PROD_HOST" "cd $BACK_PATH && npm run build && pm2 restart linkeon-api" \
    || { red "build/restart failed"; exit 1; }

  bold "5/6 Waiting for backend health"
  for i in $(seq 1 30); do
    code=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/webhook/agents" || echo "0")
    if [[ "$code" == "200" ]]; then
      green "  ✓ /webhook/agents returns 200 after ${i}s"
      break
    fi
    if [[ "$i" == "30" ]]; then
      red "  ✗ backend didn't come up within 30s (last code: $code)"
      exit 1
    fi
    sleep 1
  done
else
  echo "(SMOKE_ONLY=1 — skipping build/deploy)"
fi

if [[ -z "${SKIP_SMOKE:-}" ]]; then
  bold "6/6 Running smoke tests"
  cd "$BACK_DIR/tests"
  if bash smoke/run.sh; then
    green "════════════════════════════════════════════════════════════════════"
    green "  ✓ DEPLOY + SMOKE GREEN"
    green "════════════════════════════════════════════════════════════════════"
    exit 0
  else
    red "════════════════════════════════════════════════════════════════════"
    red "  ✗ DEPLOY OK BUT SMOKE FAILED — see above"
    red "════════════════════════════════════════════════════════════════════"
    exit 2
  fi
else
  echo "(SKIP_SMOKE=1 — done without smoke)"
  exit 0
fi
