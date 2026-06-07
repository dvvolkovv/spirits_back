#!/usr/bin/env bash
# Синхронизирует API-ключи с прод-сервера на test.linkeon.io.
# Копирует только внешние сервисные ключи (AI, видео, платежи).
# НЕ трогает: DB credentials, JWT secrets, MinIO keys, PUBLIC_BASE_URL.
#
# Запускать локально: bash scripts/sync-api-keys-to-test.sh
# После sync — перезапускает PM2 на тест-сервере.
#
# Флаги:
#   DRY_RUN=1   — показать что будет скопировано, не менять .env на тесте
#   NO_RESTART=1 — не перезапускать pm2 после обновления .env

set -euo pipefail

PROD_HOST="${PROD_HOST:-dvolkov@212.113.106.202}"
TEST_HOST="${TEST_HOST:-dv@85.192.61.231}"

LOCAL_ENV_FILE="$(dirname "${BASH_SOURCE[0]}")/test-server.env.local"
if [[ ! -f "$LOCAL_ENV_FILE" ]]; then
  echo "ERROR: $LOCAL_ENV_FILE не найден. Запусти provision-test.sh сначала." >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$LOCAL_ENV_FILE"

bold()  { printf "\033[1m%s\033[0m\n" "$1"; }
green() { printf "\033[32m%s\033[0m\n" "$1"; }
red()   { printf "\033[31m%s\033[0m\n" "$1" >&2; }

ssh_prod() { ssh -o StrictHostKeyChecking=accept-new "$PROD_HOST" "$@"; }
ssh_test() { ssh -o StrictHostKeyChecking=accept-new "$TEST_HOST" "$@"; }

# Список ключей для синхронизации из прода (main .env)
BACK_KEYS=(
  GOOGLE_AI_API_KEY
  OPENROUTER_API_KEY
  ANTHROPIC_API_KEY
  PERPLEXITY_API_KEY
  DEEPSEEK_API_KEY
  KLING_ACCESS_KEY
  KLING_SECRET_KEY
  YOOKASSA_SHOP_ID
  YOOKASSA_SECRET_KEY
  MCP_SECRET
  TELEGRAM_BOT_TOKEN
  TELEGRAM_WEBHOOK_SECRET
  META_APP_ID
  META_APP_SECRET
  LIVEKIT_API_KEY
  LIVEKIT_API_SECRET
  LIVEKIT_URL
  DOZVON_INTERNAL_SECRET
  OUTBOUND_CALLBACK_SECRET
  NOVOFON_SIP_TRUNK_ID
  TIKTOK_OAUTH_CLIENT_KEY
  TIKTOK_OAUTH_CLIENT_SECRET
  VK_OAUTH_CLIENT_ID
  VK_OAUTH_CLIENT_SECRET
  YOUTUBE_OAUTH_CLIENT_ID
  YOUTUBE_OAUTH_CLIENT_SECRET
)

# Список ключей для синхронизации в worker/.env
WORKER_KEYS=(
  GOOGLE_AI_API_KEY
  KLING_ACCESS_KEY
  KLING_SECRET_KEY
  PEXELS_API_KEY
  YANDEX_SPEECHKIT_API_KEY
  YANDEX_TTS_FOLDER_ID
  ELEVENLABS_API_KEY
  ELEVENLABS_VOICE_HERO_M
  ELEVENLABS_VOICE_HERO_F
  ELEVENLABS_VOICE_PSY
  ELEVENLABS_VOICE_LAWYER
  ELEVENLABS_VOICE_COACH
)

bold "[1/4] Читаем ключи с прода ($PROD_HOST)..."

# Извлекаем нужные переменные из прод .env одним ssh-вызовом
PROD_ENV=$(ssh_prod "cat ~/spirits_back/.env 2>/dev/null || true")
PROD_WORKER_ENV=$(ssh_prod "cat ~/spirits_back/worker/.env 2>/dev/null || true")

extract_var() {
  local key="$1" env_content="$2"
  echo "$env_content" | grep -E "^${key}=" | head -1 | cut -d= -f2- || true
}

# Собираем строки для back .env
BACK_PATCHES=()
for key in "${BACK_KEYS[@]}"; do
  val=$(extract_var "$key" "$PROD_ENV")
  BACK_PATCHES+=("${key}=${val}")
done

# Собираем строки для worker .env
WORKER_PATCHES=()
for key in "${WORKER_KEYS[@]}"; do
  # Ищем в worker .env сначала, потом в main .env (GOOGLE_AI_API_KEY есть в main)
  val=$(extract_var "$key" "$PROD_WORKER_ENV")
  if [[ -z "$val" ]]; then
    val=$(extract_var "$key" "$PROD_ENV")
  fi
  WORKER_PATCHES+=("${key}=${val}")
done

bold "[2/4] Ключи для синхронизации в back .env:"
for p in "${BACK_PATCHES[@]}"; do
  key="${p%%=*}"
  val="${p#*=}"
  if [[ -n "$val" ]]; then
    echo "  ✓ $key = ${val:0:6}…"
  else
    echo "  - $key = (пусто на проде)"
  fi
done

echo
bold "      Ключи для синхронизации в worker .env:"
for p in "${WORKER_PATCHES[@]}"; do
  key="${p%%=*}"
  val="${p#*=}"
  if [[ -n "$val" ]]; then
    echo "  ✓ $key = ${val:0:6}…"
  else
    echo "  - $key = (пусто на проде)"
  fi
done

if [[ "${DRY_RUN:-}" == "1" ]]; then
  echo
  bold "DRY_RUN=1 — изменений не вносим"
  exit 0
fi

bold "[3/4] Обновляем .env на тест-сервере ($TEST_HOST)..."

# Функция: обновить или добавить KEY=VALUE в файл на тест-сервере
# Передаём через stdin список "KEY=VALUE" строк
update_env_on_test() {
  local env_file="$1"
  shift
  local patches=("$@")

  # Формируем python-скрипт который патчит файл атомарно
  local patch_lines=""
  for p in "${patches[@]}"; do
    key="${p%%=*}"
    val="${p#*=}"
    # Экранируем val для передачи через heredoc: заменяем ' на '"'"'
    safe_val="${val//"'"/"'\"'\"'"}"
    patch_lines+="  ('${key}', '${safe_val}'),\n"
  done

  ssh_test "python3 -s" <<PYEOF
import re, os, sys

env_file = os.path.expanduser('${env_file}')
patches = dict([
$(printf "%b" "${patch_lines}")
])

if not os.path.exists(env_file):
    print(f'  WARN: {env_file} не найден, пропускаем')
    sys.exit(0)

with open(env_file, 'r') as f:
    lines = f.readlines()

result = []
seen = set()
for line in lines:
    m = re.match(r'^([A-Z_][A-Z0-9_]*)=(.*)', line.rstrip())
    if m and m.group(1) in patches:
        key = m.group(1)
        result.append(f'{key}={patches[key]}\n')
        seen.add(key)
    else:
        result.append(line)

# Добавляем ключи которых не было в файле
missing = [k for k in patches if k not in seen]
if missing:
    result.append('\n# Synced from prod by sync-api-keys-to-test.sh\n')
    for k in missing:
        result.append(f'{k}={patches[k]}\n')

with open(env_file + '.tmp', 'w') as f:
    f.writelines(result)
os.replace(env_file + '.tmp', env_file)
os.chmod(env_file, 0o600)

n_updated = len(seen)
n_added = len(missing)
print(f'  updated={n_updated} added={n_added}')
PYEOF
}

update_env_on_test "~/spirits_back/.env" "${BACK_PATCHES[@]}"
update_env_on_test "~/spirits_back/worker/.env" "${WORKER_PATCHES[@]}"

if [[ "${NO_RESTART:-}" != "1" ]]; then
  bold "[4/4] Перезапускаем PM2 на тесте..."
  ssh_test 'bash -lc "
    export NVM_DIR=\"\$HOME/.nvm\"
    [ -s \"\$NVM_DIR/nvm.sh\" ] && . \"\$NVM_DIR/nvm.sh\"
    pm2 restart linkeon-api 2>/dev/null || true
    pm2 restart linkeon-smm-worker 2>/dev/null || true
    pm2 list
  "'
fi

echo
green "═══════════════════════════════════════════════════════════════"
green "  ✓ API-ключи синхронизированы: prod → test.linkeon.io"
green "═══════════════════════════════════════════════════════════════"
echo "  Следующий шаг: запусти smoke против теста"
echo "    bash scripts/deploy.sh SMOKE_ONLY=1 TEST_ONLY=1"
