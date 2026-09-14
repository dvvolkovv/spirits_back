"""
Адаптер Яндекс Телемоста для моста Attendee.

ПОЧЕМУ ОН НАШ, А НЕ АПСТРИМА. Attendee поддерживает Zoom, Google Meet и Teams;
российских площадок у него в планах нет. Спайк 14.09.2026 показал, что
Телемост берётся тем же приёмом, что Meet: анонимный вход по ссылке,
подменённый через `getUserMedia` микрофон (владелец услышал тон 440 Гц) и
входящий звук, доступный со стороны страницы. Значит нужен только адаптер —
всё остальное (вебсокет к нам, гейт по имени, транскрипт, учёт) работает без
изменений.

ЧТО В НЁМ ЕСТЬ И ЧЕГО НЕТ. Это первая редакция, сделанная под живую отладку:
вход, исходящий звук, входящий звук и состав участников. Видео, демонстрация
экрана, субтитры и отправка в чат — не сделаны; их места помечены явными
отказами, а не заглушками, которые молча возвращают успех.
"""

import json
import logging

from bots.telemost_bot_adapter.telemost_ui_methods import TelemostUIMethods
from bots.web_bot_adapter import WebBotAdapter

logger = logging.getLogger(__name__)


class TelemostBotAdapter(WebBotAdapter, TelemostUIMethods):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

    def get_chromedriver_payload_file_names(self):
        return ["telemost_bot_adapter/telemost_chromedriver_payload.js"]

    def get_websocket_port(self):
        # Тот же диапазон, что у остальных веб-адаптеров: порт слушает сам
        # мост, страница подключается к нему на localhost.
        return 8765

    def subclass_specific_initial_data_code(self):
        return f"""
            window.telemostInitialData = {{
                displayName: {json.dumps(self.display_name)},
            }}
        """

    def subclass_specific_after_bot_joined_meeting(self):
        # Запись разрешена сразу: у Телемоста нет отдельного согласия на неё
        # со стороны площадки — как и у Meet, ответственность на организаторе
        # встречи, а бот объявляет себя первой репликой.
        self.after_bot_can_record_meeting()

    def send_chat_message(self, text, to_user_uuid):
        # Не реализовано сознательно: писать в чат Телемоста мы ещё не умеем,
        # и молчаливый успех здесь означал бы «ассистент сказал, что написал,
        # а в чате пусто». Пусть лучше вызов честно упадёт.
        raise NotImplementedError("Телемост: отправка в чат не реализована")

    def is_sent_video_still_playing(self):
        return False

    def send_video(self, video_url, loop=False, mute_video=False):
        raise NotImplementedError("Телемост: отправка видео не реализована")

    def get_staged_bot_join_delay_seconds(self):
        return 5

    def subclass_specific_use_disable_gpu_chrome_option(self):
        return True

    def subclass_specific_chrome_policies(self):
        return {}
