#!/usr/bin/env bash
# Виртуальные аудиоустройства для бота во встрече.
#
# Два независимых устройства, а не одно с закольцовкой:
#   meet_out      — куда Chromium играет звук встречи; мы читаем meet_out.monitor
#   bot_mic_sink  — куда МЫ пишем голос ассистента
#   bot_mic       — remap-source поверх bot_mic_sink.monitor: этим Chromium
#                   видит наш голос как микрофон
#
# Разделение принципиально: при одном устройстве звук встречи попадал бы в
# микрофон бота, и он слышал бы сам себя.
set -euo pipefail

pulseaudio --check 2>/dev/null || pulseaudio --start --exit-idle-time=-1 --daemonize=yes
for i in $(seq 1 20); do pulseaudio --check 2>/dev/null && break; sleep 0.3; done

has_sink()   { pactl list short sinks   | awk '{print $2}' | grep -Fxq "$1"; }
has_source() { pactl list short sources | awk '{print $2}' | grep -Fxq "$1"; }

has_sink meet_out || pactl load-module module-null-sink \
  sink_name=meet_out sink_properties=device.description=meet_out >/dev/null
has_sink bot_mic_sink || pactl load-module module-null-sink \
  sink_name=bot_mic_sink sink_properties=device.description=bot_mic_sink >/dev/null
has_source bot_mic || pactl load-module module-remap-source \
  master=bot_mic_sink.monitor source_name=bot_mic \
  source_properties=device.description=bot_mic >/dev/null

pactl set-default-sink meet_out
pactl set-default-source bot_mic

echo "--- sinks ---";   pactl list short sinks   | awk '{print "  " $2}'
echo "--- sources ---"; pactl list short sources | awk '{print "  " $2}'
echo "default sink:   $(pactl get-default-sink)"
echo "default source: $(pactl get-default-source)"
