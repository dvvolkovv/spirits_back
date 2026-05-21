#!/usr/bin/env bash
# Git-based deploy for my.linkeon.io — двухфазный пайплайн: test → smoke → prod → smoke.
#
# Prerequisites (one-time setup):
#   - /home/dvolkov/spirits_back is a git repo with origin = git@github.com:dvvolkovv/spirits_back.git
#   - /home/dvolkov/spirits_front_src is a git repo with origin = git@github.com:dvvolkovv/spirits.git
#   - Prod's id_rsa.pub is registered as a Deploy Key in both GitHub repos (read access)
#   - /home/dvolkov/spirits_front/ is the nginx-served dist (output of front build)
#   - pnpm installed via ~/.npm-global (PATH set in ~/.bashrc)
#
# This script:
#   1. Pushes any local changes (so server can pull them)
#   2. Backend: ssh → git pull → npm ci → npm run build → pm2 restart
#   3. Frontend: ssh → git pull source → pnpm install → pnpm build → rsync to served dir
#   4. Wait for health endpoint
#   5. Run smoke pipeline (unit + api + browser)
#   Repeats for both TEST and PROD phases.
#
# Why git-based: rsync --delete had been wiping .env, public/agent-avatars/
# and other untracked-on-local files. Git-pull only updates tracked files;
# .env and public/ stay untouched on server permanently.
#
# Env overrides:
#   PROD_HOST     dvolkov@212.113.106.202
#   BRANCH        b2b
#   SKIP_BUILD    set to 1 to skip build steps (e.g., only sync code + restart)
#   SKIP_SMOKE    set to 1 to skip all smoke
#   SKIP_TEST_SMOKE  set to 1 to skip smoke after test phase
#   SKIP_PROD_SMOKE  set to 1 to skip smoke after prod phase
#   SMOKE_ONLY    set to 1 to skip deploy and just run smoke (both phases)
#   FRONT_ONLY    set to 1 to deploy frontend only
#   BACK_ONLY     set to 1 to deploy backend only
#   TEST_ONLY     set to 1 to deploy test phase only (skip prod)
#   PROD_ONLY     set to 1 to deploy prod phase only (skip test)

set -uo pipefail

# Local creds for test phase (gitignored)
TEST_ENV_FILE="$(dirname "${BASH_SOURCE[0]}")/test-server.env.local"
if [[ -f "$TEST_ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$TEST_ENV_FILE"
fi

PROD_HOST="${PROD_HOST:-dvolkov@212.113.106.202}"
BRANCH="${BRANCH:-b2b}"

LOCAL_BACK_DIR="${LOCAL_BACK_DIR:-$HOME/Downloads/spirits_back}"
LOCAL_FRONT_DIR="${LOCAL_FRONT_DIR:-$HOME/Downloads/spirits_front}"

bold()  { printf "\033[1m%s\033[0m\n" "$1"; }
green() { printf "\033[32m%s\033[0m\n" "$1"; }
red()   { printf "\033[31m%s\033[0m\n" "$1"; }

# Wrap ssh — server's pnpm/node may not be in default non-login PATH.
# Uses $HOST and $PATH_EXPORT set by run_phase().
ssh_remote() {
  ssh "$HOST" "export PATH=$PATH_EXPORT:\$HOME/.npm-global/bin:\$PATH; $*"
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
  bold "=== BACKEND ($ENV_NAME) ==="
  bold "[back 1/3] pushing local commits to origin"
  push_local_repo "$LOCAL_BACK_DIR" "spirits_back"

  bold "[back 2/3] pulling on $ENV_NAME + building + restarting"
  ssh_remote "
    set -e
    cd $BACK_PATH
    git fetch origin
    git reset --hard origin/$BRANCH
    npm ci --no-audit --no-fund 2>&1 | tail -3
    npm run build 2>&1 | tail -3
    pm2 restart linkeon-api 2>&1 | tail -2
    # SMM worker shares the repo but has its own package.json + tsc build.
    # Without this block changes to worker/* never reach the running PM2 process.
    if [ -d worker ]; then
      cd worker
      npm ci --no-audit --no-fund 2>&1 | tail -3
      npm run build 2>&1 | tail -3
      pm2 restart linkeon-smm-worker 2>&1 | tail -2
      cd ..
    fi
  " || { red "  backend deploy failed ($ENV_NAME)"; exit 1; }

  bold "[back 3/3] health-wait"
  for i in $(seq 1 30); do
    code=$(curl -s ${BASIC_AUTH:+-u "$BASIC_AUTH"} -o /dev/null -w "%{http_code}" "${BASE_URL}/webhook/agents" || echo "0")
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
  bold "=== FRONTEND ($ENV_NAME) ==="
  bold "[front 1/2] pushing local commits to origin"
  push_local_repo "$LOCAL_FRONT_DIR" "spirits_front"

  bold "[front 2/2] pulling on $ENV_NAME + building + deploying to nginx dir"
  ssh_remote "
    set -e
    cd $FRONT_SRC
    git fetch origin
    git reset --hard origin/$BRANCH
    echo 'VITE_BACKEND_URL=$BASE_URL' > .env
    pnpm install --frozen-lockfile 2>&1 | tail -3
    pnpm build 2>&1 | tail -3
    rsync -az dist/ $FRONT_SERVED/
  " || { red "  frontend deploy failed ($ENV_NAME)"; exit 1; }
  green "  ✓ frontend bundle deployed ($ENV_NAME)"
}

run_phase() {
  local phase="$1"  # "test" или "prod"
  case "$phase" in
    test)
      ENV_NAME=test
      HOST="${TEST_HOST:?TEST_HOST не задан — заполни scripts/test-server.env.local}"
      PATH_EXPORT='$HOME/.nvm/versions/node/v22*/bin'
      BACK_PATH="$TEST_BACK_PATH"
      FRONT_SRC="$TEST_FRONT_SRC"
      FRONT_SERVED="$TEST_FRONT_SERVED"
      BASE_URL="$TEST_BASE_URL"
      BASIC_AUTH="${TEST_BASIC_AUTH:-}"
      SSH_TARGET="$TEST_HOST"
      ;;
    prod)
      ENV_NAME=prod
      HOST="$PROD_HOST"
      PATH_EXPORT='$HOME/.npm-global/bin'
      BACK_PATH="${PROD_BACK_PATH:-/home/dvolkov/spirits_back}"
      FRONT_SRC="${PROD_FRONT_SRC:-/home/dvolkov/spirits_front_src}"
      FRONT_SERVED="${PROD_FRONT_SERVED:-/home/dvolkov/spirits_front}"
      BASE_URL="${PROD_BASE_URL:-https://my.linkeon.io}"
      BASIC_AUTH=
      SSH_TARGET="$PROD_HOST"
      ;;
  esac
  export ENV_NAME HOST PATH_EXPORT BACK_PATH FRONT_SRC FRONT_SERVED BASE_URL BASIC_AUTH BRANCH SSH_TARGET

  if [[ -z "${SMOKE_ONLY:-}" ]]; then
    if [[ -z "${FRONT_ONLY:-}" ]]; then deploy_backend;  fi
    if [[ -z "${BACK_ONLY:-}"  ]]; then deploy_frontend; fi
  else
    echo "(SMOKE_ONLY=1 — skipping deploy for $ENV_NAME)"
  fi

  # Smoke
  local skip_var="SKIP_${phase^^}_SMOKE"  # SKIP_TEST_SMOKE / SKIP_PROD_SMOKE
  if [[ -z "${SKIP_SMOKE:-}" && -z "${!skip_var:-}" ]]; then
    bold "=== SMOKE ($ENV_NAME) ==="
    cd "$LOCAL_BACK_DIR/tests"
    if BASE_URL="$BASE_URL" BASIC_AUTH="$BASIC_AUTH" SSH_TARGET="$SSH_TARGET" bash smoke/run.sh; then
      green "  ✓ SMOKE GREEN ($ENV_NAME)"
    else
      red "  ✗ SMOKE FAILED ($ENV_NAME)"
      return 1
    fi
  else
    echo "(smoke skipped for $ENV_NAME)"
  fi
}

# ── main ──
if [[ -z "${PROD_ONLY:-}" ]]; then
  bold "════════════ PHASE 1: TEST ════════════"
  run_phase test || { red "TEST phase failed — НЕ КАЧУ НА ПРОД"; exit 1; }
fi

if [[ -z "${TEST_ONLY:-}" ]]; then
  bold "════════════ PHASE 2: PROD ════════════"
  run_phase prod || exit 2
fi

green "════════════════════════════════════════════════════════════════════"
green "  ✓ ALL PHASES GREEN"
green "════════════════════════════════════════════════════════════════════"
