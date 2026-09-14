#!/usr/bin/env bash
# Виртуальная камера для бота.
#
# Нужна не для картинки, а для проверки «не бот ли ты»: на предвстрече Meet
# писал «Camera not found», и это лишний сигнал против нас. Устройство создаёт
# модуль v4l2loopback, а картинку в него льёт ffmpeg — без потока устройство
# существует, но отдаёт пустоту.
#
# Кадр статический: боту нечего показывать, а движение только тратит CPU.
set -euo pipefail
DEV="${1:-/dev/video0}"
pkill -f "v4l2.*$DEV" 2>/dev/null || true
sleep 0.3
nohup ffmpeg -loglevel error -re \
  -f lavfi -i "color=c=0x202124:s=640x480:r=10" \
  -f v4l2 -pix_fmt yuv420p "$DEV" >/tmp/camera.log 2>&1 &
sleep 1.5
if pgrep -f "v4l2.*$DEV" >/dev/null; then
  echo "камера пишет в $DEV"
else
  echo "камера НЕ запустилась:"; cat /tmp/camera.log
  exit 1
fi
