#!/usr/bin/env python3
"""
Рваный голос ассистента в Zoom: мост кормит веб-адаптер впритык к реальному
времени.

СИМПТОМ (13.09.2026). Живая встреча Zoom: звук идёт в обе стороны, но голос
ассистента прерывается. На нашей стороне всё ровно — сегменты речи закрываются
целиком (14,3 с и 13,2 с), ни одного «прерван», перебивания нет.

ПРИЧИНА. `RealtimeAudioOutputManager` режет поток на куски по 100 мс и между
кусками спит `sleep_time_between_chunks_seconds * 0.1` секунды. Значение
выбирается по площадке (`bot_controller.py`):

    ZOOM  → 0.9   (то есть сон 90 мс на каждые 100 мс звука)
    иначе → 0.1   (сон 10 мс — кормим с запасом)

Для НАТИВНОГО адаптера Zoom это верно: у SDK свой буфер, и заливать его
быстрее реального времени незачем. Но веб-адаптер проигрывает звук ТОЙ ЖЕ
очередью в странице (`BotOutputManager` из `shared_chromedriver_payload.js`),
что и Google Meet: очередь сама планирует куски по `nextPlayTime` и рассчитана
на то, что данные лежат впереди с запасом.

При паузе 90 мс запаса нет вовсе: каждый кусок доставляется через CDP, а это
десятки миллисекунд сверху. Кусок приходит позже, чем кончился предыдущий,
`nextPlayTime` отстаёт от `currentTime`, очередь навёрстывает — и в звуке
появляется дырка. На каждые 100 мс речи. Именно так это и слышно.

ЧТО ДЕЛАЕТ ПРАВКА. Оставляет 0.9 нативному адаптеру Zoom и RTMS, а веб-
адаптеру даёт те же 0.1, что и Meet. Одна строка условия.

ИДЕМПОТЕНТНА. Оригинал сохраняется рядом с `.linkeon-orig`.

ЗАПУСК на стенде (исходники смонтированы в контейнеры как `.:/attendee`):

    python3 zoom-web-audio-pace.py ~/attendee
    sudo docker compose -f ~/attendee/dev.docker-compose.yaml restart attendee-worker-local
"""

import io
import os
import shutil
import sys

ROOT = sys.argv[1] if len(sys.argv) > 1 else '.'
PATH = os.path.join(ROOT, 'bots/bot_controller/bot_controller.py')

OLD = """    def get_sleep_time_between_audio_output_chunks_seconds(self):
        meeting_type = self.get_meeting_type()
        if meeting_type == MeetingTypes.ZOOM:
            return 0.9
        return 0.1"""

NEW = """    def get_sleep_time_between_audio_output_chunks_seconds(self):
        meeting_type = self.get_meeting_type()
        # LINKEON_ZOOM_WEB_PACE: веб-адаптер Zoom играет звук той же очередью в
        # странице, что и Google Meet, и ей нужен запас данных. Пауза 0.9
        # (сон 90 мс на 100 мс звука) не оставляет запаса вовсе: кусок
        # доставляется через CDP с задержкой, очередь пустеет, и голос
        # ассистента рвётся. Нативному SDK пауза по-прежнему нужна — у него
        # свой буфер.
        if meeting_type == MeetingTypes.ZOOM and not self.bot_in_db.use_zoom_web_adapter():
            return 0.9
        return 0.1"""


def main() -> int:
    src = io.open(PATH, encoding='utf-8').read()
    if 'LINKEON_ZOOM_WEB_PACE' in src:
        print('уже применено')
        return 0
    if OLD not in src:
        print('не найден якорь в', PATH)
        return 1
    backup = PATH + '.linkeon-orig'
    if not os.path.exists(backup):
        shutil.copy2(PATH, backup)
    io.open(PATH, 'w', encoding='utf-8', newline='\n').write(src.replace(OLD, NEW, 1))
    print('применено:', PATH)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
