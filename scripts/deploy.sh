#!/usr/bin/env bash
# Двухфазный деплой my.linkeon.io.
#
# PHASE 1 (test):  push origin → ssh test → git pull → build → pm2 restart → smoke
# PHASE 2 (prod):  то же на проде. Запускается ТОЛЬКО если PHASE 1 зелёная.
#
# Креды test-сервера лежат в scripts/test-server.env.local (gitignored,
# создаётся scripts/provision-test.sh — там же установка всего стека на test).
#
# Prerequisites (one-time, для test делает provision-test.sh; для прода — вручную):
#   - на сервере git-репо $BACK_PATH (origin=spirits_back) и $FRONT_SRC (origin=spirits)
#   - server's pubkey зарегистрирован как Deploy Key в обоих GitHub-репо (read-only)
#   - $FRONT_SERVED — отдельная папка под Nginx, туда rsync'ается dist/
#   - node+pm2 установлены (на проде — ~/.npm-global; на тесте — nvm)
#
# Env флаги:
#   TEST_ONLY=1        — только PHASE 1
#   PROD_ONLY=1        — только PHASE 2 (hotfix в обход test, использовать осторожно)
#   FRONT_ONLY=1       — пропустить backend в обеих фазах
#   BACK_ONLY=1        — пропустить frontend в обеих фазах
#   SKIP_SMOKE=1       — пропустить обе smoke-проверки
#   SKIP_TEST_SMOKE=1  — задеплоить на test без smoke (потом обычный прод-деплой + его smoke)
#   SKIP_PROD_SMOKE=1  — на проде задеплоить без smoke
#   SMOKE_ONLY=1       — пропустить деплой, гонять только smoke текущей фазы
#
# Прод-настройки (можно переопределить через env):
#   PROD_HOST          dvolkov@212.113.106.202
#   PROD_BACK_PATH     /home/dvolkov/spirits_back
#   PROD_FRONT_SRC     /home/dvolkov/spirits_front_src
#   PROD_FRONT_SERVED  /home/dvolkov/spirits_front
#   PROD_BASE_URL      https://my.linkeon.io
#   BRANCH             b2b
#
# Why git-based (не rsync): --delete сносил .env, public/agent-avatars/
# и другие untracked-локально файлы. Git-pull обновляет только трекаемое.

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
# PATH_EXPORT may contain a glob (e.g. .nvm/versions/node/v22*/bin) — use
# $(echo ...) on the remote to expand it before adding to PATH.
ssh_remote() {
  ssh "$HOST" "export PATH=\$(echo $PATH_EXPORT):\$HOME/.npm-global/bin:\$PATH; $*"
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
  local phase_upper
  phase_upper="$(echo "$phase" | tr '[:lower:]' '[:upper:]')"
  local skip_var="SKIP_${phase_upper}_SMOKE"  # SKIP_TEST_SMOKE / SKIP_PROD_SMOKE
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
