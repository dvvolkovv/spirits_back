#!/usr/bin/env bash
# Официальный выкат relay-agent на r.linkeon.io. Не входит в deploy.sh.
# Использование: bash scripts/deploy-relay.sh <BASE_SHA> <TARGET_SHA>
# BASE_SHA — коммит, чьё содержимое relay-agent совпадает с живым релеем.
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
FILES_CSV=$(join_csv "${FILES[@]}")
PUT_CSV=$(join_csv "${PUT[@]}")
DEL_CSV=$(join_csv "${DEL[@]}")
ADD_CSV=$(join_csv "${ADD[@]}")

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
SUDO=${SUDO:-sudo}
GATE_CREATED=0
NGINX_DRAIN=0
REPLACED=0

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
  $SUDO nginx -t
  $SUDO nginx -s reload
  NGINX_DRAIN=1
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
  for attempt in $(seq 1 20); do
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
  for file in "${PUT[@]}"; do
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
    for file in "${DEL[@]}"; do
      cp ~/"$BASE_DIR"/"$file" ".$file.rollback.tmp"
      mv ".$file.rollback.tmp" "$file"
    done
  fi
  while read -r module; do
    [[ -f "$module" ]] || { echo "При откате нет локального импорта $module" >&2; exit 1; }
  done < <(grep -ohE 'from "\./[^"]+"' *.mjs | cut -d'"' -f2 | sort -u)
  git add -A -- "${FILES[@]}"
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

cd ~/file-agent
if ! git diff --cached --quiet; then
  echo "В git релея есть посторонние staged-изменения — ничего не заменено" >&2
  exit 1
fi
IFS=',' read -ra FILES <<< "$FILES_CSV"
for file in "${FILES[@]}"; do
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

INITIAL_INFLIGHT=$(inflight_count)
if [[ "$INITIAL_INFLIGHT" == legacy ]]; then
  nginx_drain_on
fi

( umask 077; printf '%s\n' "$TARGET_SHORT" > "$DRAIN_FILE.tmp.$$" && mv "$DRAIN_FILE.tmp.$$" "$DRAIN_FILE" )
GATE_CREATED=1

PID=$(pm2 pid file-agent)
if [[ ! "$PID" =~ ^[1-9][0-9]*$ ]]; then
  echo "PM2 file-agent не запущен (pid=$PID) — рестарт невозможен" >&2
  exit 1
fi
DRAIN_STARTED=$SECONDS
while true; do
  CHILDREN=$(ps --ppid "$PID" -o pid=)
  if [[ "$INITIAL_INFLIGHT" == legacy ]]; then
    if ! grep -q . <<< "$CHILDREN" && legacy_workers_drained; then
      break
    fi
  else
    INFLIGHT=$(inflight_count)
    if ! grep -q . <<< "$CHILDREN" && [[ "$INFLIGHT" -eq 0 ]]; then
      break
    fi
  fi
  if (( SECONDS - DRAIN_STARTED >= DRAIN_WAIT_SECONDS )); then
    echo "Ходы, принятые запросы или старые Nginx workers не завершились за $DRAIN_WAIT_SECONDS с — замена отменена" >&2
    exit 1
  fi
  sleep 5
done

REPLACED=1
IFS=',' read -ra PUT <<< "$PUT_CSV"
for file in "${PUT[@]}"; do
  [[ -n "$file" ]] || continue
  cp ~/"$STAGE"/"$file" ".$file.tmp"
  mv ".$file.tmp" "$file"
done
if [[ -n "$DEL_CSV" ]]; then
  IFS=',' read -ra DEL <<< "$DEL_CSV"
  for file in "${DEL[@]}"; do
    rm -f -- "$file"
  done
fi

while read -r module; do
  [[ -f "$module" ]] || { echo "После замены нет локального импорта $module" >&2; exit 1; }
done < <(grep -ohE 'from "\./[^"]+"' *.mjs | cut -d'"' -f2 | sort -u)

git add -A -- "${FILES[@]}"
git commit -q -m "relay-agent из spirits_back $TARGET_SHORT"
git log --oneline -1
pm2 restart file-agent >/dev/null
REMOTE

tar -cf - -C "$LOCAL_BUNDLE" . | ssh -o BatchMode=yes "$RELAY_HOST" "set -euo pipefail; exec 9>\"$LOCK_FILE\"; if ! flock -n 9; then echo 'Другой rollout держит $LOCK_FILE — staging, marker и файлы не изменены' >&2; exit 1; fi; rm -rf ~/$STAGE ~/$BASE_DIR; mkdir ~/$STAGE ~/$BASE_DIR; tar -xf - -C ~; STAGE=$STAGE BASE_DIR=$BASE_DIR TARGET_SHORT=$TARGET_SHORT FILES_CSV=$FILES_CSV PUT_CSV=$PUT_CSV DEL_CSV=$DEL_CSV ADD_CSV=$ADD_CSV DRAIN_FILE=$DRAIN_FILE LOCK_FILE=$LOCK_FILE NGINX_CONF=$NGINX_CONF DRAIN_WAIT_SECONDS=$DRAIN_WAIT_SECONDS bash ~/$STAGE/deploy-relay-remote.sh"
