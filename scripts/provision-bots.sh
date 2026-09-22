#!/usr/bin/env bash
# Идемпотентная настройка хоста под ботов встреч (meeting-bot).
#
# Запускается с твоей машины:  bash scripts/provision-bots.sh user@1.2.3.4
#
# ЗАЧЕМ ОТДЕЛЬНЫЙ ХОСТ. Каждая встреча — это полный Chrome со страницей
# площадки: примерно 570 МБ и до ядра под разговор, причём и в тишине, потому
# что страница продолжает рисоваться. Рядом с LiveKit такому соседу не место:
# конкуренция за процессор бьёт по SFU, то есть по звуку всех остальных.
#
# ЧТО СТАВИТ: Node 22 (nvm), pm2, Xvfb, Google Chrome, Chromium из Playwright,
# репозиторий, зависимости сервиса и сам сервис под pm2 с автозапуском.
#
# ЧЕГО НЕ ДЕЛАЕТ: не создаёт машину (нет доступа к провайдеру), не открывает
# порт наружу и не заполняет секреты — см. «Что потом» в конце вывода.
#
# Требования к машине: Ubuntu 22.04+, 2 vCPU, 8 ГБ памяти, 20 ГБ диска,
# пользователь с sudo и твоим ssh-ключом.

set -euo pipefail

HOST="${1:-${BOTS_HOST:-}}"
BRANCH="${BRANCH:-main}"
REPO="${REPO:-https://github.com/dvvolkovv/spirits_back.git}"
APP_DIR="${APP_DIR:-spirits_back}"

bold()  { printf "\033[1m%s\033[0m\n" "$1"; }
green() { printf "\033[32m%s\033[0m\n" "$1"; }
red()   { printf "\033[31m%s\033[0m\n" "$1" >&2; }

if [[ -z "$HOST" ]]; then
  red "нужен адрес: bash scripts/provision-bots.sh user@1.2.3.4"
  exit 1
fi

ssh_bots() { ssh -o StrictHostKeyChecking=accept-new "$HOST" "$@"; }

bold "[1/6] Системные пакеты: Xvfb, Chrome и то, что ему нужно"
ssh_bots 'sudo bash -s' <<'REMOTE'
set -eo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# xvfb — экран для браузера; xdotool и xclip тут НЕ нужны (ими мы не пользуемся),
# fonts-liberation и шрифты — иначе страницы площадок рисуются квадратами, и
# зацепки по тексту перестают совпадать.
apt-get install -y -qq \
  xvfb fonts-liberation fonts-noto-color-emoji fonts-dejavu-core \
  ca-certificates curl gnupg git rsync
REMOTE

bold "[2/6] Google Chrome"
ssh_bots 'sudo bash -s' <<'REMOTE'
set -eo pipefail
export DEBIAN_FRONTEND=noninteractive
if ! command -v google-chrome >/dev/null 2>&1; then
  # Ставим ИМЕННО Chrome, а не Chromium: Google Meet различает браузеры и
  # Chromium из Playwright дальше экрана входа не пускает (проверено
  # 16.09.2026 — стук до хозяина встречи не доходил вовсе).
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
    | gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg
  echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
    > /etc/apt/sources.list.d/google-chrome.list
  apt-get update -qq
  apt-get install -y -qq google-chrome-stable
fi
google-chrome --version
REMOTE

bold "[3/6] Node 22 и pm2"
ssh_bots 'bash -s' <<'REMOTE'
set -eo pipefail
export NVM_DIR="$HOME/.nvm"
if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
fi
. "$NVM_DIR/nvm.sh"
nvm install 22 >/dev/null
nvm alias default 22 >/dev/null
command -v pm2 >/dev/null 2>&1 || npm i -g pm2 >/dev/null
node --version && pm2 --version
REMOTE

bold "[4/6] Репозиторий и зависимости сервиса"
ssh_bots "bash -s" <<REMOTE
set -eo pipefail
export NVM_DIR="\$HOME/.nvm"; . "\$NVM_DIR/nvm.sh"
if [[ ! -d "\$HOME/$APP_DIR/.git" ]]; then
  git clone -q "$REPO" "\$HOME/$APP_DIR"
fi
cd "\$HOME/$APP_DIR"
git fetch -q origin
git checkout -q "$BRANCH" 2>/dev/null || git checkout -q -b "$BRANCH" "origin/$BRANCH"
git reset -q --hard "origin/$BRANCH"
cd infra/meeting-bot
npm install --omit=dev --no-audit --no-fund >/dev/null
# Chromium Playwright — для Zoom и Телемоста; Chrome — для Meet.
npx playwright install chromium >/dev/null
git log --oneline -1
REMOTE

bold "[5/6] Настройки сервиса (.env)"
ssh_bots "bash -s" <<'REMOTE'
set -eo pipefail
ENV_FILE="$HOME/spirits_back/infra/meeting-bot/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  # Ключ доступа генерируем здесь: он не должен проходить ни через чужие руки,
  # ни через историю команд. Его значение владелец скопирует в бэкенд сам.
  KEY="$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | cut -c1-32)"
  cat > "$ENV_FILE" <<EOF
MEETING_BOT_PORT=8180
MEETING_BOT_API_KEY=$KEY
# Тот же секрет, что проверяет бэкенд (ATTENDEE_WEBHOOK_SECRET на проде).
MEETING_BOT_WEBHOOK_SECRET=
# Ключи приложения Zoom Marketplace — нужны только для Zoom.
ZOOM_SDK_CLIENT_ID=
ZOOM_SDK_CLIENT_SECRET=
EOF
  chmod 600 "$ENV_FILE"
  echo "создан $ENV_FILE"
else
  echo "$ENV_FILE уже есть — не трогаем"
fi
REMOTE

bold "[6/6] Запуск под pm2 и автозапуск"
ssh_bots "bash -s" <<'REMOTE'
set -eo pipefail
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"
cd "$HOME/spirits_back/infra/meeting-bot"
pm2 delete linkeon-meeting-bot >/dev/null 2>&1 || true
# Xvfb на каждый запуск свой: -a сам выбирает свободный экран, поэтому чужой
# процесс на :99 нам больше не помеха.
pm2 start bash --name linkeon-meeting-bot -- -c \
  'xvfb-run -a --server-args="-screen 0 1280x800x24" node src/server.mjs'
pm2 save >/dev/null
pm2 startup systemd -u "$USER" --hp "$HOME" 2>/dev/null | tail -1
sleep 3
pm2 list | grep linkeon-meeting-bot || true
REMOTE

green "Хост готов."
echo
bold "Что потом — руками, и только владельцем:"
cat <<'NEXT'
  1. Дописать в infra/meeting-bot/.env на этом хосте:
       MEETING_BOT_WEBHOOK_SECRET — равен ATTENDEE_WEBHOOK_SECRET прода
       ZOOM_SDK_CLIENT_ID / ZOOM_SDK_CLIENT_SECRET — если включаем Zoom
     и перезапустить:  pm2 restart linkeon-meeting-bot

  2. Открыть порт 8180 ТОЛЬКО для прода, а не наружу:
       sudo ufw allow from <IP прода> to any port 8180 proto tcp
       sudo ufw enable
     Сервис умеет заводить браузеры в чужих встречах — публичным ему быть нельзя.

  3. В .env прода добавить:
       MEETING_BOT_URL=http://<IP этого хоста>:8180
       MEETING_BOT_API_KEY=<ключ из .env этого хоста>
     и перезапустить linkeon-api.

  4. Для Meet — один раз войти в аккаунт Google руками:
       sh ~/spirits_back/infra/meeting-bot/google-login.sh
     (поднимет VNC на 127.0.0.1:5900, подключаться через ssh-туннель).
NEXT
