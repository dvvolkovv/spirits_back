#!/bin/sh
#
# Вход в аккаунт Google для ассистента — руками, один раз.
#
# Meet пускает анонимного бота только через проверку на человека, которую мы
# обходить не стали (решение 16.09.2026). Вошедшему под учётной записью она не
# нужна вовсе — так устроено и у Attendee: при входе с аккаунтом он сам
# переключается в «робототехнический» режим ввода.
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
set -e

PROFILE="$HOME/.linkeon-meet-profile"
DISPLAY_NUM=99

mkdir -p "$PROFILE"

echo "экран :$DISPLAY_NUM"
Xvfb ":$DISPLAY_NUM" -screen 0 1280x900x24 >/dev/null 2>&1 &
XVFB=$!
sleep 2

echo "VNC на 127.0.0.1:5900 (только локально, снаружи не видно)"
x11vnc -display ":$DISPLAY_NUM" -localhost -nopw -forever -quiet >/dev/null 2>&1 &
VNC=$!

echo
echo "Теперь на своей машине:"
echo "    ssh -L 5900:127.0.0.1:5900 dv@85.192.61.231"
echo "и VNC-клиентом открыть localhost:5900"
echo
echo "Войдите в аккаунт и закройте окно браузера — на этом всё."
echo

DISPLAY=":$DISPLAY_NUM" google-chrome \
  --user-data-dir="$PROFILE" \
  --no-first-run \
  --no-default-browser-check \
  --window-size=1280,900 \
  --lang=en-US \
  https://accounts.google.com/ >/dev/null 2>&1 || true

kill "$VNC" "$XVFB" 2>/dev/null || true
echo "профиль сохранён: $PROFILE"
