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
#
#   SKIP_PRODUCTS_HOST=1   — пропустить PHASE 4 (хостовые части продуктов).
#                        PHASE 4 входит в выкат ПО УМОЛЧАНИЮ — ровно потому,
#                        что раньше не входила и молча отставала.
#   PRODUCTS_HOST_ONLY=1   — ТОЛЬКО PHASE 4 (повтор после того, как агент
#                        освободился; см. «занятый агент» в шапке фазы).
#                        Локальный HEAD при этом роли не играет: на машину
#                        продуктов едет коммит, выкаченный на проде.
#   PRODUCTS_HOST=метка|цель — ОГРАНИЧИТЬ фазу ОДНОЙ машиной реестра. Умолчания
#                        больше НЕТ: список машин целиком берётся из
#                        product_hosts на проде, и обойти фаза обязана все.
#                        Значение сверяется с реестром (метка 'own' или
#                        ssh-цель 'root@1.2.3.4'); машины, которой в реестре
#                        нет, фаза не тронет — зону и метку взять неоткуда,
#                        а выкат «куда попало» на машину с боевыми продуктами
#                        и есть то, что фаза предотвращает.
#                        Имя переменной то же, что у product-provision.sh и
#                        product-backup-setup.sh, — экспортированное ради них
#                        значение сузит и эту фазу, поэтому ограничение
#                        печатается крупно.
#   PRODUCTS_HOST_CHECK_ONLY=1 — фаза только СМОТРИТ и докладывает расхождение,
#                        на машину не пишет ничего. SMOKE_ONLY=1 включает этот
#                        режим сам (SMOKE_ONLY означает «не катить»).
#   PRODUCTS_HOST_WAIT_SECONDS=N — сколько ждать, пока агент хоста освободится
#                        (default 900). Сторож занятости НЕ продавливается.
#   PRODUCTS_HOST_WATCH_SECONDS=N — окно наблюдения за опросами живого агента,
#                        когда переустанавливать нечего (default 20).
#
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
#   PROD_NGINX_CONF    /etc/nginx/sites-enabled/spirits (живой файл, НЕ симлинк —
#                      sites-available/spirits на проде устарел и не действует)
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
#
# PHASE 4 (хостовые части продуктов) — почему НОМЕР 4, а идёт ДО третьей.
#   Порядок в main: 1 (test) → 2 (prod) → 4 (products host) → 3 (landing).
#   Номер отражает время появления, а не место в очереди, и переименовывать
#   PHASE 3 нельзя: на это имя ссылаются LANDING_ONLY, раннбуки и заметки.
#   Место же выбрано по делу: лендинг — посторонний продукт в чужом
#   репозитории, и ставить от него в зависимость выкат машины продуктов
#   значило бы завести НОВЫЙ способ молча не выкатиться (красный смоук
#   лендинга уводит скрипт в exit 3 и пропустил бы фазу 4 целиком). В обычном
#   прогоне лендинга нет вовсе, и порядок читается как 1 → 2 → 4.
#   Подробности «что это, почему после прода и почему её падение не откатывает
#   my.linkeon.io» — в шапке run_products_host_phase.

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
# Машины продуктов (PHASE 4) берутся ИЗ РЕЕСТРА НА ПРОДЕ, а не отсюда: с куска
# 4а их несколько, и список живёт в product_hosts. PRODUCTS_HOST остался, но
# сменил смысл — теперь это ФИЛЬТР «только эта машина», и умолчания у него нет.
#
# Умолчание `root@139.59.210.42` убрано СОЗНАТЕЛЬНО: оставленное, оно означало
# бы выкат ровно на одну машину при живых нескольких — то есть частичное
# расхождение, которое потом ищут руками. Пустое значение = «все машины
# реестра».
PRODUCTS_HOST="${PRODUCTS_HOST:-}"

bold()  { printf "\033[1m%s\033[0m\n" "$1"; }
green() { printf "\033[32m%s\033[0m\n" "$1"; }
red()   { printf "\033[31m%s\033[0m\n" "$1"; }

# ⚠ ПЕРЕМЕННАЯ ВПЛОТНУЮ ПЕРЕД НЕЛАТИНСКИМ СИМВОЛОМ — ТОЛЬКО В ФИГУРНЫХ СКОБКАХ.
#
# Тексты здесь русские, а bash 3.2 (это /bin/bash на маке, откуда deploy.sh и
# запускают) при LANG=*.UTF-8 приклеивает к имени переменной первый байт
# следующего многобайтового символа. Строка вида «машина ёлочка-доллар-PH_ID-
# ёлочка» разбирается как имя `PH_ID` плюс половина закрывающей кавычки, и
# `set -u` валит скрипт «PH_ID?: unbound variable» ПОСРЕДИ ФАЗЫ. При LANG=C та
# же строка работает, поэтому в чужом терминале это не воспроизводится вовсе.
# Пишется `«${PH_ID}»`. Проверка на весь файл (исправный даёт ноль строк):
#   LC_ALL=C grep -nP '\$[A-Za-z_][A-Za-z0-9_]*[\x80-\xff]' scripts/deploy.sh

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
  # Проверка чистоты нужна для КОДА: серверы встают на origin/main жёстко, и
  # незакоммиченная правка просто не поедет — про это и предупреждение.
  #
  # docs/ из неё исключены: туда ничего не выкатывается вообще. Репозиторий
  # общий и параллельные сессии пишут в docs/ свои спеки прямо во время
  # работы; из-за чужого черновика деплой вставал, а вычищать его — значит
  # рвать чужой текст из-под работающей сессии (27.08.2026).
  local dirty
  dirty="$(git status --porcelain 2>/dev/null | grep -vE '^.. docs/' || true)"
  if [[ -n "$dirty" ]]; then
    red "  $name: uncommitted local changes — commit them before deploy"
    echo "$dirty" | head -10
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
    # Пропускаем там, где нет LiveKit: на тест-стенде SFU не развёрнут вовсе
    # (ни контейнера, ни порта 7880, ни ключей в .env), и поднятый воркер
    # уходит в бесконечный цикл падений. Признак настроенности — свой .env
    # подпроекта: он создаётся руками вместе с ключами LiveKit.
    if [ -d voice-host ] && [ -f voice-host/.env ]; then
      cd voice-host
      npm ci --no-audit --no-fund > /tmp/vh-install.log 2>&1 \
        || { tail -20 /tmp/vh-install.log; echo 'voice-host: npm ci FAILED'; exit 1; }
      npm run build > /tmp/vh-build.log 2>&1 \
        || { tail -20 /tmp/vh-build.log; echo 'voice-host: build FAILED'; exit 1; }
      pm2 startOrReload ecosystem.config.cjs > /tmp/vh-pm2.log 2>&1 \
        || { tail -20 /tmp/vh-pm2.log; echo 'voice-host: pm2 startOrReload FAILED'; exit 1; }
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
  # Прогрев browser-критичных эндпоинтов: ChatInterface не отрендерит шапку
  # чата (переключатель ассистента), пока холодные agents/profile не ответят —
  # на холодном старте это >20с и валит browser-тесты. Будим их заранее.
  curl -s ${ca[@]+"${ca[@]}"} -m 20 "$base/webhook/agents" >/dev/null 2>&1 || true
  curl -s ${ca[@]+"${ca[@]}"} -m 20 "$base/webhook/profile" -H "Authorization: Bearer $tok" >/dev/null 2>&1 || true
  # fresh+probe у прогрева — не оптимизация «на всякий случай», а починка.
  # Без них ход уезжал в ПОСТОЯННУЮ сессию релея (70000000000_12_ru), которая
  # копится неделями: релей перечитывал её кеш целиком, и ответ «ок» из двух
  # символов стоил $5.14 при ~1 млн взвешенных токенов (замер 28.08.2026,
  # metadata списаний: costUsd=5.1402, replyChars=2). Тот же пинг в смоуке —
  # с fresh+probe — стоит $0.02, потому что идёт в изолированную сессию и на
  # haiku. Прогреву качество ответа не нужно вовсе: он будит путь.
  #
  # freshTs обязан быть ≥6 цифр, иначе контроллер молча проигнорирует fresh и
  # ход снова уедет в постоянную сессию (chat.controller.ts).
  local fts
  fts=$(date +%s)
  for _ in 1 2; do
    curl -s ${ca[@]+${ca[@]+"${ca[@]}"}} -m 60 -X POST "$base/webhook/soulmate/chat" \
      -H "Authorization: Bearer $tok" -H "Content-Type: application/json" \
      -d "{\"chatInput\":\"deploy warmup\",\"assistant\":\"12\",\"fresh\":true,\"freshTs\":\"$fts\",\"probe\":true}" >/dev/null 2>&1 || true
  done
  # Юля/smm_producer (id=15) — ОТДЕЛЬНЫЙ тяжёлый путь (Claude Agent SDK + in-process
  # MCP tools, ветка по agent.name в chat.service), не покрытый прогревом Романа.
  # Холодный первый вызов медленный (>20с) → browser-smoke julia-creator.spec.js
  # падает И его churn роняет соседние render-тесты (per-tab). Root-cause 2026-06-26
  # (backlog ad11a003): warm = зелёно 7/7, cold-after-restart = красно. Будим заранее.
  #
  # Здесь fresh есть, а probe НЕТ — намеренно. Путь Юли идёт через
  # claudeAgent.streamSmmProducer (Claude Agent SDK + MCP-тулы), а не через
  # общую ветку, где probe переключает модель на haiku; как probe ведёт себя
  # в SDK-пути, не проверено, а смысл этого прогрева — разбудить именно
  # тяжёлую обвязку. Изоляции сессии достаточно: она не даёт накопиться той
  # самой постоянной сессии, из-за которой прогрев Романа стоил $5.
  curl -s ${ca[@]+${ca[@]+"${ca[@]}"}} -m 90 -X POST "$base/webhook/soulmate/chat" \
    -H "Authorization: Bearer $tok" -H "Content-Type: application/json" \
    -d "{\"chatInput\":\"deploy warmup\",\"assistant\":\"15\",\"fresh\":true,\"freshTs\":\"$fts\"}" >/dev/null 2>&1 || true
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
    # Пропускаем там, где нет LiveKit: на тест-стенде SFU не развёрнут вовсе
    # (ни контейнера, ни порта 7880, ни ключей в .env), и поднятый воркер
    # уходит в бесконечный цикл падений. Признак настроенности — свой .env
    # подпроекта: он создаётся руками вместе с ключами LiveKit.
    if [ -d voice-host ] && [ -f voice-host/.env ]; then
      cd voice-host
      npm ci --no-audit --no-fund > /tmp/vh-install.log 2>&1 \
        || { tail -20 /tmp/vh-install.log; echo 'voice-host: npm ci FAILED'; exit 1; }
      npm run build > /tmp/vh-build.log 2>&1 \
        || { tail -20 /tmp/vh-build.log; echo 'voice-host: build FAILED'; exit 1; }
      pm2 startOrReload ecosystem.config.cjs > /tmp/vh-pm2.log 2>&1 \
        || { tail -20 /tmp/vh-pm2.log; echo 'voice-host: pm2 startOrReload FAILED'; exit 1; }
      cd ..
    elif [ -d voice-host ]; then
      echo 'voice-host: .env отсутствует — LiveKit не настроен, воркер пропущен'
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
  # Ловим имя бандла, которое этот билд ИМЕННО ЧТО произвёл (из свежесобранного
  # dist/tma.html), а не то, что могло остаться в $FRONT_SERVED от прошлого
  # деплоя — rsync без --delete старое не чистит (см. шапку файла). Печатаем
  # его последней строкой-маркером и вытаскиваем ниже в EXPECTED_TMA_BUNDLE:
  # smoke_frontend_tma сверяет served-контент именно с этим значением, а не
  # со слабым «отличается от веб-бандла» — та проверка зеленеет и на
  # осиротевшем /tma/, оставшемся от совсем другого, более старого деплоя.
  # Если dist/tma.html не собрался (Mini App выпал из билда) — TMA_JS пустой,
  # это не должно валить set -e, поэтому пайп заканчивается на head (exit 0).
  local frontend_log
  if ! frontend_log=$(ssh_remote "
    set -e
    cd $FRONT_SRC
    git fetch origin
    git reset --hard origin/$BRANCH
    echo 'VITE_BACKEND_URL=$BASE_URL' > .env
    pnpm install --frozen-lockfile 2>&1 | tail -3
    pnpm build 2>&1 | tail -3
    rsync -az dist/ $FRONT_SERVED/
    TMA_JS=\$(grep -oE 'assets/[a-zA-Z0-9._-]*\.js' dist/tma.html 2>/dev/null | head -1)
    echo TMA_BUNDLE_MARKER:\$TMA_JS
  "); then
    echo "$frontend_log" | grep -v '^TMA_BUNDLE_MARKER:'
    red "  frontend deploy failed ($ENV_NAME)"
    exit 1
  fi
  echo "$frontend_log" | grep -v '^TMA_BUNDLE_MARKER:'
  EXPECTED_TMA_BUNDLE=$(echo "$frontend_log" | grep '^TMA_BUNDLE_MARKER:' | tail -1 | cut -d: -f2-)
  export EXPECTED_TMA_BUNDLE
  if [[ -z "$EXPECTED_TMA_BUNDLE" ]]; then
    red "  ⚠ dist/tma.html не собрался ($ENV_NAME) — Mini App отсутствует в этом билде"
  fi
  green "  ✓ frontend bundle deployed ($ENV_NAME)"

  # Инфраструктурный шаг, не зависящий от того, собрался ли в ЭТОМ билде
  # tma.html: location /tma/ должен быть в nginx ДО smoke, и должен быть
  # на обеих фазах одинаково — иначе именно это молча дрейфует между test
  # и prod (см. шапку функции). Падение здесь — то же самое, что и
  # падение сборки: без него дальнейший smoke_frontend_tma гарантированно
  # красный, а прод-nginx мог остаться жив только случайно.
  ensure_tma_nginx_block || { red "  ✗ TMA nginx setup failed ($ENV_NAME) — деплой остановлен"; exit 1; }
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

# Гарантирует наличие location-блока Telegram Mini App (/tma/) в nginx-конфиге
# фазы. Раньше блок был только на test, добавленный руками в обход git — на
# main этой правки не было вовсе, а deploy.sh уже получил smoke_frontend_tma,
# который честно валит прод, где location /tma/ никогда не существовал.
# Следующий же деплой (любого, по любому несвязанному поводу) после мержа
# в main докатился бы до прод-фазы и увидел на проде ровно то же самое
# отсутствие блока — красный smoke, паника, ручная правка прод-nginx под
# давлением. Автоматизируем то же самое, что раньше делали руками, и делаем
# идемпотентно на КАЖДОЙ фазе (test и prod), чтобы дрейф между ними стал
# невозможен в принципе.
#
# Путь конфига РАЗНЫЙ на test и на проде (см. NGINX_CONF_PATH в run_phase):
#   test — /etc/nginx/sites-available/test.linkeon.io, sites-enabled — симлинк на него;
#   prod — /etc/nginx/sites-enabled/spirits САМ является живым файлом (не
#     симлинк, sites-available/spirits — устаревшая недействующая копия).
#     Отсюда и предостережение в CLAUDE.md: класть бэкап РЯДОМ, в
#     sites-enabled/, нельзя — nginx читает там ВСЁ, и лишний файл валит
#     nginx -t дублирующимся default_server.
#
# Идемпотентность — по стабильному маркеру-комментарию, а не по побайтовому
# совпадению блока: ручные правки / форматирование не должны каждый раз
# восприниматься как «блока нет» и провоцировать лишний reload.
#
# Вставляем ПЕРЕД SPA-фолбэком `location /` (как и было на test изначально) —
# это тот самый bare `location /`, который отдаёт index.html на любой путь;
# если наш блок окажется после него по логике/переносимости конфига, легче
# перепутать порядок при будущей ручной правке. Ищем именно server-блок,
# соответствующий домену этой фазы ($BASE_URL), а не первый попавшийся
# `location /` в файле — на проде их несколько (b.linkeon.io редирект,
# linkeon.io лендинг, my.linkeon.io — нужен только последний), а на test
# один и тот же server_name встречается и в :80-редиректе (там location /
# делает return 301, а не отдаёт SPA — это НЕ то место).
ensure_tma_nginx_block() {
  local conf="$NGINX_CONF_PATH"
  local marker="# --- deploy.sh: Telegram Mini App (/tma/) — блок управляется автоматически, руками не трогать ---"

  bold "[front] проверяю TMA nginx-блок ($ENV_NAME: $conf)"

  local current
  current=$(ssh_remote "sudo cat $conf" 2>/dev/null)
  if [[ -z "$current" ]]; then
    red "  ✗ не удалось прочитать $conf ($ENV_NAME) — TMA nginx-блок не проверен"
    return 1
  fi

  # Проверяем ПО МАРКЕРУ, но также по факту наличия самого location /tma/ —
  # на test этот блок уже стоит живьём, добавленный руками в обход git ДО
  # этой правки, то есть без нашего маркера. Проверка только по маркеру
  # приняла бы такой блок за «отсутствующий» и попыталась бы вставить
  # ВТОРОЙ location /tma/ рядом — nginx -t упал бы на дубликате location,
  # и хотя это отловилось бы safety-restore'ом ниже, реального «ничего не
  # трогаю» (как требует идемпотентность) не получилось бы: бэкап, попытка
  # записи, красный nginx -t, откат — churn там, где не должно быть вообще
  # никакого движения.
  #
  # Но маркер (или даже сам location /tma/) МОГ пережить запись, прерванную
  # посреди хвоста файла — раньше запись шла cp-поверх-живого-файла (не
  # rename), и сбой ровно после того, как маркер+начало блока успели лечь на
  # диск, но до того как дошла очередь до остатка конфига, оставлял бы файл
  # с маркером, но БЕЗ закрывающих скобок остальных location/server. Голый
  # grep по маркеру принял бы такое за «всё ОК» и вышел бы 0, ничего не
  # починив — обрыв становится невидимым НАВСЕГДА, следующий запуск тоже
  # доволен. Баланс фигурных скобок — дешёвый (без похода на сервер за вторым
  # запросом, $current уже на руках) и достаточный сигнал именно для этого
  # сценария: усечение почти всегда рвёт вложенность раньше, чем случайно
  # совпадёт число открывающих/закрывающих скобок. Нарочно НЕ используем тут
  # `nginx -t` — на проде он валидирует ВЕСЬ sites-enabled разом (my.linkeon.io
  # + linkeon.io + b.linkeon.io), и никак не связанная поломка в чужом файле
  # дала бы ложный «наш блок битый»; подсчёт скобок смотрит только в
  # содержимое ИМЕННО этого файла.
  local open_braces close_braces
  open_braces=$(grep -o '{' <<<"$current" | wc -l | tr -d ' ')
  close_braces=$(grep -o '}' <<<"$current" | wc -l | tr -d ' ')
  if grep -qF "$marker" <<<"$current" || grep -qE '^[[:space:]]*location[[:space:]]*/tma/[[:space:]]*\{' <<<"$current"; then
    if [[ "$open_braces" -eq "$close_braces" && "$open_braces" -gt 0 ]]; then
      green "  ✓ TMA nginx-блок уже на месте ($ENV_NAME) — reload не нужен"
      return 0
    fi
    red "  ✗ маркер TMA-блока найден в $conf ($ENV_NAME), но файл выглядит ОБРЕЗАННЫМ (скобки: {=$open_braces }=$close_braces не сходятся)"
    red "    Похоже на конфиг, прерванный посреди прошлой записи. РУЧНОЕ ВМЕШАТЕЛЬСТВО: сверить $conf с бэкапами в /etc/nginx/deploy-backups на $ENV_NAME — автоматика не угадывает, что откатывать"
    return 1
  fi

  bold "  блока нет в $conf ($ENV_NAME) — добавляю перед SPA-фолбэком location /"

  # Домен этой фазы — по нему отличаем нужный server{} от прочих (лендинг,
  # b.linkeon.io редирект, :80-редирект того же домена на test).
  local host_pattern
  host_pattern=$(sed -E 's#^https?://##' <<<"$BASE_URL")

  # Собираем итоговый конфиг ЛОКАЛЬНО построчным bash-циклом (не awk: awk
  # macOS/BSD ("one true awk") падает с "newline in string" при передаче
  # многострочного $block через -v — POSIX это разрешает только некоторым
  # реализациям; проверено эмпирически при тестировании этой функции).
  # Состояние по server{}: is_plain_http отсекает :80-блок того же
  # server_name (на test у него тоже "server_name test.linkeon.io;", но его
  # location / — это return 301, а не SPA-фолбэк). Закрывающая '}' без
  # отступа — граница server{} (вложенные location/if закрываются с отступом).
  #
  # Отступ блока БЕРЁМ с той же строки 'location /', перед которой вставляем
  # — не хардкодим. На test живой конфиг отформатирован в 2 пробела на
  # уровень, на проде — в 4 (см. sites-enabled/spirits): блок с чужим
  # отступом читался бы как явный шов ручной правки в файле, который иначе
  # выдержан единообразно. Вложенность внутри наших двух location — это
  # ОДИН уровень глубже относительно самого 'location /tma/', а не глобальная
  # константа: удваиваем найденный отступ ($indent$indent), что на test даёт
  # 2→4 пробела, на проде 4→8 — ровно то, что уже стоит в обоих живых файлах.
  local new_conf="" line
  local in_server=0 is_plain_http=0 is_target=0 inserted=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" =~ ^[[:space:]]*server[[:space:]]*\{ ]]; then
      in_server=1; is_plain_http=0; is_target=0
    fi
    if [[ $in_server -eq 1 && "$line" =~ listen[[:space:]]+80([[:space:]]|\;) ]]; then
      is_plain_http=1
    fi
    if [[ $in_server -eq 1 && $is_plain_http -eq 0 && "$line" == *"server_name"*"$host_pattern"* ]]; then
      is_target=1
    fi
    if [[ $is_target -eq 1 && $is_plain_http -eq 0 && $inserted -eq 0 \
          && "$line" =~ ^([[:space:]]*)location[[:space:]]+/[[:space:]]*\{ ]]; then
      local indent="${BASH_REMATCH[1]}"
      # alias — не root: префикс /tma/ не часть пути на диске (см. живой
      # блок на test, откуда это и списано). try_files $uri (не /tma.html!)
      # — версия с ведущим слэшем игнорировала $uri и заворачивала ЛЮБОЙ
      # путь под /tma/, включая /tma/assets/*.js, на HTML — ломая ассеты.
      local block="${indent}${marker}
${indent}location = /tma {
${indent}${indent}return 301 /tma/;
${indent}}
${indent}location /tma/ {
${indent}${indent}alias $FRONT_SERVED/;
${indent}${indent}try_files \$uri tma.html =404;
${indent}}"
      new_conf+="$block"$'\n'
      inserted=1
    fi
    new_conf+="$line"$'\n'
    if [[ "$line" =~ ^\} ]]; then
      in_server=0
    fi
  done <<<"$current"

  if [[ $inserted -ne 1 ]]; then
    red "  ✗ не нашёл подходящий 'location /' в server-блоке для $host_pattern ($ENV_NAME, $conf)"
    red "    TMA-блок НЕ добавлен — разбираться руками, автоматика не угадывает структуру конфига"
    return 1
  fi

  # Содержимое гоняем через base64 одной строкой внутри команды (а не через
  # stdin-pipe в ssh_remote) — ssh_remote ретраит команду при обрыве связи
  # (код 255), а pipe из локальной переменной на повторной попытке был бы
  # уже пуст. base64 — в самом аргументе команды, retry получит его заново.
  local b64
  # \r тоже вычищаем: BSD/macOS `base64` (в отличие от GNU) заворачивает
  # вывод CRLF-переносами — голого `tr -d '\n'` мало, одинокие \r остаются
  # внутри «однострочной» строки и валят GNU `base64 -d` на удалённом
  # Ubuntu-хосте с "invalid input" (проверено эмпирически при тестировании).
  b64=$(printf '%s' "$new_conf" | base64 | tr -d '\r\n')

  # confdir — локально, не на сервере: dirname зависит только от $conf,
  # который мы уже знаем, лишний remote-вызов не нужен. Он же — директория,
  # где будем создавать временные файлы для атомарной замены (см. ниже,
  # почему это обязано быть ТА ЖЕ директория, что и у $conf).
  local confdir
  confdir=$(dirname "$conf")

  # ПОЧЕМУ ATOMIC RENAME, А НЕ cp-ПОВЕРХ-ЖИВОГО-ФАЙЛА (было раньше):
  # `sudo cp tmp conf` — это truncate+write ВНУТРИ существующего инода. Если
  # запись оборвётся посередине (диск кончился, oom-killer, оборвался ssh),
  # читатель (в т.ч. следующий запуск ЭТОГО скрипта) увидит наполовину
  # записанный файл — и под `set -e` это происходит ДО строки с `nginx -t`,
  # так что restore-ветка (которая раньше жила только в её `else`) вообще не
  # успевает выполниться. `mv`/`rename(2)` меняет ссылку в каталоге ОДНОЙ
  # атомарной операцией (гарантия POSIX — только в пределах одной ФС, отсюда
  # confdir выше и mktemp именно в нём, а не в /tmp): любой читатель либо
  # видит старый файл целиком, либо новый целиком, серединных состояний не
  # существует в принципе.
  #
  # Восстановление вынесено в trap ERR, а не только в `else` после `nginx -t`
  # — это и есть суть фикса: сбой на ЛЮБОМ шаге после снятия бэкапа (cp
  # бэкапа, mktemp, chown/chmod временного файла, сам mv) обязан откатывать,
  # а не только красный nginx -t. Восстановление тоже идёт через mv-поверх-
  # временного-файла (тем же приёмом), затем nginx -t для подтверждения — и
  # если даже восстановленный конфиг не проходит nginx -t (например бэкап
  # сам оказался повреждён), кричим максимально громко: дальше только руки
  # человека, бэкап-файл называем явно.
  #
  # Блокировки на конкурентные запуски НЕТ и специально не добавляем: риск
  # существует только в узком окне одного прогона ensure_tma_nginx_block до
  # первой успешной записи маркера — как только маркер+сбалансированные
  # скобки попали на диск, идемпотентность выше замыкает дыру сама. Лочить
  # ради этого узкого окна отдельным механизмом внутри деплой-скрипта — свой
  # источник багов (протухшие локи, забытый unlock на аварийном выходе).
  local remote_out
  remote_out=$(ssh_remote "
    set -Eeo pipefail
    bdir=/etc/nginx/deploy-backups
    sudo mkdir -p \$bdir
    # mktemp вместо голого 'date +%Y%m%d%H%M%S' — секундного разрешения не
    # хватает при двух прогонах в одну секунду (например ручной повтор сразу
    # после сбоя): второй перетёр бы бэкап первого ДО того как тот успел бы
    # пригодиться. mktemp гарантирует уникальность атомарно, а не 'на глаз'.
    bak=\$(sudo mktemp \"\${bdir}/$(basename "$conf").\$(date +%Y%m%d%H%M%S).XXXXXX\")
    backed_up=0
    restored=0
    tmp=''
    rtmp=''
    # На отвал mv (и на любой другой сбой) может остаться осиротевший
    # scratch-файл рядом с конфигом — сам mv успевает создать/заполнить tmp
    # ДО попытки переименования, и при неудаче переименования файл никуда не
    # девается. Подчищаем best-effort на выходе из скрипта в ЛЮБОМ случае
    # (успех — tmp/rtmp уже не существуют, mv их 'съел'; неуспех — чистим);
    # rm -f не должен уронить нас самих, если и это не удастся — молчим,
    # человек и так получит громкое сообщение об основном сбое.
    trap 'sudo rm -f \"\$tmp\" \"\$rtmp\" 2>/dev/null' EXIT

    # Восстановление собрано из явных '|| restore_ok=0' на КАЖДОМ шаге, а не
    # из очередного голого set -e — эта функция сама может быть вызвана ИЗ
    # trap ERR, и если положиться на set -e внутри неё, второй сбой (та же
    # причина, что сломала исходную запись — например диск кончился ещё
    # секунду назад) оборвал бы shell ДО echo TMA_NGINX_RESULT:FAIL и ДО
    # финального 'чинить руками' — то есть ровно та же дыра, которую чиним,
    # но уже внутри самого восстановления. С явными проверками функция ВСЕГДА
    # дожидается последней строки и печатает финальный статус.
    restore_and_report() {
      local reason=\"\$1\"
      if [[ \$backed_up -eq 1 && \$restored -eq 0 ]]; then
        restored=1
        echo \"  ! \$reason — восстанавливаю $conf из \$bak\" >&2
        local restore_ok=1
        # rtmp НЕ local — она же читается в EXIT-трапе снаружи функции для
        # best-effort уборки осиротевшего scratch-файла, если mv не удался.
        rtmp=\$(sudo mktemp \"$confdir/.tma-restore-XXXXXX\") || restore_ok=0
        # Восстановление — ТЕМ ЖЕ атомарным приёмом (mv рядом лежащего
        # временного файла), а не cp поверх живого: иначе сам откат рискует
        # оборваться тем же способом, каким сломался исходный шаг.
        [[ \$restore_ok -eq 1 ]] && { sudo cp \"\$bak\" \"\$rtmp\" || restore_ok=0; }
        [[ \$restore_ok -eq 1 ]] && { sudo chown \"\$orig_owner\" \"\$rtmp\" || restore_ok=0; }
        [[ \$restore_ok -eq 1 ]] && { sudo chmod \"\$orig_mode\" \"\$rtmp\" || restore_ok=0; }
        [[ \$restore_ok -eq 1 ]] && { sudo mv \"\$rtmp\" $conf || restore_ok=0; }
        if [[ \$restore_ok -eq 1 ]] && sudo nginx -t 2>&1; then
          echo \"  ✓ восстановление подтверждено nginx -t\" >&2
        else
          echo \"  !! ВОССТАНОВЛЕНИЕ НЕ УДАЛОСЬ или восстановленный конфиг НЕ проходит nginx -t — чинить руками НЕМЕДЛЕННО, бэкап цел: \$bak\" >&2
        fi
      fi
      echo TMA_NGINX_RESULT:FAIL
    }
    trap 'restore_and_report \"сбой на шаге записи TMA nginx-блока\"' ERR

    # Владельца/права запоминаем ДО любых изменений — прод живёт под
    # dvolkov:dvolkov 0644, test под root:root 0644, и mktemp ниже создаст
    # временный файл root:root 0600 (сам создаётся через sudo). Наивный mv
    # поверх живого файла сохранил бы это — сменил бы владельца на root и
    # сломал бы следующий деплой, идущий от имени dvolkov/dv без sudo.
    orig_owner=\$(sudo stat -c '%U:%G' $conf)
    orig_mode=\$(sudo stat -c '%a' $conf)

    sudo cp $conf \"\$bak\"
    backed_up=1

    localtmp=\$(mktemp)
    printf '%s' '$b64' | base64 -d > \"\$localtmp\"
    tmp=\$(sudo mktemp \"$confdir/.tma-XXXXXX\")
    sudo cp \"\$localtmp\" \"\$tmp\"
    rm -f \"\$localtmp\"
    sudo chown \"\$orig_owner\" \"\$tmp\"
    sudo chmod \"\$orig_mode\" \"\$tmp\"
    sudo mv \"\$tmp\" $conf

    if sudo nginx -t 2>&1; then
      sudo systemctl reload nginx
      trap - ERR
      echo TMA_NGINX_RESULT:OK
    else
      trap - ERR
      restore_and_report 'nginx -t упал на новом TMA-блоке'
    fi
  ")
  echo "$remote_out" | grep -v '^TMA_NGINX_RESULT:'

  if grep -q '^TMA_NGINX_RESULT:OK' <<<"$remote_out"; then
    green "  ✓ TMA nginx-блок добавлен и nginx перезагружен ($ENV_NAME)"
    return 0
  fi
  # Не утверждаем "конфиг восстановлен" безусловно — в редком двойном сбое
  # (запись упала И откат туда же не смог, см. restore_and_report) это было
  # бы ложным успокоением. Что реально произошло — уже сказано построчно
  # выше (оттуда же полный путь к бэкапу, если чинить руками).
  red "  ✗ запись TMA-блока не удалась ($ENV_NAME) — подробности и статус отката см. в выводе выше, reload НЕ выполнен"
  return 1
}

# Смоук Telegram Mini App (/tma/, отдельная точка входа — vite.config.ts
# rollupOptions.input.tma). Как и smoke_landing — КОД ОТВЕТА ЗДЕСЬ НИЧЕГО НЕ
# ЗНАЧИТ: и на test, и на проде nginx отдаёт index.html с кодом 200 на любой
# незанятый путь (SPA-фолбэк), поэтому "/tma/ вернул 200" было бы зелёным
# даже при полностью отсутствующем location /tma/ в nginx, то есть при
# полностью мёртвом Mini App. Сравниваем СОДЕРЖИМОЕ.
#
# Раньше сравнение было только "бандл на /tma/ отличается от бандла на /" —
# и это ловит SPA-фолбэк, но НЕ ловит осиротевший артефакт: rsync в
# deploy_frontend работает БЕЗ --delete (см. шапку файла), поэтому старый
# tma.html + старый tma-*.js могут годами пережить деплой, из которого
# Mini App вообще пропал. Наблюдалось живьём на test 2026-08-26: чекаут был
# на ветке без Mini App вовсе, dist/tma.html не собирался, а /tma/ всё равно
# отдавал leftover прошлого деплоя — leftover‑бандл, естественно, отличался
# от текущего веб-бандла, и старая проверка репортила зелёный.
#
# Поэтому теперь, если этой фазой фронт был только что собран (deploy_frontend
# передал $expected — имя бандла из СВЕЖЕГО dist/tma.html), проверяем именно
# "served == только что собранному", а не "served != web". Если фронт в этой
# фазе не деплоился (SMOKE_ONLY=1 / BACK_ONLY=1 — свежего билда просто нет,
# сравнивать не с чем), деградируем к старой слабой проверке: лучше слабый
# сигнал, чем ложный fail на здоровом, но не пересобиравшемся в этом прогоне
# фронте.
smoke_frontend_tma() {
  local base="$1" auth="${2:-}" expected="${3:-}"
  local tma_bundle web_bundle
  tma_bundle=$(curl -sf ${auth:+-u "$auth"} "$base/tma/" | grep -o 'src="/assets/[a-zA-Z0-9._-]*\.js"' | head -1)
  if [[ -z "$tma_bundle" ]]; then
    red "  ✗ /tma/ не отдал бандл ($ENV_NAME)"
    return 1
  fi

  if [[ -n "$expected" ]]; then
    if [[ "$tma_bundle" != *"$expected"* ]]; then
      red "  ✗ /tma/ отдаёт НЕ тот бандл, что этот деплой только что собрал ($ENV_NAME): served=$tma_bundle, ожидали содержащий $expected"
      return 1
    fi
    green "  ✓ Mini App отдаёт именно свежесобранный бандл ($ENV_NAME): $tma_bundle"
    return 0
  fi

  # Фолбэк: фронт в этой фазе не деплоился, свежего dist/tma.html нет.
  # Всё ещё ловит SPA-фолбэк, но не ловит orphaned-leftover сценарий выше.
  web_bundle=$(curl -sf ${auth:+-u "$auth"} "$base/" | grep -o 'src="/assets/[a-zA-Z0-9._-]*\.js"' | head -1)
  if [[ "$tma_bundle" == "$web_bundle" ]]; then
    red "  ✗ /tma/ отдаёт веб-бандл ($ENV_NAME) — сработал SPA-фолбэк, location /tma/ не применился"
    return 1
  fi
  bold "  ⚠ Mini App отдаёт свой бандл ($ENV_NAME), но без сверки со свежим билдом (фронт в этой фазе не деплоился): $tma_bundle"
  return 0
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
      # sites-enabled/test.linkeon.io — симлинк НА этот файл (см. ensure_tma_nginx_block).
      NGINX_CONF_PATH="${TEST_NGINX_CONF:-/etc/nginx/sites-available/test.linkeon.io}"
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
      # На проде sites-enabled/spirits — САМ живой файл, а не симлинк на
      # sites-available (та копия устарела и не действует). См. шапку
      # ensure_tma_nginx_block — почему это важно для бэкапов.
      NGINX_CONF_PATH="${PROD_NGINX_CONF:-/etc/nginx/sites-enabled/spirits}"
      ;;
  esac
  export ENV_NAME HOST PATH_EXPORT BACK_PATH FRONT_SRC FRONT_SERVED BASE_URL BASIC_AUTH BRANCH SSH_TARGET PG_DSN NGINX_CONF_PATH

  # Сбрасываем перед каждой фазой: без этого прод унаследовал бы значение,
  # которое deploy_frontend выставила на ПРЕДЫДУЩЕЙ (test) фазе того же
  # запуска, и smoke_frontend_tma сверяла бы прод-бандл с чужим, тестовым
  # ожиданием. Если в этой фазе deploy_frontend не вызывается (SMOKE_ONLY=1 /
  # BACK_ONLY=1), переменная должна остаться пустой — это сигнал для
  # smoke_frontend_tma деградировать к слабой проверке.
  unset EXPECTED_TMA_BUNDLE

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

    # Mini App — отдельная проверка содержимого (см. комментарий у
    # smoke_frontend_tma). Не участвует в SMOKE_ATTEMPTS-ретраях основного
    # smoke/run.sh: это статическая проверка nginx-конфига и собранного
    # бандла, а не прогретого/холодного бэкенд-пути — флапать ей нечему.
    if ! smoke_frontend_tma "$BASE_URL" "$BASIC_AUTH" "${EXPECTED_TMA_BUNDLE:-}"; then
      red "  ✗ SMOKE FAILED ($ENV_NAME) — Mini App (/tma/) не прошёл проверку"
      if [[ "$phase" == "prod" && -z "${NO_ROLLBACK:-}" && -z "${SMOKE_ONLY:-}" ]]; then
        rollback_phase || red "  ✗ rollback had partial failures — check $ENV_NAME manually"
      fi
      return 1
    fi
  else
    echo "(smoke skipped for $ENV_NAME)"
  fi
}

# ── PHASE 4: хостовые части продуктов ─────────────────────────────────────────
#
# Продукты Linkeon (сайты и телеграм-боты клиентов) живут НЕ на my.linkeon.io, а
# на отдельных машинах — контейнер на продукт. МАШИН НЕСКОЛЬКО (кусок 4а:
# клиентские продукты уезжают отдельно от продуктов владельца), список их —
# реестр product_hosts в базе прода, и фаза обязана обойти ВЕСЬ реестр, называя
# каждую машину поимённо. Две части системы стоят на каждой из них и до
# 21.09.2026 в конвейер не входили вовсе:
#
#   1. АГЕНТ ХОСТА (linkeon-host-agent) — забирает задания у my.linkeon.io и
#      исполняет их на машине: заводит продукт, усыпляет, будит. Ставится
#      scripts/product-host-agent-install.sh;
#   2. product-vhost — скрипт, которым заводится домен продукта в nginx.
#      Версионируется в scripts/product-vhost, живёт в /usr/local/bin на хосте.
#
# Чем это кончилось в день выката аренды продуктов (20–21.09.2026):
#
#   * сервер уехал вперёд, агент остался со старым кодом, получил незнакомый
#     вид задания (sleep/wake) и ОТКАЗАЛСЯ. Отказ был честный и ДО изменений на
#     хосте — повезло;
#   * product-vhost существовал ТОЛЬКО на машине и не версионировался. Живая
#     редакция не знала флага `--asleep` и приняла его за номер порта, записав
#     `proxy_pass http://127.0.0.1:--asleep`. Конфиг там пишется ДО `nginx -t`,
#     поэтому на диске остался битый файл, и `nginx -t` перестал проходить
#     ЦЕЛИКОМ: перезагрузи кто-нибудь nginx или машину — demo и shop2 (два
#     боевых продукта) не поднялись бы. Починено руками, причина осталась.
#
# Тесты этот класс не ловят и не поймают: в репозитории всё верно, расходится
# машина. Лечится только выкатом — поэтому фаза входит в деплой ПО УМОЛЧАНИЮ.
#
# ── ПОЧЕМУ ПОСЛЕ ПРОДА И ПОСЛЕ ЕГО СМОКА ──────────────────────────────────────
#
# Сервер и агент договариваются по ВИДУ ЗАДАНИЯ. Известно измеренное:
# сервер новее агента даёт ЧЕСТНЫЙ ОТКАЗ до изменений на хосте (так и вышло
# 20.09). Обратный порядок — агент новее сервера — не проверен ничем, а
# проверять его на машине с двумя боевыми продуктами незачем. Отсюда оба
# требования:
#
#   * не раньше выката прода — иначе новый агент против старого сервера;
#   * не раньше ЗЕЛЁНОГО смока прода — красный смок откатывает бэк к
#     pre-deploy SHA (rollback_phase), и агент, переставленный до смока,
#     оказался бы ровно в этом непроверенном положении «агент новее сервера»,
#     причём уже после отката, то есть надолго.
#
# Держится инвариант ПО ПОСТРОЕНИЮ: и агент, и product-vhost выкатываются из
# того самого коммита, который выкачен на проде (resolve_prod_source читает его
# HEAD прямо здесь, в момент фазы). Поэтому он верен при любом наборе флагов —
# FRONT_ONLY, PRODUCTS_HOST_ONLY, чужой деплой в соседней сессии, откат прода
# посреди прогона, — и агента нельзя ни обогнать сервером, ни откатить назад.
# Раньше вместо этого стояла СВЕРКА «prod HEAD == локальный HEAD», и она
# отказывала фазе почти всегда: в общем репозитории локальный HEAD равен
# продовому редко (трижды подряд расхождением оказался чужой коммит с докой).
# Подробности и разобранные случаи — в комментарии к resolve_prod_source.
#
# ── МАШИН НЕСКОЛЬКО: ЧТО ИЗ ЭТОГО СЛЕДУЕТ ─────────────────────────────────────
#
# 1. СПИСОК — ИЗ РЕЕСТРА НА ПРОДЕ, и только оттуда (см. products_hosts_registry).
#    Отказ запроса и пустой реестр — РАЗНЫЕ состояния с разными текстами, но оба
#    отказывают фазе целиком: «возьму умолчание» здесь означает выкат на одну
#    машину при живых нескольких.
#
# 2. МАШИНЫ НЕЗАВИСИМЫ. Недоступная не отменяет остальных — половина
#    обновлённых лучше, чем ни одной, и лежащая машина в любом случае не
#    получает заданий. Но итог называет, СКОЛЬКО машин из скольких не доехало и
#    какие именно, и фаза возвращает ненулевой код.
#
# 3. ИСТОЧНИК ОДИН НА ВСЕХ — прод-коммит (resolve_prod_source зовётся ОДИН раз,
#    до обхода). Разные машины из разных коммитов — это ровно то частичное
#    расхождение, ради которого фаза написана.
#
# 4. ЗОНА ДОМЕНОВ У КАЖДОЙ СВОЯ (`product_hosts.domain_suffix`), и в
#    product-vhost она подставляется ПОД МАШИНУ. Один и тот же файл на всех
#    машинах означал бы домен чужой зоны на второй машине — молча.
#
# 5. ТОКЕН АГЕНТА У КАЖДОЙ СВОЙ, и фаза его НЕ ПИШЕТ: он живёт в
#    /etc/linkeon-host-agent.env на самой машине, установщик его только читает.
#    Но фаза СВЕРЯЕТ его sha256 со строкой реестра (ph_check_identity) — это
#    единственное место, где ловится перепутанный токен: агент с чужим токеном
#    успешно опрашивает сервер и забирает ЧУЖИЕ задания, то есть host_agent_watch
#    остаётся зелёным, а продукт разворачивается не на той машине.
#
# 6. accepts_new И audience ФАЗУ НЕ КАСАЮТСЯ. Машина, закрытая для новых
#    продуктов, продолжает крутить старые: отставший агент на ней — та же
#    поломка. Обходятся ВСЕ строки реестра.
#
# ── ПОЧЕМУ ПАДЕНИЕ ФАЗЫ НЕ ОТКАТЫВАЕТ my.linkeon.io ───────────────────────────
#
# К моменту фазы 4 прод выкачен и его смок зелёный. Машины продуктов —
# ОТДЕЛЬНЫЕ, и их недоступность не делает my.linkeon.io хуже: откатывать
# зелёный прод из-за чужой машины значило бы менять одну аварию на две. Плюс
# известный случай: 21.09 откат на проде запустился от ОБРЫВА СВЯЗИ у
# оператора, а не от кода — привязывать к сетевой достижимости ещё и прод
# нельзя тем более.
#
# Поэтому фаза НИКОГДА не зовёт rollback_phase. Но и молчать нельзя — молчание
# и есть диагноз этой задачи: фаза возвращает ненулевой код, скрипт выходит с
# exit 4 и НЕ печатает «ALL PHASES GREEN». Прод при этом остаётся выкаченным и
# рабочим, а оператор видит ровно то, что не доехало, и чем это повторить
# (PRODUCTS_HOST_ONLY=1).

# sha256 локального файла. На маке нет sha256sum, на серверах нет shasum —
# deploy.sh запускают и оттуда, и оттуда.
sha256_local() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# ── ОТКУДА БЕРЁТСЯ СПИСОК МАШИН ───────────────────────────────────────────────
#
# ИЗ БАЗЫ ПРОДА. Реестр (product_hosts, кусок 4а) живёт в базе, потому что он
# нужен ВНУТРИ запроса выдачи заданий, а не только при старте. Вторая его копия
# — в файле рядом со скриптом или в переменной окружения — разошлась бы с ним
# МОЛЧА: ровно так расходились константы адреса и зоны, которые кусок 4а и убрал
# из provisioning.service.ts.
#
# ОТКАЗ ЗАПРОСА И ПУСТОЙ РЕЕСТР — РАЗНЫЕ СОСТОЯНИЯ. Оба отказывают фазе, но
# лечатся разными руками, поэтому у них разные коды и разные тексты:
#
#   rc=1  СПРОСИТЬ НЕ УДАЛОСЬ: прод недоступен, в .env нет DATABASE_URL, psql не
#         нашёлся, таблицы ещё нет (прод старее куска 4а). Про машины не
#         известно НИЧЕГО — ни сколько их, ни где они. Трогать при этом
#         «известную» машину нельзя: вторая осталась бы позади незамеченной;
#   rc=2  СПРОСИЛИ УСПЕШНО, СТРОК НОЛЬ. Известно точно: реестр пуст. Состояние
#         достижимое, а не теоретическое — миграция 005 нарочно безвредный
#         no-op при незаполненном PRODUCT_HOST_TOKEN, и при этом на
#         139.59.210.42 продолжают работать demo и shop2. Лечится дописанной
#         переменной и перезапуском API, а не поиском упавшей базы.
#
# Умолчания («не ответили — возьму root@139.59.210.42») здесь нет сознательно:
# оно означает выкат на ОДНУ машину при живых нескольких, то есть частичное
# расхождение, которое потом ищут руками.
#
# ЗАПРОС ЦЕЛИКОМ ИСПОЛНЯЕТСЯ НА ПРОДЕ, и строка DATABASE_URL прод не покидает.
# Вытащить её сюда (`ssh … grep DATABASE_URL | cut -d= -f2-`, как предлагал план)
# нельзя по двум причинам, и вторая — отказ: значение уехало бы обратно на прод
# ВНУТРИ команды ssh, то есть прошло бы ВТОРОЕ раскрытие удалённым шеллом, и
# `$` в пароле превратился бы в пустоту, пробел — в разрыв команды. Пароль на
# проде сегодня без спецсимволов (проверено), но это свойство пароля, а не кода.
#
# ФОРМА ОТВЕТА — `psql -tA` с разделителем по умолчанию `|`: он не может быть
# законным ни в метке, ни в ssh-цели, ни в зоне, ни в hex-хеше. Склейка
# `id || ' ' || ssh_target` (её предлагал план) разъехалась бы на метке с
# пробелом, а NULL в любом поле обнулил бы ВСЮ строку — `read` увидел бы
# пустоту и молча пропустил машину.
#
# Маркеры BEGIN/END — против баннера, MOTD и предупреждений ssh: без них первая
# строка чужого вывода приехала бы «машиной».
#
# УДАЛЁННЫЙ СКРИПТ — ОТДЕЛЬНОЙ ФУНКЦИЕЙ, а не heredoc'ом внутри `$( … )`.
# bash 3.2 (это /bin/bash на маке, откуда deploy.sh и запускают) разбирает тело
# heredoc, ища закрывающую скобку подстановки, и спотыкается о кавычки внутри
# него: исправный скрипт падает с `syntax error near unexpected token ;;` ещё
# до первой команды. Поймано на этой же правке; тот же приём применён к
# ph_identity_probe.
ph_registry_probe() {
  cat <<'EOS'
set -u
cd "$BACK" 2>/dev/null || { echo "PH_REG_ERR каталога бэкенда $BACK на проде нет"; exit 0; }
[ -f .env ] || { echo "PH_REG_ERR $BACK/.env на проде нет"; exit 0; }
DB=$(sed -n 's/^DATABASE_URL=//p' .env | head -1)
[ -n "$DB" ] || { echo "PH_REG_ERR в $BACK/.env нет DATABASE_URL"; exit 0; }
command -v psql >/dev/null 2>&1 || { echo "PH_REG_ERR psql на проде не найден"; exit 0; }
echo PH_REG_BEGIN
psql "$DB" -tAX -c 'SELECT id, ssh_target, domain_suffix, agent_token_hash FROM product_hosts ORDER BY id' 2>&1
echo "PH_REG_END rc=$?"
EOS
}

products_hosts_registry() {
  local raw body rc endline
  raw=$(ph_registry_probe | ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 \
            "$PROD_HOST" "BACK='${PROD_BACK_PATH:-/home/dvolkov/spirits_back}' bash -s" 2>&1)
  # ДИАГНОСТИКА ОТСЮДА УХОДИТ В STDERR, И ЭТО НЕ ВКУСОВЩИНА. Функцию зовут как
  # `registry=$(products_hosts_registry)`: её stdout — канал ДАННЫХ, и всё, что
  # напечатано туда, попадает в переменную вместо экрана. Поймано харнессом:
  # отказы «нет DATABASE_URL» и «таблицы не существует» не показывались ВООБЩЕ —
  # оператор видел только итоговое «список машин неизвестен» без причины.
  # Тот же приём и по той же причине — в ssh_remote.
  #
  # Отказ самого ssh (машина недоступна, ключ не принят) — сюда же: маркеров в
  # выводе не будет, и ветка ниже отработает как «спросить не удалось».
  if grep -q '^PH_REG_ERR' <<<"$raw"; then
    red "  ✗ реестр машин прочитать не удалось: $(grep -m1 '^PH_REG_ERR' <<<"$raw" | sed 's/^PH_REG_ERR //')" >&2
    return 1
  fi
  endline=$(grep -o 'PH_REG_END rc=[0-9]*' <<<"$raw" | tail -1)
  if ! grep -q '^PH_REG_BEGIN$' <<<"$raw" || [[ -z "$endline" ]]; then
    red "  ✗ реестр машин прочитать не удалось — $PROD_HOST не ответил целиком" >&2
    [[ -n "$raw" ]] && { echo "      что вернулось:"; tail -5 <<<"$raw" | sed 's/^/        /'; } >&2
    return 1
  fi
  rc="${endline##*rc=}"
  body=$(sed -n '/^PH_REG_BEGIN$/,/^PH_REG_END /p' <<<"$raw" | sed '1d;$d')
  if [[ "$rc" != "0" ]]; then
    {
      red "  ✗ запрос к базе прода не удался (psql rc=$rc)"
      [[ -n "$body" ]] && tail -5 <<<"$body" | sed 's/^/        /'
      red "    «Таблицы product_hosts не существует» означает прод СТАРЕЕ куска 4а:"
      red "    сначала выкатить бэкенд (он накатит 005), потом эту фазу."
    } >&2
    return 1
  fi
  body=$(grep -v '^[[:space:]]*$' <<<"$body" || true)
  [[ -n "$body" ]] || return 2
  printf '%s\n' "$body"
  return 0
}

# ── ОТКУДА БЕРЁТСЯ КОД, КОТОРЫЙ ЕДЕТ НА МАШИНУ ПРОДУКТОВ ──────────────────────
#
# Из КОММИТА, ВЫКАЧЕННОГО НА ПРОДЕ, а не из локального рабочего дерева. Обе
# части фазы — агент и product-vhost — берутся из одной выкладки этого коммита.
#
# ПОЧЕМУ НЕ СВЕРКА. Инвариант фазы — «агент не новее сервера»: сервер новее
# агента даёт измеренный честный отказ задания (20.09.2026), обратный порядок не
# проверен ничем. Держался он ПРОВЕРКОЙ: локальный HEAD обязан совпасть с HEAD
# прода, иначе агента не трогаем. Инвариант верный, проверка — нет. Репозиторий
# общий, параллельные сессии коммитят в него свои спеки, и локальный HEAD
# расходится с продовым почти всегда: фаза отказалась ставить агента трижды
# подряд, и в последний раз расхождением был коммит с ДОКУМЕНТОМ, к агенту
# отношения не имеющий. Проверка, которая не срабатывает почти никогда, держит
# не инвариант, а фазу.
#
# Взяв источником сам прод-коммит, инвариант получаем ПО ПОСТРОЕНИЮ — агенту
# достаётся ровно тот код, по которому работает сервер, и сверять больше нечего.
# Заодно закрываются случаи, которые сверка не ловила вовсе:
#   * FRONT_ONLY/SMOKE_ONLY: бэкенд в этом прогоне не выкатывался, прод остался
#     на прежнем коммите — агент поедет с него, а не с нашего нового;
#   * откат прода на pre-deploy SHA: HEAD читается ПОСЛЕ отката, то есть едет
#     то, что на проде на самом деле, а не то, что мы собирались выкатить;
#   * чужой деплой из соседней сессии между нашим push и этой фазой.
#
# ПОЧЕМУ ИЗ ЛОКАЛЬНОЙ БАЗЫ ОБЪЕКТОВ, А НЕ tar'ом С ПРОДА. Содержимое в git
# адресуется хешем: попросив $prod_sha, мы получаем ровно его. Копия рабочего
# дерева прода этим свойством не обладает — там лежат и чужие правки поверх
# коммита (на 21.09 в $PROD_BACK_PATH 18 неотслеживаемых файлов), и уехали бы
# они на хост с двумя боевыми продуктами. Нет объекта локально — один
# `git fetch origin`.
#
# КОММИТА НЕТ В ORIGIN — ОТКАЗ. deploy.sh пушит в origin ДО выката, так что
# коммит, которого там нет, означает прод, выкаченный мимо конвейера — это
# авария сама по себе. Такой код нельзя ни прочитать заново, ни воспроизвести
# ниоткуда, кроме самой машины; размножать его на вторую машину — плохой размен.
# Отказ называет оба лечения: запушить коммит либо выкатить прод из origin.
#
# Чистота рабочего дерева тут больше НЕ ПРОВЕРЯЕТСЯ и не нужна: незакоммиченная
# правка не может уехать — её нет в коммите. Прежняя проверка стояла ровно
# потому, что установщик раскладывал агента rsync'ом из рабочего дерева; теперь
# ему передаётся каталог-выкладка (AGENT_SRC), а рабочее дерево он берёт только
# при РУЧНОМ запуске, мимо deploy.sh.
PH_SRC_DIR=""   # каталог с выкладкой прод-коммита (product-runner/, scripts/)
PH_PROD_SHA=""  # сам коммит; в сообщениях печатается, чтобы было что повторить

resolve_prod_source() {
  bold "[источник] выкат — из коммита, выкаченного на my.linkeon.io (один на все машины)"

  if ! git -C "$LOCAL_BACK_DIR" rev-parse --git-dir >/dev/null 2>&1; then
    red "  ✗ $LOCAL_BACK_DIR не похож на git-репозиторий — взять прод-коммит неоткуда"
    return 1
  fi

  # BatchMode=yes — как и у проверки достижимости машины продуктов: без ключа
  # ssh иначе повис бы на приглашении пароля посреди деплоя.
  local prod_sha
  prod_sha=$(ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 "$PROD_HOST" \
               "cd ${PROD_BACK_PATH:-/home/dvolkov/spirits_back} && git rev-parse HEAD" 2>/dev/null \
             | tail -1 | tr -d '[:space:]')
  if [[ ! "$prod_sha" =~ ^[0-9a-f]{40}$ ]]; then
    red "  ✗ не смог прочитать HEAD бэкенда на проде ($PROD_HOST) — по какому коду работает сервер, неизвестно"
    red "    Агент обязан ехать с ТОГО ЖЕ коммита, поэтому не трогаю ни его, ни product-vhost"
    return 1
  fi

  if ! git -C "$LOCAL_BACK_DIR" cat-file -e "${prod_sha}^{commit}" 2>/dev/null; then
    echo "      коммита ${prod_sha:0:8} нет в локальной базе объектов — тяну из origin"
    git -C "$LOCAL_BACK_DIR" fetch --quiet origin 2>/dev/null || true
  fi
  if ! git -C "$LOCAL_BACK_DIR" cat-file -e "${prod_sha}^{commit}" 2>/dev/null; then
    red "  ✗ на проде работает коммит $prod_sha — его нет ни локально, ни в origin"
    red "    Значит прод выкачен мимо конвейера: deploy.sh пушит в origin ДО выката."
    red "    Код с самой машины брать не буду — он ничем не проверяется, а уехал бы"
    red "    на хост с двумя боевыми продуктами. Лечится одним из двух:"
    red "      git push origin <ветка с этим коммитом>, потом PRODUCTS_HOST_ONLY=1 bash $LOCAL_BACK_DIR/scripts/deploy.sh"
    red "      либо выкатить прод заново из origin/$BRANCH"
    return 1
  fi

  local tmp
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/linkeon-phase4.XXXXXX") || { red "  ✗ не смог создать временный каталог под выкладку"; return 1; }
  PH_SRC_DIR="$tmp"

  # Выкладка — tar'ом прямо из базы объектов: рабочее дерево (ни наше, ни
  # чужое), индекс и ветки при этом не участвуют вовсе. Значит фаза безопасна
  # для параллельных сессий в том же репозитории — а они тут норма.
  if ! git -C "$LOCAL_BACK_DIR" archive --format=tar "$prod_sha" product-runner scripts/product-vhost 2>/dev/null \
       | tar -xf - -C "$tmp"; then
    red "  ✗ в коммите ${prod_sha:0:8} нет product-runner/ или scripts/product-vhost"
    red "    Прод старее самих этих частей — сначала выкатить бэкенд, потом эту фазу"
    return 1
  fi
  local part
  for part in product-runner/package.json product-runner/linkeon-host-agent.service scripts/product-vhost; do
    [[ -f "$tmp/$part" ]] || { red "  ✗ в выкладке прод-коммита нет $part — ставить нечего"; return 1; }
  done

  PH_PROD_SHA="$prod_sha"
  green "  ✓ источник — прод-коммит ${prod_sha:0:8}: и агент, и product-vhost поедут из него"

  # Расхождение с локальным HEAD печатается, но НЕ останавливает: именно на нём
  # фаза и застревала. Строка нужна для другого — объяснить оператору, который
  # только что что-то закоммитил, почему на машину уехало не это.
  local local_sha
  local_sha=$(git -C "$LOCAL_BACK_DIR" rev-parse HEAD 2>/dev/null | tr -d '[:space:]')
  if [[ -n "$local_sha" && "$local_sha" != "$prod_sha" ]]; then
    echo "      локальный HEAD ${local_sha:0:8} другой — это норма: на машины продуктов едет"
    echo "      продовый код, иначе агент оказался бы новее сервера (не проверено ничем)"
  fi
  return 0
}

# ── ЛИЧНОСТЬ МАШИНЫ: ТОКЕН АГЕНТА ПРОТИВ СТРОКИ РЕЕСТРА ───────────────────────
#
# Токен агента фаза НЕ ПИШЕТ и писать не должна: он живёт в
# /etc/linkeon-host-agent.env на самой машине, кладёт его владелец, установщик
# только читает и проверяет форму. Реестр хранит лишь sha256 — так же, как
# runner_token_hash у продукта.
#
# СВЕРЯТЬ ЕГО ВСЁ РАВНО НАДО, и это единственное место, где перепутанный токен
# ловится вообще. Разошедшийся токен (агент не тот, за кого себя выдаёт)
# выглядит по-разному:
#
#   * токен НЕ ИЗ РЕЕСТРА ВОВСЕ — гвард отвечает 401, и это видно в
#     host_agent_watch: «опрос не удался» всё окно;
#   * токен ЧУЖОЙ МАШИНЫ — гвард отвечает 200. Агент второй машины успешно
#     забирает задания ПЕРВОЙ, продукт разворачивается не там, куда сервер
#     записал его адрес и зону, а host_agent_watch остаётся ЗЕЛЁНЫМ: опросы-то
#     проходят. Снаружи это выглядит как «продукт завёлся, но домен не
#     отвечает» — и ищется руками по двум машинам.
#
# Второй случай возникает ровно при заведении второй машины (копия конфига
# первой — самый естественный способ её завести), поэтому проверка стоит ПЕРВОЙ
# частью и до любых изменений на машине.
#
# ХЕШЕЙ СЧИТАЕТСЯ ТРИ, И ГОДИТСЯ ЛЮБОЙ. Сервер хеширует значение из окружения
# как есть (`crypto.createHash('sha256').update(token)`), systemd же снимает с
# значения обрамляющие пробелы и одну пару кавычек. Одно «правильное» чтение
# файла, выбранное здесь, разошлось бы с установщиком на конфиге с кавычками и
# дало бы ЛОЖНЫЙ КРАСНЫЙ на исправной машине. Поэтому считаются все три чтения
# (как есть, без пробелов, без кавычек) и достаточно совпадения любого.
#
# `bash -s` со стдина и одинарный heredoc — тот же приём, что в
# product-host-agent-install.sh: тело команды не проходит раскрытие ни локальным
# шеллом, ни удалённым, и экранировать в нём нечего.
ph_identity_probe() {
  cat <<'EOS'
set -u
F=/etc/linkeon-host-agent.env
if ! $SUDO test -f "$F"; then echo "TOK=НЕТ_ФАЙЛА"; exit 0; fi
raw=$($SUDO sed -n 's/^HOST_TOKEN=//p' "$F" | head -1 | tr -d '\r')
# Три чтения: как есть, без обрамляющих пробелов, без одной пары кавычек —
# порядок и правила те же, что у trim()/strip() в product-host-agent-install.sh.
t1=$(printf '%s' "$raw" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
t2=$(printf '%s' "$t1" | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/")
for v in "$raw" "$t1" "$t2"; do
  [ -n "$v" ] || continue
  printf 'TOK=%s\n' "$(printf '%s' "$v" | sha256sum | cut -d' ' -f1)"
done
EOS
}

ph_check_identity() {
  bold "[машина $PH_ID 1/3] личность: токен агента против строки реестра"
  local out
  out=$(ph_identity_probe | ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 \
            "$PH_TARGET" "SUDO='$PH_SUDO' bash -s" 2>/dev/null) \
    || { red "  ✗ не смог прочитать конфиг агента на $PH_TARGET"; return 1; }

  if grep -q '^TOK=НЕТ_ФАЙЛА$' <<<"$out"; then
    # НЕ наш отказ: агента сюда ещё не ставили. Установщик скажет это точнее и
    # назовёт, что именно положить в файл, — дублировать его текст здесь значит
    # завести второе место, где он устареет.
    bold "  ⚠ /etc/linkeon-host-agent.env на машине нет — сверять нечего, об этом скажет установщик"
    return 0
  fi
  if ! grep -q '^TOK=[0-9a-f]\{64\}$' <<<"$out"; then
    red "  ✗ HOST_TOKEN в /etc/linkeon-host-agent.env на «${PH_ID}» пуст или не читается"
    return 1
  fi
  if ! grep -qx "TOK=$PH_TOKEN_HASH" <<<"$out"; then
    red "  ✗ токен агента на машине «${PH_ID}» НЕ СООТВЕТСТВУЕТ её строке в реестре"
    red "    Реестр ждёт sha256 ${PH_TOKEN_HASH:0:12}…, на машине лежит другой токен."
    red "    Если это токен СОСЕДНЕЙ машины — агент будет успешно забирать ЧУЖИЕ задания:"
    red "    сервер ответит 200, опросы пойдут, а продукт развернётся не на той машине."
    red "    Чинить одним из двух: положить в /etc/linkeon-host-agent.env токен этой"
    red "    машины либо поправить agent_token_hash в product_hosts у строки «${PH_ID}»."
    red "    Ничего на машине не тронуто."
    return 1
  fi
  green "  ✓ токен агента соответствует строке реестра «${PH_ID}»"
  return 0
}

# Подстановка зоны доменов в product-vhost под КОНКРЕТНУЮ машину.
#
# Строка `ZONE=` в скрипте ровно одна, и это проверяется ДО и ПОСЛЕ: файл едет
# на машину с боевыми продуктами, и «подставил не туда» стоит здесь тех самых
# доменов, ради которых всё написано.
#
# ЗАМЕНА ПО НАЧАЛУ СТРОКИ, А НЕ ПО ВХОЖДЕНИЮ ТЕКСТА `p.linkeon.io`. Зона
# упомянута в скрипте ещё и в комментарии; глобальная замена переписала бы
# объяснение вместе с кодом — и на машине, чья зона совпадает с исходной,
# разницы не было бы видно вовсе.
ph_render_vhost() {
  local base="$1" zone="$2" dst="$3" n
  n=$(grep -c '^ZONE=' "$base" || true)
  if [[ "$n" != "1" ]]; then
    red "  ✗ в scripts/product-vhost из прод-коммита ${PH_PROD_SHA:0:8} строк «ZONE=» — $n, нужна ровно одна"
    red "    В неё подставляется зона доменов машины. Ноль строк означает прод СТАРЕЕ этой"
    red "    правки: тот product-vhost зашивает одну зону на все машины, и выкатить его на"
    red "    машину с другой зоной значило бы выписать её домены в чужой — молча."
    red "    Лечится выкатом бэкенда (обычный прогон deploy.sh), после него — эта фаза."
    return 1
  fi
  if ! awk -v z="$zone" '/^ZONE=/ { print "ZONE=" z; next } { print }' "$base" > "$dst"; then
    red "  ✗ не смог подставить зону $zone в product-vhost"
    return 1
  fi
  if [[ "$(grep -c '^ZONE=' "$dst" || true)" != "1" ]] || ! grep -qx "ZONE=$zone" "$dst"; then
    red "  ✗ подстановка зоны $zone в product-vhost не подтвердилась — на машину ничего не поедет"
    return 1
  fi
  chmod 755 "$dst"
  return 0
}

# Возвращает 0, если на машине продуктов нечего чинить в product-vhost, иначе 1.
#
# ОТКУДА КАНДИДАТ. Из выкладки прод-коммита ($PH_SRC_DIR), как и агент, и это не
# «за компанию». product-vhost зовёт САМ АГЕНТ и теми флагами, которые знает
# агент: `--asleep` появился вместе с арендой продуктов. Пара «агент +
# product-vhost» обязана быть из одного коммита — разъехавшись, она даёт ровно
# аварию 21.09.2026: агент просит --asleep, живой скрипт такого флага не знает и
# пишет его в proxy_pass.
#
# Раньше кандидат брался из рабочего дерева, и болезнь тут была та же, что у
# агента, только злее: у этой половины сверки с продом не было ВООБЩЕ. Локальный
# чекаут, отставший от прода (или просто другая ветка), молча переписал бы живой
# /usr/local/bin/product-vhost СТАРОЙ редакцией — то есть конвейер сам вернул бы
# машину в то состояние, от которого эта фаза и написана. Теперь обе половины
# едут из одного коммита, и расходиться нечему.
#
# ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ И ПОЧЕМУ ИМЕННО ТАК.
#
# `nginx -t` на хосте гоняется ВСЕГДА, даже когда скрипт совпал до байта. Это
# та самая проверка, которая 21.09 была красной, и красной она может стать без
# нашего участия — от чужой правки, от продукта, заведённого руками. Дешевле
# узнать об этом на выкате, чем на перезагрузке машины.
#
# Валидность кандидата доказывается ДО подмены живого файла и тремя разными
# способами, потому что одного мало:
#   * `sh -n` — разбирается ли он вообще;
#   * три пробы с заведомо НЕПОНЯТЫМ аргументом обязаны вернуть ровно 2. Это
#     ровно тот дефект, что случился: старая редакция непонятый `--asleep`
#     дотаскивала до `proxy_pass`. Проба ловит его как поведение, а не как
#     текст;
#   * снимок /etc/nginx/sites-products ДО и ПОСЛЕ проб. Непонятый аргумент
#     обязан отбиваться ДО первой записи, и это проверяется прямо: каталог
#     обязан остаться байт в байт. Если кандидат всё же написал — файл
#     удаляется, nginx приводится в чувство, установка отменяется.
# Слаг проб — `deploy-selfcheck`, заведомо не продукт: пиши кандидат в каталог,
# он не заденет ни demo, ни shop2.
#
# Подмена — атомарным mv временного файла ИЗ ТОГО ЖЕ каталога (тот же приём и
# по той же причине, что в ensure_tma_nginx_block: rename(2) атомарен только в
# пределах ФС, и читатель видит либо старый файл целиком, либо новый).
#
# Чего здесь НАМЕРЕННО нет — машины восстановления уровня ensure_tma_nginx_block.
# Разница по существу: product-vhost НЕ ЧИТАЕТСЯ nginx'ом. Половинчатая копия
# на диске не роняет ни один домен сама по себе — она проявится только при
# следующем заведении/усыплении продукта. Бэкап снимается, sha после подмены
# сверяется, этого для такой цены достаточно.
ensure_product_vhost() {
  local base="$PH_SRC_DIR/scripts/product-vhost"
  bold "[машина $PH_ID 2/3] product-vhost на $PH_TARGET (зона $PH_ZONE)"

  if [[ ! -f "$base" ]]; then
    red "  ✗ в выкладке прод-коммита ${PH_PROD_SHA:0:8} нет scripts/product-vhost — выкатывать нечего"
    return 1
  fi
  # Кандидат собирается ПОД ЭТУ МАШИНУ: зона у каждой своя, и один и тот же файл
  # на всех машинах дал бы второй домен в зоне первой — молча (сервер пишет
  # продукту домен из product_hosts.domain_suffix, vhost встал бы на чужой
  # server_name, проба promoteReady не нашла бы сайт никогда).
  local src="$PH_SRC_DIR/product-vhost.$PH_ID"
  ph_render_vhost "$base" "$PH_ZONE" "$src" || return 1
  local want
  want=$(sha256_local "$src")

  local state
  state=$(ssh_remote "
    set -uo pipefail
    if $PH_SUDO nginx -t >/dev/null 2>&1; then echo NGINX=ok; else echo NGINX=red; fi
    if [ -f /usr/local/bin/product-vhost ]; then
      echo SUM=\$($PH_SUDO sha256sum /usr/local/bin/product-vhost | cut -d' ' -f1)
    else
      echo SUM=НЕТ_ФАЙЛА
    fi
  ") || { red "  ✗ не смог опросить $PH_TARGET"; return 1; }

  local nginx_state have
  nginx_state=$(sed -n 's/^NGINX=//p' <<<"$state" | tail -1)
  have=$(sed -n 's/^SUM=//p' <<<"$state" | tail -1)

  if [[ "$nginx_state" != "ok" ]]; then
    red "  ✗ nginx -t на машине продуктов КРАСНЫЙ — там два боевых домена, и"
    red "    перезагрузка nginx или машины сейчас их не поднимет. Чинить ПЕРВЫМ делом:"
    red "    ssh $PH_TARGET 'nginx -t'"
    return 1
  fi
  green "  ✓ nginx -t на машине продуктов зелёный"

  if [[ "$have" == "$want" ]]; then
    green "  ✓ product-vhost совпадает с прод-коммитом ${PH_PROD_SHA:0:8} (sha ${want:0:12}) — ставить нечего"
    return 0
  fi

  red "  ! product-vhost на машине РАЗОШЁЛСЯ с прод-коммитом ${PH_PROD_SHA:0:8}"
  echo "      машина: ${have:0:12}   прод-коммит: ${want:0:12}"
  if [[ -n "${PH_CHECK_ONLY:-}" ]]; then
    red "  ✗ режим проверки (PRODUCTS_HOST_CHECK_ONLY/SMOKE_ONLY) — не пишу ничего"
    return 1
  fi

  # base64 — в самом аргументе команды, а не через stdin: ssh_remote ретраит
  # команду при обрыве связи (код 255), и pipe из локальной переменной на
  # повторной попытке был бы уже пуст. \r вычищаем — BSD/macOS base64
  # заворачивает вывод CRLF, и одинокие \r валят GNU `base64 -d` на Ubuntu.
  local b64
  b64=$(base64 < "$src" | tr -d '\r\n')

  local out
  out=$(ssh_remote "
    set -uo pipefail
    SLUG=deploy-selfcheck
    SNAPDIR=/etc/nginx/sites-products
    LIST=\$(mktemp -d)
    trap 'rm -rf \"\$LIST\"' EXIT
    snap()  { $PH_SUDO find \"\$SNAPDIR\" -type f -exec sha256sum {} + 2>/dev/null | sort | sha256sum | cut -d' ' -f1; }
    files() { $PH_SUDO find \"\$SNAPDIR\" -type f 2>/dev/null | sort; }
    BEFORE=\$(snap)
    files > \"\$LIST/before\"

    TMP=\$($PH_SUDO mktemp /usr/local/bin/.product-vhost.XXXXXX) || { echo PVHOST:NO_TMP; exit 0; }
    printf '%s' '$b64' | base64 -d | $PH_SUDO tee \"\$TMP\" >/dev/null
    $PH_SUDO chown root:root \"\$TMP\"
    $PH_SUDO chmod 755 \"\$TMP\"

    if ! $PH_SUDO sh -n \"\$TMP\"; then
      $PH_SUDO rm -f \"\$TMP\"; echo PVHOST:PARSE_FAIL; exit 0
    fi

    BAD=''
    rc=0; $PH_SUDO sh \"\$TMP\"                >/dev/null 2>&1 || rc=\$?
    [ \"\$rc\" = 2 ] || BAD=\"\$BAD пустой-слаг(rc=\$rc)\"
    rc=0; $PH_SUDO sh \"\$TMP\" \"\$SLUG\" --sleep >/dev/null 2>&1 || rc=\$?
    [ \"\$rc\" = 2 ] || BAD=\"\$BAD непонятый-флаг(rc=\$rc)\"
    rc=0; $PH_SUDO sh \"\$TMP\" -evil 8001     >/dev/null 2>&1 || rc=\$?
    [ \"\$rc\" = 2 ] || BAD=\"\$BAD слаг-с-дефисом(rc=\$rc)\"

    if [ \"\$(snap)\" != \"\$BEFORE\" ]; then
      # Кандидат написал конфиг на аргументе, который обязан был отбить. Это и
      # есть дефект 21.09; подчищаем за ним и приводим nginx в чувство.
      #
      # Убираем ВСЁ, что появилось за пробы, а не только \$SLUG.conf: у пробы с
      # пустым слагом имя конфига получается '.conf', у пробы с ведущим дефисом
      # — '-evil.conf'. Кандидат, который пишет до разбора аргументов, оставил
      # бы их все, и уже СЛЕДУЮЩИЙ 'nginx -t' на машине с demo и shop2 стал бы
      # красным — от нашей же проверки. Список снят ДО проб, удаляем строго
      # разницу: чужие файлы (те самые demo.conf и shop2.conf) не трогаются в
      # принципе. Переписать существующий конфиг пробы не могут — имя берётся
      # из слага, а ни один из трёх слагов не совпадает с продуктом.
      files > \"\$LIST/after\"
      comm -13 \"\$LIST/before\" \"\$LIST/after\" | while IFS= read -r f; do
        [ -n \"\$f\" ] && $PH_SUDO rm -f \"\$f\"
      done
      $PH_SUDO nginx -t >/dev/null 2>&1 && $PH_SUDO systemctl reload nginx >/dev/null 2>&1
      if [ \"\$(snap)\" != \"\$BEFORE\" ]; then
        BAD=\"\$BAD ПИСАЛ-В-sites-products-И-УБРАТЬ-НЕ-УДАЛОСЬ\"
      else
        BAD=\"\$BAD ПИСАЛ-В-sites-products-на-непонятом-аргументе(убрано)\"
      fi
    fi

    if [ -n \"\$BAD\" ]; then
      $PH_SUDO rm -f \"\$TMP\"
      echo \"  ! пробы кандидата:\$BAD\"
      echo PVHOST:PROBE_FAIL; exit 0
    fi

    $PH_SUDO mkdir -p /var/backups/linkeon
    if [ -f /usr/local/bin/product-vhost ]; then
      $PH_SUDO cp -p /usr/local/bin/product-vhost \"/var/backups/linkeon/product-vhost.\$(date +%Y%m%d%H%M%S)\" || true
    fi
    $PH_SUDO mv \"\$TMP\" /usr/local/bin/product-vhost || { echo PVHOST:MV_FAIL; exit 0; }

    GOT=\$($PH_SUDO sha256sum /usr/local/bin/product-vhost | cut -d' ' -f1)
    if [ \"\$GOT\" != '$want' ]; then echo \"PVHOST:SUM_MISMATCH \$GOT\"; exit 0; fi
    if ! $PH_SUDO nginx -t >/dev/null 2>&1; then echo PVHOST:POST_RED; exit 0; fi
    echo PVHOST:OK
  ") || { red "  ✗ не смог положить product-vhost на $PH_TARGET"; return 1; }

  grep -v '^PVHOST:' <<<"$out"
  case "$(grep -o '^PVHOST:[A-Z_]*' <<<"$out" | tail -1)" in
    PVHOST:OK)
      green "  ✓ product-vhost обновлён (sha ${want:0:12}), пробы пройдены, nginx -t зелёный"
      return 0 ;;
    PVHOST:PARSE_FAIL)
      red "  ✗ product-vhost ИЗ ПРОД-КОММИТА ${PH_PROD_SHA:0:8} не разбирается sh -n — живой файл не тронут"; return 1 ;;
    PVHOST:PROBE_FAIL)
      red "  ✗ product-vhost из прод-коммита не отбивает непонятый аргумент ДО записи — живой файл не тронут"
      red "    Это ровно дефект 21.09.2026. Чинить scripts/product-vhost, а не машину"; return 1 ;;
    PVHOST:SUM_MISMATCH)
      red "  ✗ после подмены sha не совпала — бэкап в /var/backups/linkeon, разбираться руками"; return 1 ;;
    PVHOST:POST_RED)
      red "  ✗ nginx -t покраснел ПОСЛЕ подмены product-vhost. Сам скрипт nginx не читает,"
      red "    значит красным стало что-то ещё — смотреть ssh $PH_TARGET 'nginx -t'"; return 1 ;;
    *)
      red "  ✗ выкат product-vhost не подтвердился — вывод выше"; return 1 ;;
  esac
}

# Ждём, пока агент хоста не перестанет брать задания.
#
# Сторож занятости в product-host-agent-install.sh НЕ ПРОДАВЛИВАЕТСЯ (FORCE=1
# здесь запрещён). Он написан ровно против той аварии, которой стоит бояться:
# переустановка сносит dist из-под живого процесса, а restart убивает его
# `docker run` вместе с control-group — подчистка не отрабатывает, и на хосте
# остаётся полусозданный продукт. В конвейере сторож будет срабатывать часто
# (агент берёт sleep/wake задания пачками), поэтому конвейер не давит его, а
# ЖДЁТ — это единственный способ и не сломать продукт, и не оставить агента
# вечно отстающим.
#
# Предикат — дословно тот же, что у сторожа (строки `[host] задание ` за
# последние 10 минут = серверный PROVISION_DEADLINE_MIN). Иначе «я вижу
# свободно» и «сторож видит занято» разошлись бы, и ожидание кончалось бы
# отказом установщика.
#
# Окно в 10 минут означает, что «свободно» наступает лишь через 10 минут после
# ПОСЛЕДНЕГО задания. Умолчание 900 с покрывает одно задание с запасом.
wait_host_agent_idle() {
  local max="${PRODUCTS_HOST_WAIT_SECONDS:-900}" waited=0 step=30 busy
  while :; do
    busy=$(ssh_remote "
      set -uo pipefail
      $PH_SUDO journalctl -u linkeon-host-agent --since '-10 min' -o cat 2>/dev/null \
        | grep -c '\[host\] задание ' || true
    " | tail -1 | tr -d '[:space:]')
    [[ "$busy" =~ ^[0-9]+$ ]] || busy=""
    if [[ "$busy" == "0" ]]; then
      [[ $waited -gt 0 ]] && green "  ✓ агент освободился через ${waited}s"
      return 0
    fi
    if [[ -z "$busy" ]]; then
      red "  ✗ не смог прочитать журнал агента — занятость неизвестна, переустанавливать нельзя"
      return 1
    fi
    if (( waited >= max )); then
      red "  ✗ агент всё ещё берёт задания ($busy шт. за 10 мин) спустя ${waited}s"
      return 1
    fi
    echo "  агент занят ($busy заданий за 10 мин) — жду ${step}s (${waited}/${max}s)"
    sleep "$step"
    waited=$(( waited + step ))
  done
}

# Возвращает 0, если агент хоста в порядке (или приведён в порядок), иначе 1.
#
# Код агента берётся ИЗ ВЫКЛАДКИ ПРОД-КОММИТА ($PH_SRC_DIR, см.
# resolve_prod_source). Поэтому здесь больше нет ни сверки «локальный HEAD
# против прода», ни требования чистого рабочего дерева: агенту достаётся ровно
# тот код, по которому работает сервер, а незакоммиченная правка уехать не
# может — её нет в коммите. Инвариант «агент не новее сервера» держится по
# построению, а не проверкой, которая срабатывала почти никогда.
ensure_host_agent() {
  bold "[машина $PH_ID 3/3] агент хоста на $PH_TARGET"
  local src="$PH_SRC_DIR/product-runner"

  # 1. Нужна ли переустановка. Сравнение — ПО СОДЕРЖИМОМУ (rsync --checksum),
  #    а не по времени: git checkout переставляет mtime у всего дерева, и
  #    сравнение по времени объявляло бы «разошлось» после каждого
  #    переключения ветки. Флаги и исключения — дословно как у установщика,
  #    иначе «я вижу совпало» и «установщик копирует» разошлись бы.
  #    Первый символ строки itemize: '.' — менять содержимое не нужно (разница
  #    только в атрибутах), всё прочее ('>', 'c', '<') — настоящая передача.
  #    Отдельно про '.': у выкладки git archive mtime у ВСЕХ файлов один —
  #    время коммита, а не время чекаута. Сравнение по времени объявляло бы
  #    «разошлось» после каждого выката; --checksum и фильтр по '.' делают
  #    разницу во времени невидимой, как и было задумано.
  local pending
  pending=$(rsync -az --checksum --dry-run --itemize-changes \
              --exclude node_modules --exclude .git --exclude .env --exclude dist \
              "$src/" "$PH_TARGET:/opt/linkeon-host-agent/" 2>/dev/null \
            | grep -vE '^\.' || true)

  # 2. Состояние машины: собран ли dist из ТЕХ ЖЕ исходников и крутится ли
  #    процесс, запущенный ПОСЛЕ сборки. Совпадения исходников мало: сборка
  #    могла упасть (тогда dist старше исходников), а переустановка — не дойти
  #    до restart (тогда процесс старше dist). И то и другое снаружи выглядит
  #    как «агент стоит свежий».
  local hs
  hs=$(ssh_remote "
    set -uo pipefail
    D=/opt/linkeon-host-agent
    echo ACTIVE=\$($PH_SUDO systemctl is-active linkeon-host-agent 2>/dev/null)
    echo ENABLED=\$($PH_SUDO systemctl is-enabled linkeon-host-agent 2>/dev/null)
    echo PID=\$($PH_SUDO systemctl show -p MainPID --value linkeon-host-agent 2>/dev/null)
    echo NRESTARTS=\$($PH_SUDO systemctl show -p NRestarts --value linkeon-host-agent 2>/dev/null)
    T=\$($PH_SUDO systemctl show -p ActiveEnterTimestamp --value linkeon-host-agent 2>/dev/null)
    if [ -n \"\$T\" ]; then echo UNIT_START=\$(date -d \"\$T\" +%s 2>/dev/null || echo 0); else echo UNIT_START=0; fi
    if [ -f \$D/dist/host/index.js ]; then echo DIST=\$($PH_SUDO stat -c %Y \$D/dist/host/index.js); else echo DIST=0; fi
    echo SRC=\$($PH_SUDO find \$D -path \$D/node_modules -prune -o -path \$D/dist -prune -o -type f -printf '%T@\n' 2>/dev/null \
                 | sort -n | tail -1 | cut -d. -f1)
  ") || { red "  ✗ не смог опросить агента на $PH_TARGET"; return 1; }

  local active enabled pid nrestarts unit_start dist_mtime src_mtime
  active=$(sed -n 's/^ACTIVE=//p'    <<<"$hs" | tail -1)
  enabled=$(sed -n 's/^ENABLED=//p'  <<<"$hs" | tail -1)
  pid=$(sed -n 's/^PID=//p'          <<<"$hs" | tail -1)
  nrestarts=$(sed -n 's/^NRESTARTS=//p' <<<"$hs" | tail -1)
  unit_start=$(sed -n 's/^UNIT_START=//p' <<<"$hs" | tail -1)
  dist_mtime=$(sed -n 's/^DIST=//p'  <<<"$hs" | tail -1)
  src_mtime=$(sed -n 's/^SRC=//p'    <<<"$hs" | tail -1)
  [[ "$unit_start" =~ ^[0-9]+$ ]] || unit_start=0
  [[ "$dist_mtime" =~ ^[0-9]+$ ]] || dist_mtime=0
  [[ "$src_mtime"  =~ ^[0-9]+$ ]] || src_mtime=0

  # Допуск 300 с: rsync -a привозит на машину ЛОКАЛЬНЫЕ mtime, и секундный
  # перекос часов между маком и хостом не должен читаться как «сборка
  # отстала». Настоящее отставание (упавшая сборка) измеряется часами.
  local reasons=""
  [[ -n "$pending" ]]                         && reasons="$reasons исходники"
  (( dist_mtime == 0 ))                       && reasons="$reasons нет-dist"
  (( dist_mtime > 0 && src_mtime > dist_mtime + 300 )) && reasons="$reasons сборка-старее-исходников"
  (( dist_mtime > 0 && unit_start > 0 && unit_start + 300 < dist_mtime )) && reasons="$reasons процесс-старее-сборки"
  [[ "$active" != "active" ]]                 && reasons="$reasons юнит-не-active"
  # `active` без процесса — не придирка: именно так выглядит юнит, чей
  # ExecStart указывает в никуда (203/EXEC), пока systemd поднимает его раз в
  # пять секунд. См. StartLimitBurst в linkeon-host-agent.service.
  [[ -z "$pid" || "$pid" == "0" ]]            && reasons="$reasons нет-процесса"
  # NRestarts НЕ повод переустанавливать: единичный давний перезапуск ничего
  # не говорит о текущем коде, а переустановка ради него — это лишний рестарт
  # агента на каждом деплое. Но сказать о нём надо: это единственный внешний
  # признак «агент не может стартовать» (процесс всегда «только что жив»).
  [[ "$nrestarts" =~ ^[0-9]+$ ]] && (( nrestarts > 0 )) \
    && bold "  ⚠ агент перезапускался $nrestarts раз с момента старта юнита — посмотреть journalctl не лишнее"

  if [[ -z "$reasons" ]]; then
    green "  ✓ код агента совпадает с прод-коммитом ${PH_PROD_SHA:0:8}, dist собран из него, процесс запущен после сборки"
    [[ "$enabled" == "enabled" ]] || red "  ! юнит НЕ в автозагрузке (is-enabled=$enabled) — перезагрузку машины не переживёт"
    host_agent_watch || return 1
    return 0
  fi

  red "  ! агент хоста требует переустановки:$reasons"
  [[ -n "$pending" ]] && { echo "      что разошлось (rsync --checksum):"; head -20 <<<"$pending" | sed 's/^/        /'; }
  if [[ -n "${PH_CHECK_ONLY:-}" ]]; then
    red "  ✗ режим проверки (PRODUCTS_HOST_CHECK_ONLY/SMOKE_ONLY) — не переустанавливаю"
    return 1
  fi

  # Сироты прошлых выкатов: rsync идёт БЕЗ --delete (с ним на этом проекте уже
  # сносили .env), поэтому файл, удалённый из репозитория, останется на
  # машине. Для агента это не поломка — лишний .ts просто соберётся в dist и
  # никем не будет импортирован, — но знать о нём надо, молчание здесь и есть
  # то, как сироты зеленят проверку.
  local orphans
  orphans=$(ssh_remote "
    set -uo pipefail
    cd /opt/linkeon-host-agent 2>/dev/null || exit 0
    $PH_SUDO find . -path ./node_modules -prune -o -path ./dist -prune -o -path ./.git -prune -o -type f -print 2>/dev/null \
      | sed 's|^\./||' | sort
  ") || orphans=""
  if [[ -n "$orphans" ]]; then
    local here extra
    here=$( (cd "$src" && find . -path ./node_modules -prune -o -path ./dist -prune -o -type f -print) \
            | sed 's|^\./||' | sort )
    extra=$(comm -23 <(printf '%s\n' "$orphans") <(printf '%s\n' "$here") | grep -v '^\.env$' || true)
    [[ -n "$extra" ]] && { red "  ! на машине есть файлы, которых нет в репозитории (rsync без --delete их не уберёт):"; head -10 <<<"$extra" | sed 's/^/        /'; }
  fi

  bold "  жду, пока агент освободится (сторож занятости НЕ продавливается)"
  if ! wait_host_agent_idle; then
    red "  ✗ агент занят — переустановку НЕ делаю."
    red "    FORCE=1 здесь запрещён: он сносит dist из-под живого процесса, а restart убивает"
    red "    его docker run вместе с control-group — подчистка не отработает, и на хосте"
    red "    останется полусозданный продукт."
    red "    Прод выкачен и зелёный; агент остался на прежнем коде — это ЧЕСТНЫЙ ОТКАЗ заданий,"
    red "    а не тихая поломка. Повторить, когда освободится (все машины либо только эту):"
    red "      PRODUCTS_HOST_ONLY=1 bash $LOCAL_BACK_DIR/scripts/deploy.sh"
    red "      PRODUCTS_HOST_ONLY=1 PRODUCTS_HOST=$PH_ID bash $LOCAL_BACK_DIR/scripts/deploy.sh"
    red "    Посмотреть, чем он занят:  ssh $PH_TARGET 'journalctl -u linkeon-host-agent -f'"
    return 1
  fi

  # Саму установку делает штатный установщик — он уже умеет всё, что здесь
  # пришлось бы повторить (поиск node/npm, проверка конфига и формы токена,
  # сборка, подстановка юнита) и ДОКАЗЫВАЕТ, что агент работает, а не просто
  # active. Второго способа ставить агента заводить нельзя: разошлись бы.
  #
  # FORCE НЕ ПЕРЕДАЁМ. Его собственный сторож перепроверит занятость ещё раз,
  # уже вплотную к первому изменению, — это и закрывает гонку между нашим
  # «свободно» и его стартом. Отказ на этом месте безвреден: сторож стоит ДО
  # первого изменения на машине.
  #
  # AGENT_SRC — выкладка прод-коммита. Сам УСТАНОВЩИК при этом берётся свежий,
  # из текущего чекаута, а не из прод-коммита: на машину он не выкатывается, он
  # процедура установки, и его собственные исправления не должны ждать
  # следующего выката бэкенда. Без AGENT_SRC (ручной запуск, мимо deploy.sh) он
  # по-прежнему раскладывает product-runner из рабочего дерева рядом с собой.
  bold "  ставлю агента: scripts/product-host-agent-install.sh $PH_TARGET (код из ${PH_PROD_SHA:0:8})"
  if ! AGENT_SRC="$src" bash "$LOCAL_BACK_DIR/scripts/product-host-agent-install.sh" "$PH_TARGET"; then
    red "  ✗ установка агента не удалась (вывод установщика выше)"
    red "    Если это отказ сторожа занятости — агент успел взять задание, пока мы шли сюда."
    red "    Ничего на машине при таком отказе не изменено. Повторить: PRODUCTS_HOST_ONLY=1"
    return 1
  fi
  green "  ✓ агент хоста переустановлен и доказан установщиком"
  return 0
}

# Наблюдение за ЖИВЫМ агентом, когда переустанавливать нечего.
#
# Агент при исправной работе не печатает НИЧЕГО: строка появляется только на
# взятом задании и на неудачном опросе. Поэтому «жив» здесь — это не
# `is-active` (у вечно перезапускающегося процесса он тоже зелёный), а окно
# тишины при живом PID.
#
# Порог не «ноль неудачных опросов»: опрос раз в 3 с, и одиночный 502 от
# прода — наблюдавшийся транзиент, а не поломка. Красным считается только
# «почти всё окно мимо»: на 20 с приходится ~6 опросов, 5 и больше неудач
# означают, что агента не пускают вовсе (чаще всего HOST_TOKEN разошёлся с
# PRODUCT_HOST_TOKEN бэкенда).
host_agent_watch() {
  local win="${PRODUCTS_HOST_WATCH_SECONDS:-20}"
  echo "      наблюдаю за опросами агента ${win}s…"
  local since
  since=$(ssh_remote "date +%s" 2>/dev/null | tail -1 | tr -d '[:space:]')
  [[ "$since" =~ ^[0-9]+$ ]] || { red "  ✗ не смог снять время на машине продуктов"; return 1; }
  sleep "$win"

  local obs fails pid_after
  obs=$(ssh_remote "
    set -uo pipefail
    echo PID=\$($PH_SUDO systemctl show -p MainPID --value linkeon-host-agent 2>/dev/null)
    echo FAILS=\$($PH_SUDO journalctl -u linkeon-host-agent --since \"@$since\" -o cat 2>/dev/null | grep -c 'опрос не удался' || true)
    # '|| true' здесь ОБЯЗАТЕЛЕН, и это не перестраховка: в блоке действует
    # pipefail, grep без совпадений возвращает 1, и статус последней команды
    # становится статусом всего ssh. ИМЕННО ЗДОРОВЫЙ агент не печатает ничего
    # — то есть без этой заглушки проверка валилась бы «не смог прочитать
    # журнал» ровно тогда, когда всё в порядке (поймано на живом хосте).
    $PH_SUDO journalctl -u linkeon-host-agent --since \"@$since\" -o cat 2>/dev/null | grep 'опрос не удался' | tail -3 || true
  ") || { red "  ✗ не смог прочитать журнал агента"; return 1; }

  pid_after=$(sed -n 's/^PID=//p' <<<"$obs" | tail -1)
  fails=$(sed -n 's/^FAILS=//p' <<<"$obs" | tail -1)
  [[ "$fails" =~ ^[0-9]+$ ]] || fails=0

  if [[ -z "$pid_after" || "$pid_after" == "0" ]]; then
    red "  ✗ у агента нет живого процесса (MainPID=$pid_after)"
    return 1
  fi
  if (( fails >= 5 )); then
    grep 'опрос не удался' <<<"$obs" | tail -3 | sed 's/^/      /' >&2
    red "  ✗ агент не может опросить Linkeon: $fails неудач за ${win}s."
    red "    HTTP 401 здесь означает, что HOST_TOKEN разошёлся с PRODUCT_HOST_TOKEN бэкенда."
    red "    Снаружи это выглядит как «кнопка Новый продукт не работает»."
    return 1
  fi
  if (( fails > 0 )); then
    grep 'опрос не удался' <<<"$obs" | tail -3 | sed 's/^/      /'
    bold "  ⚠ $fails неудачных опросов за ${win}s — похоже на транзиент, но проверить стоит"
    return 0
  fi
  green "  ✓ агент жив (pid $pid_after) и за ${win}s ни одного неудачного опроса"
  return 0
}

# Одна машина реестра: три части, все три считаются независимо.
#
# Независимо — не для симметрии: узнать о расхождении в product-vhost только
# потому, что агент оказался занят, это ровно тот способ молча не выкатиться,
# ради которого фаза написана.
products_host_one() {
  PH_ID="$1"; PH_TARGET="$2"; PH_ZONE="$3"; PH_TOKEN_HASH="$4"

  ENV_NAME="products-host/$PH_ID"
  HOST="$PH_TARGET"
  # PATH_EXPORT уходит в `export PATH=$(echo …):…` внутри ssh_remote. Здесь
  # это те же каталоги, что прописаны в PATH юнита агента: гарантируют, что
  # product-vhost, nginx и systemctl найдутся.
  PATH_EXPORT='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin'
  export ENV_NAME HOST PATH_EXPORT PH_ID PH_TARGET PH_ZONE PH_TOKEN_HASH

  bold "──────── машина «${PH_ID}» — $PH_TARGET, зона $PH_ZONE ────────"

  # Достижимость — ОТДЕЛЬНОЙ командой с BatchMode=yes, а не первым же
  # ssh_remote: у ssh_remote BatchMode нет (на проде и тесте ключи заведомо
  # есть), и без ключа он завис бы на приглашении пароля посреди деплоя.
  local ruid
  if ! ruid=$(ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 \
                  "$PH_TARGET" 'id -u' 2>/dev/null); then
    red "  ✗ машина «${PH_ID}» ($PH_TARGET) недоступна по ssh"
    red "    my.linkeon.io выкачен и зелёный — откатывать его из-за ЧУЖОЙ машины не буду."
    red "    Не доехали: агент хоста и product-vhost. Пока они отстают, задания этой"
    red "    машины либо отклоняются честно (сервер новее агента), либо не приходят вовсе."
    red "    Остальные машины реестра это не отменяет — обход продолжается."
    red "    Повторить только её:  PRODUCTS_HOST_ONLY=1 PRODUCTS_HOST=$PH_ID bash $LOCAL_BACK_DIR/scripts/deploy.sh"
    return 1
  fi
  ruid=$(tail -1 <<<"$ruid" | tr -d '[:space:]')
  # На хост продуктов ходим root'ом, на стенде — обычным пользователем с
  # NOPASSWD sudo. Логика та же, что в product-host-agent-install.sh. Считается
  # ДЛЯ КАЖДОЙ МАШИНЫ ОТДЕЛЬНО: значение, посчитанное на первой, на второй
  # означало бы либо `sudo` от root (лишний), либо его отсутствие под обычным
  # пользователем (все проверки покраснели бы разом и непонятно почему).
  if [[ "$ruid" == "0" ]]; then PH_SUDO=""; else PH_SUDO="sudo -n"; fi
  export PH_SUDO
  green "  ✓ $PH_TARGET доступен (uid=$ruid)${PH_CHECK_ONLY:+, режим проверки — на машину не пишу}"

  local fails=0
  ph_check_identity    || fails=$(( fails + 1 ))
  ensure_product_vhost || fails=$(( fails + 1 ))
  ensure_host_agent    || fails=$(( fails + 1 ))

  if (( fails == 0 )); then
    green "  ✓ машина «${PH_ID}» синхронна с прод-коммитом ${PH_PROD_SHA:0:8}"
    return 0
  fi
  red "  ✗ машина «${PH_ID}»: $fails из 3 частей не сошлись (подробности выше)"
  return 1
}

run_products_host_phase() {
  # SMOKE_ONLY по смыслу — «не катить, только проверить». Для этой фазы это
  # означает режим наблюдателя: расхождение находим и докладываем, на машины
  # не пишем ничего.
  PH_CHECK_ONLY="${PRODUCTS_HOST_CHECK_ONLY:-${SMOKE_ONLY:-}}"
  export PH_CHECK_ONLY

  # ── 1. СПИСОК МАШИН. До него фаза не знает даже, сколько их.
  bold "[реестр] машины — из product_hosts на $PROD_HOST"
  local registry rc
  registry=$(products_hosts_registry)
  rc=$?
  if (( rc == 1 )); then
    red "  ✗ PHASE 4 FAILED — список машин неизвестен, поэтому не тронута НИ ОДНА"
    red "    Умолчания здесь нет намеренно: выкат на «ту машину, что мы помним» при"
    red "    живых нескольких — это частичное расхождение, которое потом ищут руками."
    red "    my.linkeon.io НЕ откатывается: он выкачен, зелёный и к машинам продуктов"
    red "    отношения не имеет."
    return 1
  fi
  if (( rc == 2 )); then
    red "  ✗ PHASE 4 FAILED — реестр product_hosts ПУСТ: выкатывать некуда"
    red "    Это не поломка базы: 005 заводит машину own из PRODUCT_HOST_TOKEN и"
    red "    безвредно ничего не делает, если он не задан. Живые продукты при этом"
    red "    продолжают работать — просто конвейер не знает, на какой они машине."
    red "    Лечится так: PRODUCT_HOST_TOKEN в .env прода + рестарт API (005 накатится"
    red "    при старте), либо строка в product_hosts заводится запросом."
    return 1
  fi

  # ── 2. ФИЛЬТР PRODUCTS_HOST: «только эта машина». Сверяется С РЕЕСТРОМ —
  #      машины, которой в нём нет, фаза не знает ни метки, ни зоны, а значит и
  #      выкатить на неё может только «что-нибудь».
  local rows=() skipped=0 line hid target zone thash
  while IFS='|' read -r hid target zone thash; do
    [[ -n "$hid" ]] || continue
    if [[ -n "$PRODUCTS_HOST" && "$PRODUCTS_HOST" != "$hid" && "$PRODUCTS_HOST" != "$target" ]]; then
      skipped=$(( skipped + 1 )); continue
    fi
    rows+=("$hid|$target|$zone|$thash")
  done <<<"$registry"

  # Пустой массив проверяется ОТДЕЛЬНО и до цикла: `"${rows[@]}"` на пустом
  # массиве под `set -u` в bash 3.2 (это /bin/bash на маке, откуда deploy.sh и
  # запускают) — «unbound variable», то есть фаза свалилась бы с сообщением про
  # переменную вместо сообщения про машины.
  if (( ${#rows[@]} == 0 )); then
    red "  ✗ PHASE 4 FAILED — обходить нечего: ни одна строка реестра не попала в обход"
    if [[ -n "$PRODUCTS_HOST" ]]; then
      red "    PRODUCTS_HOST=$PRODUCTS_HOST не совпал ни с одной машиной. Машины реестра:"
      while IFS='|' read -r hid target zone thash; do
        [[ -n "$hid" ]] && red "      $hid → $target"
      done <<<"$registry"
      red "    Выкатывать на машину, которой в реестре нет, фаза не будет: зона доменов"
      red "    и метка берутся оттуда, и без них на машину уехало бы «что-нибудь»."
    fi
    return 1
  fi

  if [[ -n "$PRODUCTS_HOST" ]]; then
    # Печатается крупно: имя переменной общее с product-provision.sh и
    # product-backup-setup.sh, и экспортированное ради них значение сузило бы
    # обход до одной машины МОЛЧА.
    bold "  ⚠ PRODUCTS_HOST=$PRODUCTS_HOST — обход ОГРАНИЧЕН одной машиной, пропущено машин: $skipped"
  else
    green "  ✓ машин в реестре: ${#rows[@]}"
  fi

  # ── 3. ИСТОЧНИК — ОДИН НА ВСЕ МАШИНЫ, и определяется ДО обхода: все части
  #      едут из коммита, выкаченного на проде. Разные машины из разных
  #      коммитов — ровно то частичное расхождение, ради которого фаза
  #      написана. Не определился — не трогаем НИ ОДНУ машину: «поставить хоть
  #      что-нибудь» означает поставить непонятно что на машины с боевыми
  #      продуктами.
  if ! resolve_prod_source; then
    [[ -n "$PH_SRC_DIR" ]] && rm -rf "$PH_SRC_DIR"
    red "  ✗ PHASE 4 FAILED — источник выката не определён, не тронута ни одна из ${#rows[@]} машин"
    red "    my.linkeon.io НЕ откатывается: он выкачен, зелёный и к этим машинам отношения не имеет"
    return 1
  fi

  # ── 4. ОБХОД. Машины НЕЗАВИСИМЫ: недоступная не отменяет остальных — половина
  #      обновлённых лучше, чем ни одной, и лежащая машина заданий всё равно не
  #      получает. Но итог называет, сколько машин из скольких не доехало и
  #      какие именно.
  local total=0 failed=0 failed_names=""
  for line in "${rows[@]}"; do
    IFS='|' read -r hid target zone thash <<<"$line"
    total=$(( total + 1 ))

    # ФОРМА ПОЛЕЙ ПРОВЕРЯЕТСЯ ДО ПЕРВОГО ИХ УПОТРЕБЛЕНИЯ. ssh-цель уходит
    # аргументом в ssh и rsync, зона — в server_name nginx: значение вида
    # `-oProxyCommand=…` или с пробелом здесь не «мусор в выводе», а чужая
    # команда на машине оператора. Битая строка валит СВОЮ машину, а не весь
    # обход: соседние к ней отношения не имеют.
    if ! [[ "$hid" =~ ^[a-z0-9][a-z0-9_-]{0,30}$ ]] \
       || ! [[ "$target" =~ ^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$ ]] \
       || ! [[ "$zone" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] \
       || ! [[ "$thash" =~ ^[0-9a-f]{64}$ ]]; then
      red "  ✗ строка реестра не годится и машина пропущена: id='$hid' ssh='$target' зона='$zone'"
      red "    Ожидается: метка [a-z0-9_-], ssh-цель вида user@host, зона вида p.linkeon.io,"
      red "    agent_token_hash — 64 hex. Чинить строку в product_hosts."
      failed=$(( failed + 1 )); failed_names="$failed_names ${hid:-<без метки>}"
      continue
    fi

    products_host_one "$hid" "$target" "$zone" "$thash" \
      || { failed=$(( failed + 1 )); failed_names="$failed_names $hid"; }
  done

  # Выкладка убирается ЗДЕСЬ, в единственной точке выхода обхода: ранние return
  # выше неё не проходят — до resolve_prod_source временного каталога ещё нет.
  [[ -n "$PH_SRC_DIR" ]] && rm -rf "$PH_SRC_DIR"

  if (( failed == 0 )); then
    green "  ✓ PHASE 4 GREEN — обойдено машин: $total, все синхронны с прод-коммитом ${PH_PROD_SHA:0:8}"
    return 0
  fi
  red "  ✗ PHASE 4 FAILED — не доехало машин: $failed из $total —$failed_names"
  red "    Остальные выкачены: машины независимы, и лежащая соседка не повод держать их позади."
  red "    my.linkeon.io НЕ откатывается: он выкачен, зелёный и к этим машинам отношения не имеет"
  return 1
}

# ── main ──
if [[ -z "${PROD_ONLY:-}" && -z "${LANDING_ONLY:-}" && -z "${PRODUCTS_HOST_ONLY:-}" ]]; then
  bold "════════════ PHASE 1: TEST ════════════"
  run_phase test || { red "TEST phase failed — НЕ КАЧУ НА ПРОД"; exit 1; }
fi

if [[ -z "${TEST_ONLY:-}" && -z "${LANDING_ONLY:-}" && -z "${PRODUCTS_HOST_ONLY:-}" ]]; then
  bold "════════════ PHASE 2: PROD ════════════"
  run_phase prod || exit 2
fi

# PHASE 4 стоит ЗДЕСЬ, между второй и третьей, и это не опечатка — см. шапку
# файла: номер отражает время появления, а место выбрано так, чтобы выкат
# машины продуктов не зависел от постороннего лендинга (его красный смок
# уводит скрипт в exit 3 и пропустил бы эту фазу молча).
#
# TEST_ONLY/LANDING_ONLY исключены: это прогоны «прод не трогаем», а машина
# продуктов — продовая сторона. Догнать её отдельно можно в любой момент:
# PRODUCTS_HOST_ONLY=1 (источником всё равно будет коммит, который на проде).
if [[ -z "${TEST_ONLY:-}" && -z "${LANDING_ONLY:-}" && -z "${SKIP_PRODUCTS_HOST:-}" ]]; then
  bold "════════════ PHASE 4: PRODUCTS HOST ════════════"
  # Ненулевой код НЕ откатывает my.linkeon.io и не отменяет уже сделанное:
  # прод к этому моменту выкачен и зелёный, а лежит СОСЕДНЯЯ машина. Падение
  # лишь снимает «ALL PHASES GREEN» и называет, что именно не доехало.
  run_products_host_phase || PRODUCTS_HOST_RC=4
fi

if [[ -n "${LANDING_ONLY:-}" || -n "${WITH_LANDING:-}" ]]; then
  bold "════════════ PHASE 3: LANDING ════════════"
  run_landing_phase || exit 3
fi

# Код фазы 4 отдаём в самом конце, а не сразу: лендинг (если его просили) —
# посторонний продукт, и недоехавшая машина продуктов не повод его не катить.
if [[ -n "${PRODUCTS_HOST_RC:-}" ]]; then
  red "════════════════════════════════════════════════════════════════════"
  red "  ✗ PHASE 4 (PRODUCTS HOST) не прошла — остальные фазы выкачены"
  red "    Какие машины не доехали и почему — в выводе фазы выше."
  red "    Повторить все машины:  PRODUCTS_HOST_ONLY=1 bash $LOCAL_BACK_DIR/scripts/deploy.sh"
  red "    Повторить одну:        PRODUCTS_HOST_ONLY=1 PRODUCTS_HOST=<метка> bash $LOCAL_BACK_DIR/scripts/deploy.sh"
  red "════════════════════════════════════════════════════════════════════"
  exit "$PRODUCTS_HOST_RC"
fi

green "════════════════════════════════════════════════════════════════════"
green "  ✓ ALL PHASES GREEN"
green "════════════════════════════════════════════════════════════════════"
