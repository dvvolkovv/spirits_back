#!/bin/sh
#
# Вход в аккаунт Google для ассистента — руками, один раз.
#
# Meet пускает анонимного бота только через проверку на человека, которую мы
# обходить не стали (решение владельца 16.09.2026). Вошедшему под учётной
# записью она не нужна вовсе — так устроено и у Attendee: при входе с аккаунтом
# он сам переключается в «робототехнический» режим ввода.
#
# Пароль при этом не попадает никуда: ни в .env, ни в код, ни в чужие руки.
# Владелец входит сам, в настоящем окне браузера, а бот потом пользуется
# профилем с куками.
#
# Как это работает: на стенде поднимается невидимый экран (Xvfb), на нём —
# Chrome с нашим профилем, а к экрану приставляется VNC, открытый ТОЛЬКО на
# 127.0.0.1. Снаружи к нему не подключиться — доступ идёт через ssh-туннель.
#
# На стенде:
#     sh ~/spirits_back/infra/meeting-bot/google-login.sh
#
# На своей машине, в другом окне:
#     ssh -L 5900:127.0.0.1:5900 dv@85.192.61.231
# и любым VNC-клиентом открыть localhost:5900
# (в macOS: Finder → Переход → Подключение к серверу → vnc://localhost:5900)
#
# Дальше: войти в аккаунт, дождаться почтового ящика, закрыть окно браузера.
# Скрипт сам всё погасит.

PROFILE="$HOME/.linkeon-meet-profile"
LOG_X=/tmp/meet-login-xvfb.log
LOG_V=/tmp/meet-login-vnc.log

mkdir -p "$PROFILE"

# Свободный номер экрана ищем, а не берём наугад.
#
# Первая редакция брала :99 жёстко — а он на стенде был занят чужим Xvfb, и
# дальше всё валилось молча: экран не поднялся, VNC не к чему было приставить,
# а вывод скрипт прятал. Теперь занятые пропускаем, а ошибки видно.
DISPLAY_NUM=""
for n in 77 78 79 80 81 82 83; do
  if [ ! -e "/tmp/.X${n}-lock" ]; then DISPLAY_NUM="$n"; break; fi
done
if [ -z "$DISPLAY_NUM" ]; then
  echo "не нашёл свободного экрана — посмотрите /tmp/.X*-lock"
  exit 1
fi

echo "экран :$DISPLAY_NUM"
Xvfb ":$DISPLAY_NUM" -screen 0 1280x900x24 >"$LOG_X" 2>&1 &
XVFB=$!
sleep 2
if ! kill -0 "$XVFB" 2>/dev/null; then
  echo "экран не поднялся, вот что он сказал:"
  tail -5 "$LOG_X"
  exit 1
fi

x11vnc -display ":$DISPLAY_NUM" -localhost -nopw -forever -shared >"$LOG_V" 2>&1 &
VNC=$!
sleep 2

# Проверяем, что VNC действительно слушает: молчаливый отказ здесь дороже всего.
if ! ss -ltn 2>/dev/null | grep -q ':5900'; then
  echo "VNC не поднялся, вот что он сказал:"
  tail -10 "$LOG_V"
  kill "$VNC" "$XVFB" 2>/dev/null
  exit 1
fi

echo "VNC слушает 127.0.0.1:5900 — только локально, снаружи не видно"
echo
echo "Теперь на своей машине, в другом окне:"
echo "    ssh -L 5900:127.0.0.1:5900 dv@85.192.61.231"
echo "и VNC-клиентом открыть localhost:5900"
echo "(macOS: Finder → Переход → Подключение к серверу → vnc://localhost:5900)"
echo
echo "Войдите в аккаунт и закройте окно браузера — на этом всё."
echo

DISPLAY=":$DISPLAY_NUM" google-chrome \
  --user-data-dir="$PROFILE" \
  --no-first-run \
  --no-default-browser-check \
  --window-position=0,0 \
  --window-size=1280,900 \
  --lang=en-US \
  https://accounts.google.com/ >/tmp/meet-login-chrome.log 2>&1

kill "$VNC" "$XVFB" 2>/dev/null
echo "профиль сохранён: $PROFILE"
