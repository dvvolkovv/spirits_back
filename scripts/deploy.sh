#!/usr/bin/env bash
# Git-based deploy for my.linkeon.io.
#
# Prerequisites (one-time setup):
#   - /home/dvolkov/spirits_back is a git repo with origin = git@github.com:dvvolkovv/spirits_back.git
#   - /home/dvolkov/spirits_front_src is a git repo with origin = git@github.com:dvvolkovv/spirits.git
#   - Prod's id_rsa.pub is registered as a Deploy Key in both GitHub repos (read access)
#   - /home/dvolkov/spirits_front/ is the nginx-served dist (output of front build)
#   - pnpm installed via ~/.npm-global (PATH set in ~/.bashrc)
#
# This script:
#   1. Pushes any local changes (so prod can pull them)
#   2. Backend: ssh prod → git pull → npm ci → npm run build → pm2 restart
#   3. Frontend: ssh prod → git pull source → pnpm install → pnpm build → rsync to served dir
#   4. Wait for health endpoint
#   5. Run smoke pipeline (unit + api + browser)
#
# Why git-based: rsync --delete had been wiping .env, public/agent-avatars/
# and other untracked-on-local files. Git-pull only updates tracked files;
# .env and public/ stay untouched on prod permanently.
#
# Env overrides (defaults shown):
#   PROD_HOST     dvolkov@212.113.106.202
#   BACK_PATH     /home/dvolkov/spirits_back
#   FRONT_SRC     /home/dvolkov/spirits_front_src
#   FRONT_SERVED  /home/dvolkov/spirits_front
#   BRANCH        b2b
#   BASE_URL      https://my.linkeon.io
#   SKIP_BUILD    set to 1 to skip build steps (e.g., only sync code + restart)
#   SKIP_SMOKE    set to 1 to skip smoke after deploy
#   SMOKE_ONLY    set to 1 to skip deploy and just run smoke
#   FRONT_ONLY    set to 1 to deploy frontend only
#   BACK_ONLY     set to 1 to deploy backend only

set -uo pipefail

PROD_HOST="${PROD_HOST:-dvolkov@212.113.106.202}"
BACK_PATH="${BACK_PATH:-/home/dvolkov/spirits_back}"
FRONT_SRC="${FRONT_SRC:-/home/dvolkov/spirits_front_src}"
FRONT_SERVED="${FRONT_SERVED:-/home/dvolkov/spirits_front}"
BRANCH="${BRANCH:-b2b}"
BASE_URL="${BASE_URL:-https://my.linkeon.io}"

LOCAL_BACK_DIR="${LOCAL_BACK_DIR:-$HOME/Downloads/spirits_back}"
LOCAL_FRONT_DIR="${LOCAL_FRONT_DIR:-$HOME/Downloads/spirits_front}"

bold()  { printf "\033[1m%s\033[0m\n" "$1"; }
green() { printf "\033[32m%s\033[0m\n" "$1"; }
red()   { printf "\033[31m%s\033[0m\n" "$1"; }

# Wrap ssh — prod's pnpm is in ~/.npm-global which isn't in default non-login PATH.
ssh_prod() {
  ssh "$PROD_HOST" "export PATH=\$HOME/.npm-global/bin:\$PATH; $*"
}

push_local_repo() {
  local dir="$1" name="$2"
  if [[ ! -d "$dir/.git" ]]; then
    red "  $name: $dir is not a git repo, skipping push"
    return
  fi
  cd "$dir"
  if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
    red "  $name: uncommitted local changes — commit them before deploy"
    git status -sb | head -10
    exit 1
  fi
  git push origin "$BRANCH" 2>&1 | tail -3
  cd - >/dev/null
}

deploy_backend() {
  bold "=== BACKEND ==="
  bold "[back 1/3] pushing local commits to origin"
  push_local_repo "$LOCAL_BACK_DIR" "spirits_back"

  bold "[back 2/3] pulling on prod + building + restarting"
  ssh_prod "
    set -e
    cd $BACK_PATH
    git fetch origin
    git reset --hard origin/$BRANCH
    npm ci --no-audit --no-fund 2>&1 | tail -3
    npm run build 2>&1 | tail -3
    pm2 restart linkeon-api 2>&1 | tail -2
  " || { red "  backend deploy failed"; exit 1; }

  bold "[back 3/3] health-wait"
  for i in $(seq 1 30); do
    code=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/webhook/agents" || echo "0")
    if [[ "$code" == "200" ]]; then
      green "  ✓ /webhook/agents = 200 after ${i}s"
      return 0
    fi
    if [[ "$i" == "30" ]]; then
      red "  ✗ backend didn't come up within 30s (last $code)"
      exit 1
    fi
    sleep 1
  done
}

deploy_frontend() {
  bold "=== FRONTEND ==="
  bold "[front 1/2] pushing local commits to origin"
  push_local_repo "$LOCAL_FRONT_DIR" "spirits_front"

  bold "[front 2/2] pulling on prod + building + deploying to nginx dir"
  ssh_prod "
    set -e
    cd $FRONT_SRC
    git fetch origin
    git reset --hard origin/$BRANCH
    echo 'VITE_BACKEND_URL=$BASE_URL' > .env
    pnpm install --frozen-lockfile 2>&1 | tail -3
    pnpm build 2>&1 | tail -3
    rsync -az --delete dist/ $FRONT_SERVED/
  " || { red "  frontend deploy failed"; exit 1; }
  green "  ✓ frontend bundle deployed"
}

run_smoke() {
  bold "=== SMOKE ==="
  cd "$LOCAL_BACK_DIR/tests"
  if bash smoke/run.sh; then
    green "════════════════════════════════════════════════════════════════════"
    green "  ✓ DEPLOY + SMOKE GREEN"
    green "════════════════════════════════════════════════════════════════════"
    return 0
  else
    red "════════════════════════════════════════════════════════════════════"
    red "  ✗ DEPLOY OK BUT SMOKE FAILED — see above"
    red "════════════════════════════════════════════════════════════════════"
    return 1
  fi
}

# ── main ──
if [[ -z "${SMOKE_ONLY:-}" ]]; then
  if [[ -z "${FRONT_ONLY:-}" ]]; then deploy_backend;  fi
  if [[ -z "${BACK_ONLY:-}"  ]]; then deploy_frontend; fi
else
  echo "(SMOKE_ONLY=1 — skipping deploy)"
fi

if [[ -z "${SKIP_SMOKE:-}" ]]; then
  run_smoke || exit 2
else
  echo "(SKIP_SMOKE=1 — done without smoke)"
fi
