#!/usr/bin/env python3
"""
Адаптер Яндекс Телемоста для Attendee: раскладка файлов и регистрация площадки.

ПОЧЕМУ ПАТЧЕМ, А НЕ ФОРКОМ. Форк Attendee — это второй источник правды и
обязанность его вести; мы держим свои правки скриптами, которые применяются
поверх запиненного коммита (см. README). Адаптер больше остальных правок, но
правило то же: файлы лежат у нас в `infra/attendee/telemost/`, скрипт кладёт
их в дерево моста и дописывает четыре места регистрации.

ЧТО РЕГИСТРИРУЕТСЯ:
  1. `MeetingTypes.TELEMOST` — новый тип встречи.
  2. Разбор ссылки `telemost.yandex.ru/j/<id>` в `meeting_url_utils`.
  3. Выбор адаптера, частота дискретизации и формат звука в `bot_controller`.
  4. Проверка адреса в сериализаторе, иначе API откажет ещё до создания бота.

ИДЕМПОТЕНТЕН. Оригиналы сохраняются рядом с `.linkeon-orig`.

ЗАПУСК на стенде (исходники смонтированы в контейнеры как `.:/attendee`):

    python3 infra/attendee/patches/telemost-adapter.py ~/attendee \\
        --from infra/attendee/telemost
    sudo docker compose -f ~/attendee/dev.docker-compose.yaml restart attendee-worker-local
"""

import argparse
import io
import os
import shutil
import sys

MARKER = "LINKEON_TELEMOST"


def patch_file(path: str, pairs: list) -> bool:
    src = io.open(path, encoding="utf-8").read()
    if MARKER in src:
        print("уже применено:", os.path.basename(path))
        return True
    backup = path + ".linkeon-orig"
    if not os.path.exists(backup):
        shutil.copy2(path, backup)
    for old, new in pairs:
        if old not in src:
            print("не найден якорь в", path, "\n" + old[:200])
            return False
        src = src.replace(old, new, 1)
    io.open(path, "w", encoding="utf-8", newline="\n").write(src)
    print("применено:", os.path.relpath(path))
    return True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("root", help="каталог с исходниками Attendee")
    ap.add_argument("--from", dest="src_dir", default=os.path.join(os.path.dirname(__file__), "..", "telemost"))
    args = ap.parse_args()
    root, src_dir = args.root, args.src_dir

    # ── 1. Файлы адаптера ───────────────────────────────────────────────────
    dst_dir = os.path.join(root, "bots", "telemost_bot_adapter")
    os.makedirs(dst_dir, exist_ok=True)
    io.open(os.path.join(dst_dir, "__init__.py"), "w", encoding="utf-8", newline="\n").write(
        "from .telemost_bot_adapter import TelemostBotAdapter\n\n__all__ = [\"TelemostBotAdapter\"]\n"
    )
    for name in ("telemost_bot_adapter.py", "telemost_ui_methods.py", "telemost_chromedriver_payload.js"):
        shutil.copy2(os.path.join(src_dir, name), os.path.join(dst_dir, name))
    print("файлы адаптера разложены:", dst_dir)

    # ── 2. Тип встречи ──────────────────────────────────────────────────────
    ok = patch_file(
        os.path.join(root, "bots", "models.py"),
        [(
            '''class MeetingTypes(models.TextChoices):
    ZOOM = "zoom"
    GOOGLE_MEET = "google_meet"
    TEAMS = "teams"''',
            '''class MeetingTypes(models.TextChoices):
    ZOOM = "zoom"
    GOOGLE_MEET = "google_meet"
    TEAMS = "teams"
    # LINKEON_TELEMOST: у апстрима российских площадок в планах нет, адаптер наш.
    TELEMOST = "telemost"''',
        )],
    )
    if not ok:
        return 1

    # ── 3. Разбор ссылки ────────────────────────────────────────────────────
    ok = patch_file(
        os.path.join(root, "bots", "meeting_url_utils.py"),
        [(
            "def normalize_meeting_url(url):\n    if not url:\n        return None, None",
            '''def normalize_telemost_url(meeting_id):
    # LINKEON_TELEMOST: у Телемоста адрес и есть весь опознаватель, нормализуем
    # только форму — хост и путь, без параметров слежения.
    return f"https://telemost.yandex.ru/j/{meeting_id}"


def telemost_meeting_id_from_url(url):
    import re

    m = re.search(r"https?://telemost\\.yandex\\.ru/j/(\\d{6,20})", url or "", re.I)
    return m.group(1) if m else None


def normalize_meeting_url(url):
    if not url:
        return None, None

    telemost_id = telemost_meeting_id_from_url(url)
    if telemost_id:
        return MeetingTypes.TELEMOST, normalize_telemost_url(telemost_id)''',
        )],
    )
    if not ok:
        return 1

    # ── 3b. Настройки расшифровки по умолчанию ──────────────────────────────
    #
    # Сериализатор подставляет их по типу встречи, а для незнакомого типа
    # возвращает None — и создание бота падает с «argument of type NoneType is
    # not iterable» уже внутри моста, без внятного ответа наружу. Проверено
    # первым же запросом 14.09.2026: API ответил «An error occurred while
    # creating the bot» и id ошибки.
    #
    # Отдаём пустой набор, а не набор Meet: субтитров у нашего адаптера нет, и
    # обещать их нельзя. Нам они и не нужны — расшифровку делает голосовой
    # воркер из потока, который мост отдаёт по вебсокету.
    ok = patch_file(
        os.path.join(root, "bots", "serializers.py"),
        [(
            """            elif meeting_type == MeetingTypes.TEAMS:
                value = {"meeting_closed_captions": {}}""",
            """            elif meeting_type == MeetingTypes.TEAMS:
                value = {"meeting_closed_captions": {}}
            elif meeting_type == MeetingTypes.TELEMOST:
                # LINKEON_TELEMOST: субтитров у адаптера нет, расшифровку
                # делает наш воркер из вебсокетного потока.
                value = {}""",
        )],
    )
    if not ok:
        return 1

    # ── 4. Мост: адаптер, частота и формат ──────────────────────────────────
    bc = os.path.join(root, "bots", "bot_controller", "bot_controller.py")
    ok = patch_file(
        bc,
        [
            # Частота: у веб-адаптеров она 48 кГц, Телемост не исключение.
            (
                """    def get_per_participant_audio_sample_rate(self):
        meeting_type = self.get_meeting_type()""",
                """    def get_per_participant_audio_sample_rate(self):
        meeting_type = self.get_meeting_type()
        # LINKEON_TELEMOST
        if meeting_type == MeetingTypes.TELEMOST:
            return 48000""",
            ),
            (
                """    def mixed_audio_sample_rate(self):
        meeting_type = self.get_meeting_type()""",
                """    def mixed_audio_sample_rate(self):
        meeting_type = self.get_meeting_type()
        if meeting_type == MeetingTypes.TELEMOST:
            return 48000""",
            ),
            (
                """    def get_audio_format(self):
        meeting_type = self.get_meeting_type()""",
                """    def get_audio_format(self):
        meeting_type = self.get_meeting_type()
        if meeting_type == MeetingTypes.TELEMOST:
            # Страница отдаёт кадры Float32 — тот же формат, что у Meet.
            return GstreamerPipeline.AUDIO_FORMAT_FLOAT""",
            ),
            # Развилка выбора адаптера: без неё get_bot_adapter вернёт None,
            # и бот упадёт уже после создания записи, с невнятной причиной.
            (
                """        elif meeting_type == MeetingTypes.TEAMS:
            return self.get_teams_bot_adapter()""",
                """        elif meeting_type == MeetingTypes.TEAMS:
            return self.get_teams_bot_adapter()
        elif meeting_type == MeetingTypes.TELEMOST:
            return self.get_telemost_bot_adapter()""",
            ),
            # Сам адаптер.
            (
                "    def get_google_meet_bot_adapter(self):",
                '''    def get_telemost_bot_adapter(self):
        from bots.telemost_bot_adapter import TelemostBotAdapter

        return TelemostBotAdapter(
            display_name=self.bot_in_db.name,
            send_message_callback=self.on_message_from_adapter,
            meeting_url=self.bot_in_db.meeting_url,
            add_video_frame_callback=None,
            wants_any_video_frames_callback=None,
            add_audio_chunk_callback=self.get_per_participant_audio_chunk_callback(),
            add_mixed_audio_chunk_callback=self.add_mixed_audio_chunk_callback if self.pipeline_configuration.websocket_stream_audio else None,
            add_per_participant_video_frame_callback=None,
            add_encoded_mp4_chunk_callback=None,
            upsert_caption_callback=None,
            upsert_chat_message_callback=self.on_new_chat_message,
            add_participant_event_callback=self.on_new_participant_event,
            automatic_leave_configuration=self.automatic_leave_configuration,
            per_participant_realtime_video_configuration=self.per_participant_realtime_video_configuration,
            recording_view=self.bot_in_db.recording_view(),
            should_create_debug_recording=self.bot_in_db.create_debug_recording(),
            start_recording_screen_callback=None,
            stop_recording_screen_callback=None,
            video_frame_size=self.bot_in_db.recording_dimensions(),
            record_chat_messages_when_paused=self.bot_in_db.record_chat_messages_when_paused(),
            # Видео нам не нужно вовсе: ассистент работает голосом, а входящий
            # поток картинок — это зря потраченные процессор и полоса.
            disable_incoming_video=True,
            record_participant_speech_start_stop_events=self.bot_in_db.record_participant_speech_start_stop_events(),
            room_sync_source_participant_configuration=self.get_room_sync_source_participant_configuration(),
        )

    def get_google_meet_bot_adapter(self):''',
            ),
        ],
    )
    if not ok:
        return 1

    print()
    print("ГОТОВО. Перезапустите воркер моста, чтобы он перечитал исходники:")
    print("  sudo docker compose -f ~/attendee/dev.docker-compose.yaml restart attendee-worker-local")
    return 0


if __name__ == "__main__":
    sys.exit(main())
