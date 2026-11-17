#!/usr/bin/env bash
# Официальный выкат relay-agent на r.linkeon.io. Не входит в deploy.sh.
# Использование: bash scripts/deploy-relay.sh <BASE_SHA> <TARGET_SHA>
# BASE_SHA — коммит, чьё содержимое relay-agent совпадает с живым релеем.
#
# Ожидание перед заменой (с 16.11.2026, пункт бэклога aa27b1d5):
#   RELAY_DRAIN_MODE=quiet (по умолчанию) — ждать тишины БЕЗ шлагбаума (ни одного
#     принятого /chat и ни одного процесса CLI), потом поставить шлагбаум и
#     перепроверять тишину не дольше DRAIN_GATE_WINDOW_SECONDS (45 с). Ход
#     проскочил под шлагбаум и не закончился за окно — шлагбаум снимается,
#     ожидание тишины начинается заново.
#     Окно держать меньше КОРОТКОГО бюджета повтора бэка (~59 с — «чистый
#     вопрос» и вызовы из звонка; полный бюджет ~149 с,
#     src/chat/relay-drain-retry.ts): поверх окна идут ещё замена, рестарт и
#     health. Жёсткого верхнего предела скрипт не ставит.
#   RELAY_DRAIN_MODE=gate — прежний порядок, для аварийного выката, когда тишины
#     не дождаться: шлагбаум сразу, ждать тишины под ним.
#   DRAIN_WAIT_SECONDS (1800) — сколько всего ждать тишины.
#   Оба числа — целые секунды без ведущих нулей, иначе выход 2 до git и ssh.
# Релей без inflight в /health (legacy) выкатывается по-прежнему — шлагбаумом в nginx.
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Использование: bash scripts/deploy-relay.sh <BASE_SHA> <TARGET_SHA>" >&2
  exit 2
fi

BASE_SHA=$1
TARGET_SHA=$2
RELAY_HOST=${RELAY_HOST:-dv@5.101.115.184}
DRAIN_FILE=${RELAY_DRAIN_FILE:-/tmp/linkeon-relay-drain}
LOCK_FILE=${RELAY_DEPLOY_LOCK_FILE:-/tmp/linkeon-relay-deploy.lock}
NGINX_CONF=${RELAY_NGINX_CONF:-/etc/nginx/conf.d/parking.conf}
DRAIN_WAIT_SECONDS=${DRAIN_WAIT_SECONDS:-1800}
RELAY_DRAIN_MODE=${RELAY_DRAIN_MODE:-quiet}
DRAIN_GATE_WINDOW_SECONDS=${DRAIN_GATE_WINDOW_SECONDS:-45}
# Проверка до git и ssh: опечатка в режиме не должна молча включить другой порядок.
if [[ "$RELAY_DRAIN_MODE" != quiet && "$RELAY_DRAIN_MODE" != gate ]]; then
  echo "RELAY_DRAIN_MODE=$RELAY_DRAIN_MODE: допустимо quiet или gate" >&2
  exit 2
fi
# Секунды — без ведущих нулей: в (( )) bash читает 090 как восьмеричное
# (ошибка), а 010 — как 8. Регулярка в переменной — так её одинаково понимает
# и bash 3.2 на маке.
WHOLE_SECONDS_RE='^(0|[1-9][0-9]*)$'
if [[ ! "$DRAIN_WAIT_SECONDS" =~ $WHOLE_SECONDS_RE ]]; then
  echo "DRAIN_WAIT_SECONDS=$DRAIN_WAIT_SECONDS: нужно целое число секунд без ведущих нулей" >&2
  exit 2
fi
if [[ ! "$DRAIN_GATE_WINDOW_SECONDS" =~ $WHOLE_SECONDS_RE ]]; then
  echo "DRAIN_GATE_WINDOW_SECONDS=$DRAIN_GATE_WINDOW_SECONDS: нужно целое число секунд без ведущих нулей" >&2
  exit 2
fi
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

git cat-file -e "${BASE_SHA}^{commit}"
git cat-file -e "${TARGET_SHA}^{commit}"
BASE_SHORT=$(git rev-parse --short=12 "$BASE_SHA")
TARGET_SHORT=$(git rev-parse --short=12 "$TARGET_SHA")
STAGE="file-agent-stage-${TARGET_SHORT}"
BASE_DIR="file-agent-base-${BASE_SHORT}"

PUT=()
DEL=()
ADD=()
FILES=()
while read -r status file; do
  [[ -n "$status" && -n "$file" ]] || continue
  if [[ ! "$file" =~ ^relay-agent/[A-Za-z0-9._-]+$ ]]; then
    echo "Небезопасный или неплоский путь в relay-agent: $file" >&2
    exit 2
  fi
  name=${file#relay-agent/}
  FILES+=("$name")
  if [[ "$status" == D ]]; then
    DEL+=("$name")
  elif [[ "$status" == A || "$status" == M ]]; then
    PUT+=("$name")
    if [[ "$status" == A ]]; then ADD+=("$name"); fi
  else
    echo "Неподдерживаемый тип изменения $status для $file" >&2
    exit 2
  fi
done < <(git diff --name-status --no-renames "$BASE_SHA" "$TARGET_SHA" -- relay-agent/)

if [[ ${#FILES[@]} -eq 0 ]]; then
  echo "relay-agent между $BASE_SHA и $TARGET_SHA не изменился — выкат не нужен"
  exit 0
fi

join_csv() {
  local IFS=,
  echo "$*"
}
FILES_CSV=$(join_csv "${FILES[@]+"${FILES[@]}"}")
PUT_CSV=$(join_csv "${PUT[@]+"${PUT[@]}"}")
DEL_CSV=$(join_csv "${DEL[@]+"${DEL[@]}"}")
ADD_CSV=$(join_csv "${ADD[@]+"${ADD[@]}"}")

printf 'Изменённые файлы relay-agent: %s\n' "$FILES_CSV"
LOCAL_BUNDLE=$(mktemp -d)
trap 'rm -rf "$LOCAL_BUNDLE"' EXIT
mkdir "$LOCAL_BUNDLE/$STAGE" "$LOCAL_BUNDLE/$BASE_DIR"
git archive "$TARGET_SHA" relay-agent | tar -x -C "$LOCAL_BUNDLE/$STAGE" --strip-components=1
git archive "$BASE_SHA" relay-agent | tar -x -C "$LOCAL_BUNDLE/$BASE_DIR" --strip-components=1

cat > "$LOCAL_BUNDLE/$STAGE/deploy-relay-remote.sh" <<'REMOTE'
set -euo pipefail
DRAIN_FILE=${DRAIN_FILE:-/tmp/linkeon-relay-drain}
NGINX_CONF=${NGINX_CONF:-/etc/nginx/conf.d/parking.conf}
DRAIN_WAIT_SECONDS=${DRAIN_WAIT_SECONDS:-1800}
RELAY_DRAIN_MODE=${RELAY_DRAIN_MODE:-quiet}
DRAIN_GATE_WINDOW_SECONDS=${DRAIN_GATE_WINDOW_SECONDS:-45}
# Релей проверяет сам, до marker и nginx: опечатка в режиме не должна молча
# включить другой порядок.
if [[ "$RELAY_DRAIN_MODE" != quiet && "$RELAY_DRAIN_MODE" != gate ]]; then
  echo "RELAY_DRAIN_MODE=$RELAY_DRAIN_MODE: допустимо quiet или gate" >&2
  exit 2
fi
# Секунды — без ведущих нулей: в (( )) bash читает 090 как восьмеричное.
WHOLE_SECONDS_RE='^(0|[1-9][0-9]*)$'
if [[ ! "$DRAIN_WAIT_SECONDS" =~ $WHOLE_SECONDS_RE ]]; then
  echo "DRAIN_WAIT_SECONDS=$DRAIN_WAIT_SECONDS: нужно целое число секунд без ведущих нулей" >&2
  exit 2
fi
if [[ ! "$DRAIN_GATE_WINDOW_SECONDS" =~ $WHOLE_SECONDS_RE ]]; then
  echo "DRAIN_GATE_WINDOW_SECONDS=$DRAIN_GATE_WINDOW_SECONDS: нужно целое число секунд без ведущих нулей" >&2
  exit 2
fi
SUDO=${SUDO:-sudo}
GATE_CREATED=0
NGINX_DRAIN=0
REPLACED=0
# Последняя проверка тишины — для строки прогресса оператору.
RELAY_CHILDREN=0
RELAY_INFLIGHT='не проверялся'

if [[ -e "$DRAIN_FILE" ]]; then
  echo "Drain marker уже существует — другой выкат или аварийный drain ещё активен" >&2
  exit 1
fi

inflight_count() {
  curl -fsS --max-time 5 http://127.0.0.1:3033/health | node -e '
    let raw = "";
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => {
      const health = JSON.parse(raw);
      const inflight = health.inflight === undefined ? "legacy" : health.inflight;
      if (inflight !== "legacy" && (!Number.isInteger(inflight) || inflight < 0)) process.exit(1);
      console.log(inflight);
    });
  '
}

# PID перечитывается при каждой проверке: за полчаса ожидания PM2 может
# перезапустить file-agent, и процессы CLI нового процесса висят на новом pid.
# Pid нет (file-agent перезапускается или упал) — тишину не засчитываем.
relay_has_children() {
  local CHILDREN
  PID=$(pm2 pid file-agent || true)
  if [[ ! "$PID" =~ ^[1-9][0-9]*$ ]]; then
    RELAY_CHILDREN='?'
    echo "PM2 file-agent сейчас без pid ($PID) — тишину не засчитываем" >&2
    return 0
  fi
  CHILDREN=$(ps --ppid "$PID" -o pid= || true)
  RELAY_CHILDREN=$(grep -c . <<< "$CHILDREN" || true)
  (( RELAY_CHILDREN > 0 ))
}

# Тишина на релее: ни одного процесса CLI (PM2 children) и ни одного принятого
# /chat (inflight). Зовётся в условии цикла — там set -e не действует, поэтому
# сбой health разбирается явно: не ответил — не тихо.
relay_quiet() {
  local inflight
  RELAY_INFLIGHT='не проверялся'
  if relay_has_children; then return 1; fi
  if ! inflight=$(inflight_count); then
    RELAY_INFLIGHT='нет ответа health'
    echo "health релея не ответил при проверке тишины" >&2
    return 1
  fi
  RELAY_INFLIGHT=$inflight
  [[ "$inflight" =~ ^[0-9]+$ ]] && (( inflight == 0 ))
}

# Marker ставится атомарно и только если его ещё нет: ln, в отличие от mv, не
# перезаписывает существующий файл. В quiet выкат ждёт тишины до
# DRAIN_WAIT_SECONDS; если за это время кто-то вручную поставил свой marker
# (аварийный drain), его нельзя ни затереть, ни потом снять. Выход — при
# GATE_CREATED=0, поэтому finish_rollout чужой marker не трогает. То же
# правило, что проверка marker в начале, только позже по времени.
# ln -T (релей — GNU/Linux): каталог на месте DRAIN_FILE не проглотит ссылку
# внутрь себя, ln просто откажет.
gate_on() {
  local tmp="$DRAIN_FILE.tmp.$$"
  ( umask 077; printf '%s\n' "$TARGET_SHORT" > "$tmp" )
  if ! ln -T "$tmp" "$DRAIN_FILE" 2>/dev/null; then
    rm -f -- "$tmp"
    if [[ -e "$DRAIN_FILE" ]]; then
      echo "Чужой drain marker появился во время ожидания — выкат остановлен, marker не тронут" >&2
    else
      echo "Не удалось поставить drain marker $DRAIN_FILE — выкат остановлен" >&2
    fi
    exit 1
  fi
  rm -f -- "$tmp"
  GATE_CREATED=1
  echo "Drain marker поставлен ($DRAIN_FILE)"
}

# Снять marker этого выката ДО замены файлов (quiet: ход проскочил под
# шлагбаум). После замены marker снимает только health_and_release.
gate_off() {
  rm -f -- "$DRAIN_FILE"
  GATE_CREATED=0
}

nginx_worker_pids() {
  local master
  master=$(cat /var/run/nginx.pid)
  ps -eo pid=,ppid=,comm= | awk -v master="$master" '$2 == master && $3 == "nginx" { print $1 }'
}

legacy_workers_drained() {
  local pid
  for pid in $LEGACY_NGINX_WORKERS; do
    if ps -p "$pid" -o pid= >/dev/null 2>&1; then
      return 1
    fi
  done
  return 0
}

nginx_files_proxy() {
  if $SUDO grep -q '# LINKEON-RELAY-FILES-PROXY' "$NGINX_CONF"; then
    return 0
  fi
  $SUDO python3 - "$NGINX_CONF" <<'PY'
import os
import stat
import sys

path = sys.argv[1]
with open(path, encoding="utf-8") as source:
    text = source.read()
old = '''    # Agent output files — direct download
    location /files/ {
        alias /tmp/agent-output/;
        add_header Access-Control-Allow-Origin "*" always;
    }'''
new = '''    # Agent output files — relay reads private session directories
    location /files/ {
        # LINKEON-RELAY-FILES-PROXY
        proxy_pass http://127.0.0.1:3033;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_hide_header Access-Control-Allow-Origin;
        add_header Access-Control-Allow-Origin "*" always;
    }'''
if old not in text:
    raise SystemExit("Nginx /files/ block is missing or differs from the legacy alias; refusing to guess")
temporary = path + ".relay-files-proxy.tmp"
with open(temporary, "w", encoding="utf-8") as output:
    output.write(text.replace(old, new, 1))
os.chmod(temporary, stat.S_IMODE(os.stat(path).st_mode))
os.replace(temporary, path)
PY
  $SUDO nginx -t
  $SUDO nginx -s reload
  echo "Nginx /files/: proxy через relay, alias в закрытые каталоги снят"
}

nginx_drain_on() {
  LEGACY_NGINX_WORKERS=$(nginx_worker_pids)
  $SUDO python3 - "$NGINX_CONF" <<'PY'
import os
import stat
import sys

path = sys.argv[1]
with open(path, encoding="utf-8") as source:
    text = source.read()
marker = "# LINKEON-RELAY-DRAIN"
if marker in text:
    raise SystemExit("Nginx drain marker already exists")
needle = "location /chat {"
position = text.index(needle) + len(needle)
text = text[:position] + "\n        # LINKEON-RELAY-DRAIN\n        return 503;" + text[position:]
temporary = path + ".relay-drain.tmp"
with open(temporary, "w", encoding="utf-8") as output:
    output.write(text)
os.chmod(temporary, stat.S_IMODE(os.stat(path).st_mode))
os.replace(temporary, path)
PY
  # Блок уже в конфиге — с этого момента сбой (nginx -t, reload, проверка)
  # снимает его через health_and_release → nginx_drain_off.
  NGINX_DRAIN=1
  $SUDO nginx -t
  $SUDO nginx -s reload
  for attempt in $(seq 1 20); do
    CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST https://r.linkeon.io/chat)
    if [[ "$CODE" == 503 ]] && curl -fsS --max-time 5 http://127.0.0.1:3033/health >/dev/null; then
      echo "legacy Nginx drain: /chat=503, /health доступен"
      return 0
    fi
    sleep 1
  done
  echo "Не удалось подтвердить legacy Nginx drain" >&2
  return 1
}

nginx_drain_off() {
  $SUDO python3 - "$NGINX_CONF" <<'PY'
import os
import stat
import sys

path = sys.argv[1]
with open(path, encoding="utf-8") as source:
    text = source.read()
block = "        # LINKEON-RELAY-DRAIN\n        return 503;"
if block not in text:
    raise SystemExit("Nginx drain block not found")
text = text.replace(block, "", 1)
temporary = path + ".relay-drain.tmp"
with open(temporary, "w", encoding="utf-8") as output:
    output.write(text)
os.chmod(temporary, stat.S_IMODE(os.stat(path).st_mode))
os.replace(temporary, path)
PY
  $SUDO nginx -t
  $SUDO nginx -s reload
  for attempt in $(seq 1 20); do
    CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST https://r.linkeon.io/chat)
    if [[ "$CODE" != 503 ]] && curl -fsS --max-time 5 http://127.0.0.1:3033/health >/dev/null; then
      NGINX_DRAIN=0
      echo "legacy Nginx drain снят после health"
      return 0
    fi
    sleep 1
  done
  echo "Не удалось снять legacy Nginx drain" >&2
  return 1
}

health_and_release() {
  for attempt in $(seq 1 120); do
    if curl -fsS --max-time 5 http://127.0.0.1:3033/health; then
      rm -f -- "$DRAIN_FILE"
      GATE_CREATED=0
      if [[ "$NGINX_DRAIN" -eq 1 ]] && ! nginx_drain_off; then
        echo "Health есть, но legacy Nginx drain не снят — admission остаётся закрытым" >&2
        return 1
      fi
      printf '\nhealth OK, drain снят\n'
      return 0
    fi
    sleep 1
  done
  echo "health не прошёл, drain marker сохранён" >&2
  return 1
}

restore_previous() {
  cd ~/file-agent
  IFS=',' read -ra PUT <<< "$PUT_CSV"
  for file in "${PUT[@]+"${PUT[@]}"}"; do
    [[ -n "$file" ]] || continue
    if [[ ",$ADD_CSV," == *",$file,"* ]]; then
      rm -f -- "$file"
    else
      cp ~/"$BASE_DIR"/"$file" ".$file.rollback.tmp"
      mv ".$file.rollback.tmp" "$file"
    fi
  done
  if [[ -n "$DEL_CSV" ]]; then
    IFS=',' read -ra DEL <<< "$DEL_CSV"
    for file in "${DEL[@]+"${DEL[@]}"}"; do
      cp ~/"$BASE_DIR"/"$file" ".$file.rollback.tmp"
      mv ".$file.rollback.tmp" "$file"
    done
  fi
  while read -r module; do
    [[ -f "$module" ]] || { echo "При откате нет локального импорта $module" >&2; exit 1; }
  done < <(grep -ohE 'from "\./[^"]+"' *.mjs | cut -d'"' -f2 | sort -u)
  git add -A -- "${FILES[@]+"${FILES[@]}"}"
  git commit -q -m "rollback relay-agent к $BASE_DIR"
  pm2 restart file-agent >/dev/null
}

finish_rollout() {
  local status=$?
  trap - EXIT
  if [[ "$GATE_CREATED" -eq 0 ]]; then
    exit "$status"
  fi

  if [[ "$status" -eq 0 ]] && health_and_release; then
    echo "relay-agent $TARGET_SHORT выкачен, admission открыт"
    exit 0
  fi

  if [[ "$REPLACED" -eq 1 ]]; then
    echo "Откат прежнего дерева при закрытом admission" >&2
    restore_previous
  fi

  if health_and_release; then
    echo "Прежнее дерево работает, admission открыт" >&2
  else
    echo "КРИТИЧНО: rollback health не прошёл, admission остаётся закрытым" >&2
  fi
  if [[ "$status" -eq 0 ]]; then
    exit 1
  fi
  exit "$status"
}
trap finish_rollout EXIT

cd ~/"$STAGE"
ln -s ~/file-agent/node_modules node_modules
for file in *.mjs; do
  node --check "$file"
done
node --test *.test.mjs
RELAY_LIVE_CLI_WRITE_TEST=1 node --test sandbox-write-live.test.mjs

cd ~/file-agent
if ! git diff --cached --quiet; then
  echo "В git релея есть посторонние staged-изменения — ничего не заменено" >&2
  exit 1
fi
IFS=',' read -ra FILES <<< "$FILES_CSV"
for file in "${FILES[@]+"${FILES[@]}"}"; do
  if [[ ",$ADD_CSV," == *",$file,"* ]]; then
    if [[ -e "$file" ]]; then
      echo "Новый $file уже существует на релее — есть несогласованная правка, ничего не заменено" >&2
      exit 1
    fi
  elif ! cmp -s ~/"$BASE_DIR"/"$file" "$file"; then
    echo "Живой $file отличается от BASE_SHA — есть несогласованная правка, ничего не заменено" >&2
    exit 1
  fi
done

nginx_files_proxy

INITIAL_INFLIGHT=$(inflight_count)

# PID — до любого шлагбаума: без живого file-agent рестарт невозможен, и
# закрывать admission незачем.
PID=$(pm2 pid file-agent)
if [[ ! "$PID" =~ ^[1-9][0-9]*$ ]]; then
  echo "PM2 file-agent не запущен (pid=$PID) — рестарт невозможен" >&2
  exit 1
fi

DRAIN_STARTED=$SECONDS
NEXT_PROGRESS=$(( DRAIN_STARTED + 60 ))
drain_deadline() {
  (( SECONDS - DRAIN_STARTED >= DRAIN_WAIT_SECONDS ))
}

# Строка оператору примерно раз в минуту ожидания — в stdout, это не ошибка.
drain_progress() {
  if (( SECONDS >= NEXT_PROGRESS )); then
    echo "Ждём тишины: прошло $(( SECONDS - DRAIN_STARTED )) с из $DRAIN_WAIT_SECONDS; принятых /chat: $RELAY_INFLIGHT, процессов CLI: $RELAY_CHILDREN"
    NEXT_PROGRESS=$(( SECONDS + 60 ))
  fi
}

quiet_gave_up() {
  echo "Тишины на релее не дождались за $DRAIN_WAIT_SECONDS с — ничего не заменено, шлагбаум не стоит" >&2
  echo "релей не затихает — аварийный порядок: RELAY_DRAIN_MODE=gate (закроет /chat до конца текущих ходов)" >&2
  exit 1
}

if [[ "$INITIAL_INFLIGHT" == legacy ]]; then
  # Релей без inflight в health — прежний способ: шлагбаум в nginx, ждать детей
  # CLI и старых Nginx workers. Marker — первым: legacy-процесс его не читает,
  # зато с GATE_CREATED=1 любой сбой nginx_drain_on проходит через
  # health_and_release → nginx_drain_off, а чужой marker останавливает выкат
  # ещё до правки nginx.
  gate_on
  nginx_drain_on
  until ! relay_has_children && legacy_workers_drained; do
    if drain_deadline; then
      echo "Ходы, принятые запросы или старые Nginx workers не завершились за $DRAIN_WAIT_SECONDS с — замена отменена" >&2
      exit 1
    fi
    sleep 5
  done
elif [[ "$RELAY_DRAIN_MODE" == gate ]]; then
  # Аварийный порядок: marker сразу, ждать тишины под ним.
  gate_on
  until relay_quiet; do
    if drain_deadline; then
      echo "Ходы или принятые запросы не завершились за $DRAIN_WAIT_SECONDS с — замена отменена" >&2
      exit 1
    fi
    drain_progress
    sleep 5
  done
else
  # quiet: сначала тишина без шлагбаума — долгий ход (10 минут агентной
  # работы) не держит /chat закрытым. Шлагбаум — только на перепроверку,
  # замену и рестарт; бэк эти секунды переждёт повтором.
  echo "Ждём тишины на релее без шлагбаума (до $DRAIN_WAIT_SECONDS с): /chat открыт"
  while true; do
    until relay_quiet; do
      if drain_deadline; then
        quiet_gave_up
      fi
      drain_progress
      sleep 5
    done
    echo "На релее тихо — ставим шлагбаум и перепроверяем тишину до $DRAIN_GATE_WINDOW_SECONDS с"
    gate_on
    GATE_STARTED=$SECONDS
    until relay_quiet; do
      if (( SECONDS - GATE_STARTED >= DRAIN_GATE_WINDOW_SECONDS )); then
        gate_off
        echo "Ход проскочил под шлагбаум и не закончился за $DRAIN_GATE_WINDOW_SECONDS с — шлагбаум снят, снова ждём тишины" >&2
        if drain_deadline; then
          quiet_gave_up
        fi
        continue 2
      fi
      sleep 1
    done
    break
  done
fi

REPLACED=1
IFS=',' read -ra PUT <<< "$PUT_CSV"
for file in "${PUT[@]+"${PUT[@]}"}"; do
  [[ -n "$file" ]] || continue
  cp ~/"$STAGE"/"$file" ".$file.tmp"
  mv ".$file.tmp" "$file"
done
if [[ -n "$DEL_CSV" ]]; then
  IFS=',' read -ra DEL <<< "$DEL_CSV"
  for file in "${DEL[@]+"${DEL[@]}"}"; do
    rm -f -- "$file"
  done
fi

while read -r module; do
  [[ -f "$module" ]] || { echo "После замены нет локального импорта $module" >&2; exit 1; }
done < <(grep -ohE 'from "\./[^"]+"' *.mjs | cut -d'"' -f2 | sort -u)

git add -A -- "${FILES[@]+"${FILES[@]}"}"
git commit -q -m "relay-agent из spirits_back $TARGET_SHORT"
git log --oneline -1
pm2 restart file-agent >/dev/null
REMOTE

tar -cf - -C "$LOCAL_BUNDLE" . | ssh -o BatchMode=yes "$RELAY_HOST" "set -euo pipefail; exec 9>\"$LOCK_FILE\"; if ! flock -n 9; then echo 'Другой rollout держит $LOCK_FILE — staging, marker и файлы не изменены' >&2; exit 1; fi; rm -rf ~/$STAGE ~/$BASE_DIR; mkdir ~/$STAGE ~/$BASE_DIR; tar -xf - -C ~; STAGE=$STAGE BASE_DIR=$BASE_DIR TARGET_SHORT=$TARGET_SHORT FILES_CSV=$FILES_CSV PUT_CSV=$PUT_CSV DEL_CSV=$DEL_CSV ADD_CSV=$ADD_CSV DRAIN_FILE=$DRAIN_FILE LOCK_FILE=$LOCK_FILE NGINX_CONF=$NGINX_CONF DRAIN_WAIT_SECONDS=$DRAIN_WAIT_SECONDS RELAY_DRAIN_MODE=$RELAY_DRAIN_MODE DRAIN_GATE_WINDOW_SECONDS=$DRAIN_GATE_WINDOW_SECONDS bash ~/$STAGE/deploy-relay-remote.sh"
