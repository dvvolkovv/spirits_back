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
ssh -o BatchMode=yes "$RELAY_HOST" "rm -rf ~/$STAGE ~/$BASE_DIR && mkdir ~/$STAGE ~/$BASE_DIR"
git archive "$TARGET_SHA" relay-agent | ssh -o BatchMode=yes "$RELAY_HOST" "tar -x -C ~/$STAGE --strip-components=1"
git archive "$BASE_SHA" relay-agent | ssh -o BatchMode=yes "$RELAY_HOST" "tar -x -C ~/$BASE_DIR --strip-components=1"

ssh -o BatchMode=yes "$RELAY_HOST" "STAGE=$STAGE BASE_DIR=$BASE_DIR TARGET_SHORT=$TARGET_SHORT FILES_CSV=$FILES_CSV PUT_CSV=$PUT_CSV DEL_CSV=$DEL_CSV ADD_CSV=$ADD_CSV bash -s" <<'REMOTE'
set -euo pipefail
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

PID=$(pm2 pid file-agent)
if [[ ! "$PID" =~ ^[1-9][0-9]*$ ]]; then
  echo "PM2 file-agent не запущен (pid=$PID) — рестарт невозможен" >&2
  exit 1
fi
if ps --ppid "$PID" -o pid= | grep -q .; then
  echo "У file-agent есть живые ходы — ничего не заменено, повторить после их завершения" >&2
  exit 1
fi

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

grep -ohE 'from "\./[^"]+"' *.mjs | cut -d'"' -f2 | sort -u | while read -r module; do
  [[ -f "$module" ]] || { echo "После замены нет локального импорта $module" >&2; exit 1; }
done

git add -A -- "${FILES[@]}"
git commit -q -m "relay-agent из spirits_back $TARGET_SHORT"
git log --oneline -1
pm2 restart file-agent >/dev/null

for attempt in $(seq 1 20); do
  if curl -fsS --max-time 5 http://127.0.0.1:3033/health; then
    printf '\nrelay-agent %s: health OK\n' "$TARGET_SHORT"
    exit 0
  fi
  sleep 1
done

echo "relay-agent не прошёл /health после рестарта" >&2
exit 1
REMOTE
