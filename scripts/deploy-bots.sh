#!/usr/bin/env bash
# Обновление машины ботов встреч (infra/meeting-bot).
#
# Запускается сам по себе:  bash scripts/deploy-bots.sh [user@host]
# и фазой из deploy.sh — по умолчанию, отключается SKIP_BOTS=1.
#
# ЗАЧЕМ ОТДЕЛЬНЫЙ СКРИПТ, А НЕ provision-bots.sh. Тот — установщик: тянет apt,
# ставит Chrome, nvm, Node, заводит .env и автозапуск. На каждую выкатку это
# минуты и трогание системных пакетов. Здесь только то, что меняется с кодом:
# репозиторий, зависимости сервиса и перезапуск.
#
# ПОЧЕМУ ОН ВООБЩЕ ПОНАДОБИЛСЯ. deploy.sh не знал о машине ботов ни одной
# строкой, в README сервиса раздела про обновление не было, и обновляли её
# только когда вспоминали руками. К 19.10.2026 она отстала на три недели:
# работала на коде от 28 сентября, без правок, уехавших на прод 13 октября.
# Ровно та же болезнь, из-за которой 07.09.2026 машины продуктов сделали
# обязательной фазой выкатки.
#
# ЧЕГО НЕ ДЕЛАЕТ: не ставит систему (это provision-bots.sh), не трогает .env
# с секретами и не создаёт машину.

set -uo pipefail

BOTS_HOST="${1:-${BOTS_HOST:-linkeon@46.101.255.44}}"
BRANCH="${BRANCH:-main}"
APP_DIR="${APP_DIR:-spirits_back}"
SERVICE="${SERVICE:-linkeon-meeting-bot}"

bold()  { printf "\033[1m%s\033[0m\n" "$1"; }
green() { printf "\033[32m  ✓ %s\033[0m\n" "$1"; }
red()   { printf "\033[31m  ✗ %s\033[0m\n" "$1" >&2; }

ssh_bots() {
  ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 "$BOTS_HOST" "$@"
}

bold "════════════ БОТЫ ВСТРЕЧ: $BOTS_HOST ════════════"

# ── 1. Связь ────────────────────────────────────────────────────────────────
if ! ssh_bots true 2>/dev/null; then
  red "$BOTS_HOST не отвечает по ssh — машина ботов не обновлена"
  echo "    Проверьте учётку и ключ: ssh $BOTS_HOST" >&2
  exit 2
fi
green "связь есть"

# ── 2. Идут ли встречи ──────────────────────────────────────────────────────
#
# Перезапуск сервиса обрывает живой разговор на полуслове, и узнает об этом
# клиент, а не мы. Каждая встреча — это отдельный Chrome, поэтому занятость
# видно по процессам: ноль означает, что сервис простаивает.
#
# Проверка намеренно строгая и отказывает, а не ждёт: встреча живёт до двух
# часов, и деплой, повисший на ней, хуже отложенного. Сорвать её сознательно
# можно через FORCE_BOTS=1 — он же нужен, если в встрече застрял бот-зомби
# (19.10.2026 такой провисел три недели и держал четверть памяти машины).
# `|| true`, а не `|| echo 0`: pgrep -c при пустом ответе САМ печатает «0», но
# выходит с ненулевым кодом — и запасное echo добавляло второй ноль, превращая
# счётчик в «00». Считается это по-прежнему нулём, но в сообщении выглядело бы
# ошибкой. На всякий случай берём только первую строку.
busy="$(ssh_bots 'pgrep -c chrome 2>/dev/null || true' 2>/dev/null | head -1 | tr -cd '0-9')"
busy="${busy:-0}"
if [[ "$busy" -gt 0 && "${FORCE_BOTS:-0}" != "1" ]]; then
  red "на машине идёт встреча (процессов Chrome: $busy) — не перезапускаем"
  echo "    Это не ошибка выкатки: остальные фазы прошли, обновить ботов можно позже." >&2
  echo "    Повторить:        bash scripts/deploy-bots.sh $BOTS_HOST" >&2
  echo "    Сорвать встречу:  FORCE_BOTS=1 bash scripts/deploy-bots.sh $BOTS_HOST" >&2
  exit 3
fi
[[ "$busy" -gt 0 ]] && bold "  ⚠ FORCE_BOTS=1: обрываем идущую встречу (процессов Chrome: $busy)"
green "встреч нет — можно обновлять"

# ── 3. Код и зависимости ────────────────────────────────────────────────────
#
# reset --hard, а не pull: на машине ничего не правят руками, а расхождение
# истории остановило бы выкатку в самом неудобном месте. Так же устроен шаг 4
# provision-bots.sh.
bold "[1/3] код и зависимости"
if ! ssh_bots "bash -s" <<REMOTE
set -eo pipefail
export NVM_DIR="\$HOME/.nvm"; . "\$NVM_DIR/nvm.sh" >/dev/null 2>&1
cd "\$HOME/$APP_DIR"
git fetch -q origin
git checkout -q "$BRANCH" 2>/dev/null || git checkout -q -b "$BRANCH" "origin/$BRANCH"
git reset -q --hard "origin/$BRANCH"
cd infra/meeting-bot
npm install --omit=dev --no-audit --no-fund >/dev/null
# Chromium Playwright — для Zoom и Телемоста; Chrome ставит provision-bots.sh.
npx playwright install chromium >/dev/null
git log --oneline -1
REMOTE
then
  red "обновление кода не прошло — сервис не перезапускали, он на прежней версии"
  exit 4
fi
green "код обновлён"

# ── 4. Перезапуск ───────────────────────────────────────────────────────────
#
# restart, а не delete+start, как в provision-bots.sh: запись pm2 вместе с
# обёрткой xvfb-run заведена при установке, и пересоздавать её на каждой
# выкатке незачем — потерять её параметры проще, чем восстановить.
bold "[2/3] перезапуск сервиса"
if ! ssh_bots "export NVM_DIR=\$HOME/.nvm; . \$NVM_DIR/nvm.sh >/dev/null 2>&1; pm2 restart $SERVICE >/dev/null && pm2 save >/dev/null"; then
  red "сервис не перезапустился — на машине может не быть запущенного $SERVICE"
  echo "    Первая установка делается так: bash scripts/provision-bots.sh $BOTS_HOST" >&2
  exit 5
fi
green "сервис перезапущен"

# ── 5. Проверка, что он живой ───────────────────────────────────────────────
#
# Не «pm2 говорит online», а настоящий запрос к ручке. 401 — правильный ответ
# без ключа: он доказывает, что сервис слушает порт и проверяет доступ.
# Пустой ответ или отказ соединения означают, что процесс поднялся и умер.
bold "[3/3] проверка"
code="$(ssh_bots 'P=$(sed -n -E "s/^MEETING_BOT_PORT=//p" "$HOME/spirits_back/infra/meeting-bot/.env" | tail -1); P="${P:-8180}"; sleep 3; curl -s -o /dev/null -m 10 -w "%{http_code}" "http://127.0.0.1:$P/api/v1/bots/probe"' 2>/dev/null | tr -cd '0-9')"
if [[ "$code" != "401" ]]; then
  red "сервис не отвечает как надо: ожидали 401 без ключа, получили «${code:-ничего}»"
  echo "    Логи:  ssh $BOTS_HOST 'export NVM_DIR=\$HOME/.nvm; . \$NVM_DIR/nvm.sh; pm2 logs $SERVICE --lines 50 --nostream'" >&2
  exit 6
fi
green "сервис отвечает (401 без ключа — как и должен)"

bold "Машина ботов обновлена."
