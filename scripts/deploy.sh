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
#                        (работает и для PHASE 3 — проверить лендинг, не катая)
#   WITH_LANDING=1     — добавить PHASE 3: лендинг linkeon.io (land_linkeon)
#   LANDING_ONLY=1     — ТОЛЬКО лендинг, без backend/frontend и без my.linkeon.io
#   NO_ROLLBACK=1      — отключить авто-rollback на проде при smoke failure
#                        (по умолчанию: если PHASE 2 smoke красный — откат
#                         back+front к pre-deploy SHA, restart сервисов)
#   STREAM_DRAIN_SECONDS=N — сколько ждать завершения живых чат-ходов перед
#                        рестартом (default 1800). Рестарт посреди стрима
#                        убивает ответ молча — см. wait_for_streams_drain.
#   FORCE_RESTART=1    — не ждать живые ходы (оборвёт чей-то ответ; только
#                        когда прод лежит и ждать нечего).
#
#   SMOKE_ATTEMPTS=N   — сколько раз прогнать smoke прежде чем считать фазу
#                        красной (default 2). Первый прогон ещё и прогревает
#                        холодные пути; откат только если ВСЕ попытки красные.
#                        Anti-flake: одиночный флейк больше не валит хороший
#                        деплой ложным откатом.
#
# Прод-настройки (можно переопределить через env):
#   PROD_HOST          dvolkov@212.113.106.202
#   PROD_BACK_PATH     /home/dvolkov/spirits_back
#   PROD_FRONT_SRC     /home/dvolkov/spirits_front_src
#   PROD_FRONT_SERVED  /home/dvolkov/spirits_front
#   PROD_BASE_URL      https://my.linkeon.io
#   PROD_LAND_PATH     /home/dvolkov/land_linkeon
#   LAND_BASE_URL      https://linkeon.io
#   BRANCH             main
#
# Why git-based (не rsync): --delete сносил .env, public/agent-avatars/
# и другие untracked-локально файлы. Git-pull обновляет только трекаемое.
#
# PHASE 3 (лендинг linkeon.io) — почему отдельно и почему по умолчанию выключена:
#   * это другой продукт в другом репозитории (land_linkeon), со своим темпом
#     выката. Правка текста на лендинге не должна тянуть за собой pm2 restart
#     API — рестарт посреди живого чат-хода молча убивает чужой ответ;
#   * стенда лендинга на test НЕТ (ни чекаута, ни vhost'а), поэтому у неё одна
#     фаза — прод. Это известная дыра в двухфазности, а не забытый шаг:
#     появится стенд — сюда добавится фаза test;
#   * nginx отдаёт dist/ ПРЯМО из чекаута ($PROD_LAND_PATH/dist), так что
#     сборка на месте и есть выкат — отдельного rsync в served-папку нет.

set -uo pipefail

# Local creds for test phase (gitignored)
TEST_ENV_FILE="$(dirname "${BASH_SOURCE[0]}")/test-server.env.local"
if [[ -f "$TEST_ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$TEST_ENV_FILE"
fi

PROD_HOST="${PROD_HOST:-dvolkov@212.113.106.202}"
BRANCH="${BRANCH:-main}"

# Default to script-relative paths so the script works regardless of
# where the repo is cloned. Override via env if your layout differs.
_BACK_DIR_DEFAULT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_BACK_DIR="${LOCAL_BACK_DIR:-$_BACK_DIR_DEFAULT}"
LOCAL_FRONT_DIR="${LOCAL_FRONT_DIR:-$(dirname "$_BACK_DIR_DEFAULT")/spirits_front}"
LOCAL_LAND_DIR="${LOCAL_LAND_DIR:-$(dirname "$_BACK_DIR_DEFAULT")/land_linkeon}"
PROD_LAND_PATH="${PROD_LAND_PATH:-/home/dvolkov/land_linkeon}"
LAND_BASE_URL="${LAND_BASE_URL:-https://linkeon.io}"

bold()  { printf "\033[1m%s\033[0m\n" "$1"; }
green() { printf "\033[32m%s\033[0m\n" "$1"; }
red()   { printf "\033[31m%s\033[0m\n" "$1"; }

# Wrap ssh — server's pnpm/node may not be in default non-login PATH.
# Uses $HOST and $PATH_EXPORT set by run_phase().
# PATH_EXPORT may contain a glob (e.g. .nvm/versions/node/v22*/bin) — use
# $(echo ...) on the remote to expand it before adding to PATH.
ssh_remote() {
  # Retry on transient SSH connection failures (exit 255: "Connection reset by
  # peer" / "kex_exchange_identification"), which have aborted both deploys and
  # — worse — rollbacks mid-run. The remote commands we run are idempotent
  # (git reset --hard, npm ci, build, rsync, pm2 restart), so re-running after a
  # dropped connection is safe. A non-255 exit (the remote command's own status)
  # is returned immediately and never retried. Warnings go to stderr so callers
  # that capture stdout (e.g. SHA capture) aren't polluted.
  local attempt rc
  for attempt in 1 2 3; do
    ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 -o ServerAliveInterval=15 \
        "$HOST" "export PATH=\$(echo $PATH_EXPORT):\$HOME/.npm-global/bin:\$PATH; $*"
    rc=$?
    [[ $rc -ne 255 ]] && return $rc
    echo "  ! ssh to ${ENV_NAME:-remote} dropped (transient, code 255) — retry $attempt/3" >&2
    sleep $((attempt * 3))
  done
  return 255
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
  # Отказ push — ОСТАНОВКА, а не предупреждение.
  #
  # Раньше результат push игнорировался: вывод уходил в tail, а pipe отдавал
  # код успешного tail. Когда локальная ветка отставала от origin, push
  # отклонялся как non-fast-forward, деплой ехал дальше и выкатывал то, что
  # УЖЕ лежало в origin. Smoke при этом зеленел — сервис ведь жив, — и деплой
  # рапортовал ALL PHASES GREEN, хотя изменений на проде не было.
  local push_log
  if ! push_log=$(git push origin "$BRANCH" 2>&1); then
    red "  $name: push в origin/$BRANCH отклонён — деплой остановлен"
    echo "$push_log" | tail -5
    git status -sb | head -2
    red "  сделайте git pull --rebase и повторите"
    exit 1
  fi
  echo "$push_log" | tail -3
  cd - >/dev/null
}

capture_pre_deploy_state() {
  # Записываем SHA back/front ДО reset --hard, чтобы было куда откатиться
  # при failure smoke. Выводы ssh_remote могут содержать PATH-export строки —
  # вытаскиваем последнюю строку и фильтруем по hex-shape.
  local back_sha front_sha
  back_sha=$(ssh_remote "cd $BACK_PATH && git rev-parse HEAD" 2>/dev/null | tail -1 | tr -d '[:space:]')
  front_sha=$(ssh_remote "cd $FRONT_SRC && git rev-parse HEAD" 2>/dev/null | tail -1 | tr -d '[:space:]')
  if [[ ! "$back_sha" =~ ^[0-9a-f]{40}$ ]]; then
    red "  ! couldn't capture back pre-deploy SHA ($ENV_NAME) — rollback won't work"
    PRE_BACK_SHA=""
  else
    PRE_BACK_SHA="$back_sha"
  fi
  if [[ ! "$front_sha" =~ ^[0-9a-f]{40}$ ]]; then
    red "  ! couldn't capture front pre-deploy SHA ($ENV_NAME) — rollback won't work"
    PRE_FRONT_SHA=""
  else
    PRE_FRONT_SHA="$front_sha"
  fi
  if [[ -n "$PRE_BACK_SHA$PRE_FRONT_SHA" ]]; then
    echo "  ↪ captured pre-deploy state: back=${PRE_BACK_SHA:0:8} front=${PRE_FRONT_SHA:0:8}"
  fi
}

rollback_backend() {
  if [[ -z "${PRE_BACK_SHA:-}" ]]; then
    red "  ✗ NO pre-deploy back SHA — manual rollback required ($ENV_NAME)"
    return 1
  fi
  red "  ↩ rolling back backend ($ENV_NAME) → ${PRE_BACK_SHA:0:8}"
  ssh_remote "
    set -eo pipefail
    cd $BACK_PATH
    git reset --hard $PRE_BACK_SHA
    npm ci --no-audit --no-fund 2>&1 | tail -3
    npm run build 2>&1 | tail -3
    pm2 restart linkeon-api 2>&1 | tail -2
    if [ -d worker ]; then
      cd worker
      npm ci --no-audit --no-fund 2>&1 | tail -3
      npm run build 2>&1 | tail -3
      pm2 restart linkeon-smm-worker 2>&1 | tail -2
      cd ..
    fi
    # Голосовой воркер: свой package.json и своя сборка, как у SMM-воркера.
    # Без этого блока правки voice-host/* не доезжают до живого процесса.
    # Статус проверяем явно, а не через '| tail': в этом блоке действует
    # set -e БЕЗ pipefail, поэтому статус берётся от tail и всегда нулевой —
    # падение сборки проглатывается молча. Первый прогон 25.08.2026 так и
    # прошёл «зелёным» с несобравшимся воркером.
    if [ -d voice-host ]; then
      cd voice-host
      npm ci --no-audit --no-fund > /tmp/vh-install.log 2>&1 \
        || { tail -20 /tmp/vh-install.log; echo 'voice-host: npm ci FAILED'; exit 1; }
      npm run build > /tmp/vh-build.log 2>&1 \
        || { tail -20 /tmp/vh-build.log; echo 'voice-host: build FAILED'; exit 1; }
      pm2 startOrReload ecosystem.config.js 2>&1 | tail -2
      cd ..
    fi
  " && green "  ↩ backend rolled back ($ENV_NAME)" \
    || { red "  ✗ ROLLBACK BACKEND FAILED — $ENV_NAME needs manual intervention"; return 1; }
}

rollback_frontend() {
  if [[ -z "${PRE_FRONT_SHA:-}" ]]; then
    red "  ✗ NO pre-deploy front SHA — manual rollback required ($ENV_NAME)"
    return 1
  fi
  red "  ↩ rolling back frontend ($ENV_NAME) → ${PRE_FRONT_SHA:0:8}"
  ssh_remote "
    set -eo pipefail
    cd $FRONT_SRC
    git reset --hard $PRE_FRONT_SHA
    echo 'VITE_BACKEND_URL=$BASE_URL' > .env
    pnpm install --frozen-lockfile 2>&1 | tail -3
    pnpm build 2>&1 | tail -3
    rsync -az dist/ $FRONT_SERVED/
  " && green "  ↩ frontend rolled back ($ENV_NAME)" \
    || { red "  ✗ ROLLBACK FRONTEND FAILED — $ENV_NAME needs manual intervention"; return 1; }
}

# Откат back+front к captured SHA после smoke failure. Триггерится только
# на проде по умолчанию; отключается NO_ROLLBACK=1. Не откатывает то, что
# не деплоилось (FRONT_ONLY=1 / BACK_ONLY=1 учитываются).
rollback_phase() {
  bold "=== ROLLBACK ($ENV_NAME) ==="
  local rc=0
  if [[ -z "${FRONT_ONLY:-}" ]]; then rollback_backend  || rc=1; fi
  if [[ -z "${BACK_ONLY:-}"  ]]; then rollback_frontend || rc=1; fi
  return "$rc"
}

# Align test-server nginx htpasswd with this machine's TEST_BASIC_AUTH.
# Local scripts/test-server.env.local is gitignored, so two dev machines
# can drift — provision-test.sh on one of them regenerates the password,
# updates the server and that machine's env file, but leaves the other
# machine's file stale. Running this before smoke makes whichever creds
# are in *this* env file authoritative, so smoke's Basic Auth always works.
sync_test_basic_auth() {
  [[ "$ENV_NAME" != "test" ]] && return 0
  [[ -z "${BASIC_AUTH:-}" || "$BASIC_AUTH" != *:* ]] && return 0
  bold "[smoke pre] aligning test htpasswd with local BASIC_AUTH"
  local user="${BASIC_AUTH%%:*}"
  local pass="${BASIC_AUTH#*:}"
  # Пароль подаём через stdin в `htpasswd -i`, НЕ через argv. Прежний вариант
  # (`htpasswd -b '$user' '$pass'` внутри тройной вложенности ssh→sudo→bash -c)
  # молча писал битый хэш → smoke ловил nginx 401 на КАЖДОМ прогоне и валил
  # деплой ложным «регрешном» (debugged 2026-07-10). Заодно секрет больше не
  # светится в списке процессов на сервере. `printf` — builtin, argv не палит.
  local hf=/etc/nginx/.htpasswd-test
  printf '%s' "$pass" | ssh -o StrictHostKeyChecking=accept-new "$HOST" \
    "sudo sh -c 'command -v htpasswd >/dev/null 2>&1 || DEBIAN_FRONTEND=noninteractive apt-get -y install apache2-utils >/dev/null; \
     if [ -f $hf ]; then htpasswd -i $hf $user >/dev/null; else htpasswd -ic $hf $user >/dev/null; fi; \
     systemctl reload nginx'" \
    && green "  ✓ htpasswd synced" \
    || red   "  ! htpasswd sync failed (smoke may still 401)"
}

# Прогрев chat-пути перед smoke (см. вызов в run_phase). После pm2 restart связь
# linkeon-api ↔ r.linkeon.io холодная: первый chat-вызов медленный/падает, ответ
# не успевает сохраниться → smoke-чек custom_chat_history видит 0 строк и валит
# деплой ложно. Здесь: SMS-auth тест-юзера 70000000000 + 2 чата Роману (id=12),
# чтобы разбудить связь и создать свежие строки в БД. Fire-and-forget (|| true).
warm_chat_path() {
  local base="$1" auth="$2"
  local ca=(); [[ -n "$auth" ]] && ca=(-u "$auth")
  local phone=70000000000 code tok
  curl -s ${ca[@]+${ca[@]+"${ca[@]}"}} -m 15 "$base/webhook/898c938d-f094-455c-86af-969617e62f7a/sms/$phone" >/dev/null 2>&1 || return 0
  code=$(curl -s ${ca[@]+${ca[@]+"${ca[@]}"}} -m 15 "$base/webhook/debug/sms-code/$phone" | grep -oE '[0-9]{4,6}' | head -1)
  [[ -z "$code" ]] && return 0
  tok=$(curl -s ${ca[@]+${ca[@]+"${ca[@]}"}} -m 15 "$base/webhook/a376a8ed-3bf7-4f23-aaa5-236eea72871b/check-code/$phone/$code" \
        | sed -n 's/.*"access-token":"\([^"]*\)".*/\1/p')
  [[ -z "$tok" ]] && return 0
  # Прогрев browser-критичных эндпоинтов: ChatInterface не отрендерит кнопку
  # reopen-match (smoke 97/126), пока холодные agents/profile не ответят — на
  # холодном старте это >20с и валит browser-тесты. Будим их заранее.
  curl -s ${ca[@]+"${ca[@]}"} -m 20 "$base/webhook/agents" >/dev/null 2>&1 || true
  curl -s ${ca[@]+"${ca[@]}"} -m 20 "$base/webhook/profile" -H "Authorization: Bearer $tok" >/dev/null 2>&1 || true
  # 1-й чат будит r.linkeon (может быть медленным), 2-й уже тёплый и точно сохранится
  for _ in 1 2; do
    curl -s ${ca[@]+${ca[@]+"${ca[@]}"}} -m 60 -X POST "$base/webhook/soulmate/chat" \
      -H "Authorization: Bearer $tok" -H "Content-Type: application/json" \
      -d '{"chatInput":"deploy warmup","assistant":"12"}' >/dev/null 2>&1 || true
  done
  # Юля/smm_producer (id=15) — ОТДЕЛЬНЫЙ тяжёлый путь (Claude Agent SDK + in-process
  # MCP tools, ветка по agent.name в chat.service), не покрытый прогревом Романа.
  # Холодный первый вызов медленный (>20с) → browser-smoke julia-creator.spec.js
  # падает И его churn роняет соседние render-тесты (per-tab). Root-cause 2026-06-26
  # (backlog ad11a003): warm = зелёно 7/7, cold-after-restart = красно. Будим заранее.
  curl -s ${ca[@]+${ca[@]+"${ca[@]}"}} -m 90 -X POST "$base/webhook/soulmate/chat" \
    -H "Authorization: Bearer $tok" -H "Content-Type: application/json" \
    -d '{"chatInput":"deploy warmup","assistant":"15"}' >/dev/null 2>&1 || true
  green "  ✓ chat+browser+smm paths warmed ($base)"
}

# Ждём, пока на среде не останется чат-ходов в полёте.
#
# pm2 restart посреди стрима убивает ход НАСМЕРТЬ и молча: ответа не появляется
# вовсе (заглушка «попробуйте ещё раз» пишется в persistResponse того же
# процесса), пользователю не показывается ошибка, ретрая нет, в истории остаётся
# его вопрос без ответа. 2026-08-10 20:22 так потеряли ход юриста: выкат пришёл
# через 58 секунд после вопроса на 27 274 символа, релей ещё три минуты доделывал
# работу на ≈$25 в никуда, пользователь ждал полтора часа и не понимал, что
# случилось.
#
# Окно большое (30 минут по умолчанию): ходы юридических ассистентов с фан-аутом
# субагентов идут по 20–25 минут — именно их дороже всего рвать.
#
# Если эндпоинта нет (бэкенд старее этой правки) — не блокируем деплой, иначе
# первый же выкат самой правки стал бы невозможен.
# Голосовые звонки — та же логика, что и для чат-стримов, но своя причина:
# рестарт linkeon-api рвёт мост job'ов (ask → Claude → data-сообщение в комнату),
# и ответ специалиста не приходит молча. Плюс воркер voice-host держит живую
# Realtime-сессию, которая тарифицируется.
#
# Окно короче, чем у стримов: наш собственный потолок звонка — час, а реапер
# добивает зависшие через 70 минут.
wait_for_calls_drain() {
  local max_wait="${CALL_DRAIN_SECONDS:-900}"
  local step=15
  local waited=0
  local n
  while (( waited < max_wait )); do
    n=$(curl -s --max-time 10 ${BASIC_AUTH:+-u "$BASIC_AUTH"} \
          "${BASE_URL}/webhook/voice-call-status/active" \
        | sed -n 's/.*"active"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p')
    # Эндпоинта нет (бэкенд старее этой правки) — не блокируем первый же выкат.
    if [[ -z "$n" ]]; then return 0; fi
    if [[ "$n" == "0" ]]; then return 0; fi
    bold "  ⏳ $ENV_NAME: голосовых звонков в эфире $n — жду (${waited}/${max_wait}s)"
    sleep $step
    waited=$((waited + step))
  done
  red "  ⚠ $ENV_NAME: звонки не завершились за ${max_wait}с — иду дальше"
  return 0
}

wait_for_streams_drain() {
  local max_wait="${STREAM_DRAIN_SECONDS:-1800}"
  local step=15
  local waited=0
  local n
  while (( waited < max_wait )); do
    n=$(curl -s --max-time 10 ${BASIC_AUTH:+-u "$BASIC_AUTH"} \
          "${BASE_URL}/webhook/chat/active-streams" \
        | sed -n 's/.*"active"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p')
    if [[ -z "$n" ]]; then
      red "  ⚠ $ENV_NAME: /webhook/chat/active-streams не ответил числом — жду вслепую нельзя, иду дальше"
      return 0
    fi
    if (( n == 0 )); then
      green "  ✓ $ENV_NAME: живых ходов нет — можно перезапускать"
      return 0
    fi
    bold "  ⏳ $ENV_NAME: ходов в полёте $n — жду (${waited}/${max_wait}s)"
    sleep "$step"
    waited=$(( waited + step ))
  done
  red "  ✗ $ENV_NAME: за ${max_wait}s ходы так и не закончились."
  red "    Рестарт сейчас оборвёт живой ответ. Либо подожди, либо FORCE_RESTART=1."
  return 1
}

deploy_backend() {
  bold "=== BACKEND ($ENV_NAME) ==="
  bold "[back 1/3] pushing local commits to origin"
  push_local_repo "$LOCAL_BACK_DIR" "spirits_back"

  if [[ "${FORCE_RESTART:-0}" == "1" ]]; then
    red "  ⚠ FORCE_RESTART=1 — рестарт без ожидания, живые ходы будут оборваны"
  else
    bold "[back 1.5/3] ожидание завершения живых чат-ходов ($ENV_NAME)"
    wait_for_streams_drain || exit 1
    wait_for_calls_drain || exit 1
  fi

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
    # Голосовой воркер: свой package.json и своя сборка, как у SMM-воркера.
    # Без этого блока правки voice-host/* не доезжают до живого процесса.
    # Статус проверяем явно, а не через '| tail': в этом блоке действует
    # set -e БЕЗ pipefail, поэтому статус берётся от tail и всегда нулевой —
    # падение сборки проглатывается молча. Первый прогон 25.08.2026 так и
    # прошёл «зелёным» с несобравшимся воркером.
    if [ -d voice-host ]; then
      cd voice-host
      npm ci --no-audit --no-fund > /tmp/vh-install.log 2>&1 \
        || { tail -20 /tmp/vh-install.log; echo 'voice-host: npm ci FAILED'; exit 1; }
      npm run build > /tmp/vh-build.log 2>&1 \
        || { tail -20 /tmp/vh-build.log; echo 'voice-host: build FAILED'; exit 1; }
      pm2 startOrReload ecosystem.config.js 2>&1 | tail -2
      cd ..
    fi
  " || { red "  backend deploy failed ($ENV_NAME)"; exit 1; }

  bold "[back 3/3] health-wait"
  # A healthy prod cold boot (NestJS + every module's onModuleInit SQL migrations +
  # Neo4j/Redis reconnect) can legitimately take longer than the old fixed 30s, which
  # false-failed the deploy on a perfectly healthy backend (backlog c5140bad). Poll a
  # generous, env-tunable window instead. Waiting longer only delays detecting a REAL
  # crash — it never turns a broken backend green — so the tradeoff favours the higher bound.
  local max_wait="${HEALTH_WAIT_SECONDS:-90}"
  for (( i=1; i<=max_wait; i++ )); do
    code=$(curl -s ${BASIC_AUTH:+-u "$BASIC_AUTH"} -o /dev/null -w "%{http_code}" "${BASE_URL}/webhook/agents" || echo "0")
    if [[ "$code" == "200" ]]; then
      green "  ✓ /webhook/agents = 200 after ${i}s"
      return 0
    fi
    if (( i == max_wait )); then
      red "  ✗ backend didn't come up within ${max_wait}s (last $code)"
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

# ── PHASE 3: лендинг linkeon.io ───────────────────────────────────────────────
# Отдельный репозиторий land_linkeon, отдельный vhost, отдельный темп выката.
# Подробности «почему отдельно» — в шапке файла.

# SHA лендинга ДО pull — для отката, если smoke красный.
LAND_PRE_SHA=""

deploy_landing() {
  bold "=== LANDING ($LAND_BASE_URL) ==="
  bold "[land 1/2] pushing local commits to origin"
  push_local_repo "$LOCAL_LAND_DIR" "land_linkeon"

  LAND_PRE_SHA=$(ssh_remote "cd $PROD_LAND_PATH && git rev-parse HEAD" 2>/dev/null | tr -d '\r\n')
  if [[ -n "$LAND_PRE_SHA" ]]; then
    echo "  pre-deploy landing SHA: ${LAND_PRE_SHA:0:8}"
  else
    red "  ! не удалось снять pre-deploy SHA лендинга — авто-отката не будет"
  fi

  bold "[land 2/2] pulling on prod + building in place (nginx отдаёт dist/ отсюда же)"
  ssh_remote "
    set -e
    cd $PROD_LAND_PATH
    git fetch origin
    git reset --hard origin/$BRANCH
    pnpm install --frozen-lockfile 2>&1 | tail -3
    pnpm build 2>&1 | tail -3
  " || { red "  landing deploy failed"; exit 1; }
  green "  ✓ landing built and served"
}

rollback_landing() {
  [[ -z "$LAND_PRE_SHA" ]] && { red "  ✗ отката нет: pre-deploy SHA не снят"; return 1; }
  red "  ↩ откатываю лендинг на ${LAND_PRE_SHA:0:8}"
  ssh_remote "
    set -e
    cd $PROD_LAND_PATH
    git reset --hard $LAND_PRE_SHA
    pnpm install --frozen-lockfile 2>&1 | tail -2
    pnpm build 2>&1 | tail -2
  " || { red "  ✗ откат лендинга не удался — чинить руками"; return 1; }
  green "  ✓ лендинг откачен на ${LAND_PRE_SHA:0:8}"
}

# Smoke лендинга.
#
# КОД ОТВЕТА ЗДЕСЬ НИЧЕГО НЕ ЗНАЧИТ: в vhost'е стоит `try_files $uri $uri/
# /index.html`, поэтому ЛЮБОЙ путь отдаёт 200 с html — в том числе
# несуществующий и в том числе языковой каталог, которого не собралось.
# Поэтому каждая проверка смотрит на СОДЕРЖИМОЕ, а не на статус.
smoke_landing() {
  bold "=== SMOKE (landing) ==="
  local fails=0 body

  # 1. Корень отдаёт непустой пререндер. Пустой <div id="root"></div> —
  #    это «сборка прошла, пререндер отвалился»: страница внешне жива, а
  #    краулер видит пустоту.
  body=$(curl -fsS --max-time 20 "$LAND_BASE_URL/" 2>/dev/null)
  if [[ -z "$body" ]]; then
    red "  ✗ $LAND_BASE_URL/ не ответил"; fails=$((fails+1))
  else
    if grep -q '<div id="root"></div>' <<<"$body"; then
      red "  ✗ пререндер пуст: <div id=\"root\"></div> без содержимого"; fails=$((fails+1))
    else
      green "  ✓ корень отдаёт пререндеренный html"
    fi
    if ! grep -qE '<h1[^>]*>.{10,}' <<<"$body"; then
      red "  ✗ на корне нет непустого <h1>"; fails=$((fails+1))
    else
      green "  ✓ <h1> на месте"
    fi
  fi

  # 2. Каждая языковая версия отдаёт СВОЙ язык. Именно здесь ловится
  #    SPA-фолбэк: без этой проверки /de/ вернул бы русский index.html
  #    со статусом 200 и выглядел бы «зелёным».
  local code path lang_ok=1
  for code in $(ssh_remote "ls -d $PROD_LAND_PATH/dist/*/ 2>/dev/null | xargs -n1 basename" 2>/dev/null | grep -E '^[a-z]{2}$'); do
    path="/$code/"
    body=$(curl -fsS --max-time 20 "$LAND_BASE_URL$path" 2>/dev/null)
    if ! grep -q "<html lang=\"$code\"" <<<"$body"; then
      red "  ✗ $path отдаёт не $code (SPA-фолбэк или потерянная локаль)"
      lang_ok=0; fails=$((fails+1))
    fi
  done
  [[ $lang_ok -eq 1 ]] && green "  ✓ языковые версии отдают свой <html lang>"

  # 3. sitemap: настоящий xml, а не подсунутый index.html.
  body=$(curl -fsS --max-time 20 "$LAND_BASE_URL/sitemap.xml" 2>/dev/null)
  if grep -q "<loc>$LAND_BASE_URL/</loc>" <<<"$body"; then
    green "  ✓ sitemap.xml отдаётся и содержит корень"
  else
    red "  ✗ sitemap.xml пуст, не xml или без корневого <loc>"; fails=$((fails+1))
  fi

  if [[ $fails -eq 0 ]]; then
    green "  ✓ SMOKE GREEN (landing)"
    return 0
  fi
  red "  ✗ SMOKE FAILED (landing) — $fails проверок красных"
  return 1
}

run_landing_phase() {
  ENV_NAME=landing
  HOST="$PROD_HOST"
  PATH_EXPORT='$HOME/.npm-global/bin'
  export ENV_NAME HOST PATH_EXPORT

  if [[ -z "${SMOKE_ONLY:-}" ]]; then
    deploy_landing
  else
    echo "(SMOKE_ONLY=1 — лендинг не катим, только smoke)"
  fi

  if [[ -n "${SKIP_SMOKE:-}" ]]; then
    echo "(smoke skipped for landing)"
    return 0
  fi

  smoke_landing && return 0

  if [[ -z "${NO_ROLLBACK:-}" && -z "${SMOKE_ONLY:-}" ]]; then
    rollback_landing || red "  ✗ откат лендинга прошёл частично — проверить руками"
    smoke_landing && red "  ↩ откат вернул лендинг в рабочее состояние" \
                  || red "  ✗ лендинг красный и ПОСЛЕ отката — чинить руками"
  fi
  return 1
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
      PG_DSN="${TEST_PG_DSN:-}"
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
      PG_DSN=  # smoke.js имеет default для прода
      ;;
  esac
  export ENV_NAME HOST PATH_EXPORT BACK_PATH FRONT_SRC FRONT_SERVED BASE_URL BASIC_AUTH BRANCH SSH_TARGET PG_DSN

  if [[ -z "${SMOKE_ONLY:-}" ]]; then
    # Capture pre-deploy state on prod (по умолчанию) для авто-rollback'а
    # при smoke failure. NO_ROLLBACK=1 отключает.
    if [[ "$phase" == "prod" && -z "${NO_ROLLBACK:-}" ]]; then
      capture_pre_deploy_state
    fi
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
    sync_test_basic_auth
    bold "=== SMOKE ($ENV_NAME) ==="
    # Прогрев chat-пути ПОСЛЕ рестарта и ДО smoke: связь с r.linkeon.io холодная
    # сразу после pm2 restart, первый chat-вызов медленный/фейлит → smoke-чек
    # "custom_chat_history persisted" видит 0 строк и валит хороший деплой
    # (стабильный ложный rollback, 2026-06-10). Будим связь и создаём свежие
    # строки в БД до проверки. Не критично к успеху — || true.
    warm_chat_path "$BASE_URL" "$BASIC_AUTH" || true
    cd "$LOCAL_BACK_DIR/tests"
    # Smoke can flake on transient cold paths right after a restart (LLM /
    # r.linkeon.io latency, Neo4j driver reconnect → "Failed to fetch"/timeout).
    # A single flaky run used to trigger a FALSE rollback of a good deploy,
    # which is why these tests stopped being trustworthy. Run up to
    # SMOKE_ATTEMPTS times (default 2): the first run also warms the app, so a
    # transient flake clears on the next attempt. Roll back ONLY when EVERY
    # attempt is red — that is a real, reproducible regression.
    local max_attempts="${SMOKE_ATTEMPTS:-2}"
    local smoke_ok=0 attempt
    for attempt in $(seq 1 "$max_attempts"); do
      if [[ $attempt -gt 1 ]]; then
        bold "  ↻ smoke flaked — retry $attempt/$max_attempts ($ENV_NAME); the app is now warm from attempt $((attempt-1))"
        # 20s gap (not 5): transient infra/network blips (slow page.goto, upstream
        # 4xx/5xx, test-server hiccup) often last 10–20s — a too-tight retry lands
        # inside the same blip and false-fails. SMOKE_RETRY_GAP overrides.
        sleep "${SMOKE_RETRY_GAP:-20}"
      fi
      if BASE_URL="$BASE_URL" BASIC_AUTH="$BASIC_AUTH" SSH_TARGET="$SSH_TARGET" PG_DSN="$PG_DSN" bash smoke/run.sh; then
        smoke_ok=1; break
      fi
    done
    if [[ $smoke_ok -eq 1 ]]; then
      if [[ $attempt -gt 1 ]]; then green "  ✓ SMOKE GREEN ($ENV_NAME) — passed on attempt $attempt (attempt 1 was a flake)"
      else green "  ✓ SMOKE GREEN ($ENV_NAME)"; fi
    else
      red "  ✗ SMOKE FAILED ($ENV_NAME) — red on all $max_attempts attempts (real regression, not a flake)"
      if [[ "$phase" == "prod" && -z "${NO_ROLLBACK:-}" && -z "${SMOKE_ONLY:-}" ]]; then
        rollback_phase || red "  ✗ rollback had partial failures — check $ENV_NAME manually"
      fi
      return 1
    fi
  else
    echo "(smoke skipped for $ENV_NAME)"
  fi
}

# ── main ──
if [[ -z "${PROD_ONLY:-}" && -z "${LANDING_ONLY:-}" ]]; then
  bold "════════════ PHASE 1: TEST ════════════"
  run_phase test || { red "TEST phase failed — НЕ КАЧУ НА ПРОД"; exit 1; }
fi

if [[ -z "${TEST_ONLY:-}" && -z "${LANDING_ONLY:-}" ]]; then
  bold "════════════ PHASE 2: PROD ════════════"
  run_phase prod || exit 2
fi

if [[ -n "${LANDING_ONLY:-}" || -n "${WITH_LANDING:-}" ]]; then
  bold "════════════ PHASE 3: LANDING ════════════"
  run_landing_phase || exit 3
fi

green "════════════════════════════════════════════════════════════════════"
green "  ✓ ALL PHASES GREEN"
green "════════════════════════════════════════════════════════════════════"
