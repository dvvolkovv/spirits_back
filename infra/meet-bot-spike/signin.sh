#!/usr/bin/env bash
#
# Однократный вход в аккаунт Google для бота — руками, через настоящий
# графический сеанс на сервере.
#
# Почему руками: автоматизировать вход в Google бессмысленно, он его активно
# блокирует («этот браузер небезопасен»). Рабочий путь — войти один раз в
# постоянный профиль браузера и потом переиспользовать этот профиль.
#
# Как это устроено: Xvfb даёт виртуальный экран, x11vnc отдаёт его по VNC, но
# ТОЛЬКО на localhost. Снаружи он недоступен — подключаться нужно через
# SSH-туннель, то есть по уже аутентифицированному каналу. Выставлять VNC в
# сеть нельзя ни на минуту: это доступ к экрану с открытой почтой.
#
# Использование:
#   на сервере:  ./signin.sh
#   на своей машине: ssh -N -L 5900:127.0.0.1:5900 dv@85.192.61.231
#   затем VNC-клиентом на localhost:5900, пароль скрипт напечатает
#
# После входа закрыть Chrome в VNC и нажать Ctrl+C здесь. Профиль останется в
# ./profile и будет подхвачен join-meet.mjs через SPIKE_USER_DATA_DIR.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PROFILE="${SPIKE_USER_DATA_DIR:-$HERE/profile}"
DISPLAY_NUM="${SPIKE_DISPLAY:-99}"
VNC_PORT=5900
CHROME="${SPIKE_CHROME:-/usr/bin/google-chrome}"

command -v x11vnc >/dev/null || { echo "нет x11vnc: sudo apt-get install -y x11vnc"; exit 1; }
[ -x "$CHROME" ] || { echo "нет Chrome: $CHROME"; exit 1; }

# Профиль занят живым Chrome — второй экземпляр на тот же профиль не встанет.
if pgrep -f "user-data-dir=$PROFILE" >/dev/null; then
  echo "Chrome уже держит этот профиль. Закройте его и повторите."
  exit 1
fi

PASS="$(head -c 6 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 8)"
mkdir -p "$PROFILE"
PASSFILE="$(mktemp)"
chmod 600 "$PASSFILE"
x11vnc -storepasswd "$PASS" "$PASSFILE" >/dev/null 2>&1

cleanup() {
  echo ""
  echo "останавливаю сеанс…"
  pkill -f "user-data-dir=$PROFILE" 2>/dev/null || true
  kill "${VNC_PID:-}" "${XVFB_PID:-}" 2>/dev/null || true
  rm -f "$PASSFILE"
  echo "профиль сохранён: $PROFILE"
}
trap cleanup EXIT INT TERM

Xvfb ":$DISPLAY_NUM" -screen 0 1280x800x24 >/tmp/signin-xvfb.log 2>&1 &
XVFB_PID=$!
sleep 1.5

# -localhost принципиален: без него экран с открытой почтой торчал бы в сеть.
x11vnc -display ":$DISPLAY_NUM" -rfbport "$VNC_PORT" -rfbauth "$PASSFILE" \
  -localhost -forever -shared -nolookup >/tmp/signin-x11vnc.log 2>&1 &
VNC_PID=$!
sleep 1

DISPLAY=":$DISPLAY_NUM" "$CHROME" \
  --user-data-dir="$PROFILE" \
  --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --disable-blink-features=AutomationControlled \
  --window-size=1280,800 \
  'https://accounts.google.com/' >/tmp/signin-chrome.log 2>&1 &

cat <<TXT

======================================================================
Графический сеанс поднят. Дальше на ВАШЕЙ машине:

  ssh -N -L $VNC_PORT:127.0.0.1:$VNC_PORT dv@85.192.61.231

и VNC-клиентом на  localhost:$VNC_PORT
пароль: $PASS

Внутри: войдите в аккаунт Google, который будет аккаунтом бота.
Затем откройте https://meet.google.com и убедитесь, что вы вошли.

Когда закончите — закройте Chrome в VNC и нажмите здесь Ctrl+C.
Профиль сохранится в: $PROFILE
======================================================================

TXT

wait "$VNC_PID"
