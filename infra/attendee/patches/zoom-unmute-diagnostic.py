#!/usr/bin/env python3
"""
Диагностика исходящего звука в Zoom. **ПРИМЕНЯТЬ НЕ НУЖНО** — см. итог ниже.

ИТОГ (10.09.2026). Правка сделала своё дело: исключила приглушение и тем самым
закрыла нативный адаптер как путь. Zoom работает ТОЛЬКО через веб-адаптер
(`zoom_settings: {"sdk": "web"}`), и там исходящий звук идёт без всяких правок.
На стенде эта правка откачена; файл оставлен как запись сделанного вывода и
готовый инструмент, если однажды нативный адаптер понадобится (например ради
частоты 32 кГц или диаризации по участникам).

Что показала диагностика на нативном адаптере:

    on_mic_start_send_callback called
    LINKEON mic: muted=False, can_unmute_by_self=True,
                 audio_join_type=AudioType.AUDIOTYPE_VOIP

Бот не приглушён, сам может снять приглушение, в голосовом канале,
`audio_raw_data_sender.send()` принимает каждый кадр с `SDKERR_SUCCESS` — и во
встрече тишина. То есть SDK принимает звук и не отдаёт его; причина глубже
мьюта, и искать её незачем, пока работает веб-адаптер.

--- ниже исходное описание, ради которого правка писалась ---

СИМПТОМ. Живой спайк 10.09.2026: бот вошёл во встречу Zoom, входящий звук шёл
20 572 куска с RMS до 0,2427 (то есть живая речь), исходящий тон 440 Гц ушёл в
SDK без единой ошибки — `on_mic_start_send_callback called` в логе есть,
предупреждений `error with send_raw_audio` нет вовсе, значит SDK принял все
кадры с SDKERR_SUCCESS. **Участники тона не слышали.** Ровно тот же класс
проблемы, что был в Google Meet, где мост не включал микрофон бота.

ЧТО ПОДОЗРИТЕЛЬНО В ОРИГИНАЛЕ. `periodically_unmute_audio()` пытается снять
приглушение только на каждый ТЫСЯЧНЫЙ вызов `send_raw_audio`. Куски приходят
по 100 мс, то есть попытка случается раз в 100 секунд речи; трёхсекундный тон
попал в это окно один раз, в самом начале. Хуже другое: весь блок молча
пропускается, если `audio_ctrl` или `my_participant_id` ещё не готовы, — и в
логе от него не остаётся ни строки, поэтому по прошлому прогону нельзя
сказать, была ли попытка вообще.

ЧТО ДЕЛАЕТ ПРАВКА.

1. Пытается снять приглушение раз в десять вызовов (примерно раз в секунду
   речи) вместо раза в тысячу. Это и есть возможное исправление: бота могли
   приглушить в любой момент встречи, и сто секунд немого ассистента —
   неприемлемо.
2. Раз в пять секунд пишет в лог состояние микрофона глазами SDK:
   `IsAudioMuted()`, `CanUnMuteBySelf()`, `GetAudioJoinType()` и результат
   попытки. Отдельной строкой — случай «контроллер не готов», который раньше
   был невидим.

Дальше по этому логу видно, какая из двух причин настоящая: бота приглушили и
он не может снять приглушение сам (тогда решение продуктовое — просить хозяина
встречи или настройку «участники могут включать микрофон»), либо микрофон не
приглушён и звук теряется глубже в SDK (тогда копать в частоту и размер кадра:
мост отдаёт 100-миллисекундные куски, пересемплированные в 32 кГц).

ИДЕМПОТЕНТНА. Оригинал сохраняется рядом с `.linkeon-orig`.

ЗАПУСК на стенде (исходники смонтированы в контейнеры как `.:/attendee`):

    python3 zoom-unmute-diagnostic.py ~/attendee
    cd ~/attendee && docker compose -f dev.docker-compose.yaml restart \
        attendee-worker-local

ЭТО ВРЕМЕННО — как и правка микрофона для Meet. Держится в нашем репозитории,
а не в форке Attendee; после выяснения причины скрипт заменяется либо
настройкой, либо узкой правкой, либо удаляется.
"""

import shutil
import sys
from pathlib import Path

MARKER = "LINKEON_ZOOM_UNMUTE_DIAG"

OLD = '''    def periodically_unmute_audio(self):
        # Let's periodically try to unmute the audio, in case someone muted us
        if self.send_raw_audio_unmute_ticker % 1000 == 0 and self.my_participant_id is not None and self.audio_ctrl is not None:
            if self.audio_ctrl.CanUnMuteBySelf():
                unmute_result = self.audio_ctrl.UnMuteAudio(self.my_participant_id)
                if unmute_result != zoom.SDKERR_SUCCESS:
                    logger.info(f"Failed to unmute audio. unmute_result = {unmute_result}")
            else:
                logger.info("Cannot unmute audio by self")
        self.send_raw_audio_unmute_ticker += 1'''

NEW = '''    def periodically_unmute_audio(self):
        # LINKEON_ZOOM_UNMUTE_DIAG: чаще снимаем приглушение и рассказываем в лог,
        # что видит SDK. Оригинал пробовал раз в 1000 вызовов — при куске 100 мс
        # это раз в 100 секунд речи, — и молча пропускал попытку, если
        # контроллер не готов, из-за чего по логу нельзя было понять, была ли
        # попытка вообще. Симптом: тон 440 Гц ушёл с SDKERR_SUCCESS, а участники
        # его не слышали (живой спайк 10.09.2026).
        ticker = self.send_raw_audio_unmute_ticker
        self.send_raw_audio_unmute_ticker += 1
        report = ticker % 50 == 0          # ~раз в 5 секунд при куске 100 мс

        if self.my_participant_id is None or self.audio_ctrl is None:
            if report:
                logger.info(
                    "LINKEON mic: контроллер не готов "
                    f"(participant_id={self.my_participant_id}, audio_ctrl={self.audio_ctrl is not None})"
                )
            return

        if report:
            muted = can_unmute = join_type = "?"
            try:
                me = self.participants_ctrl.GetMySelfUser()
                muted = me.IsAudioMuted()
                join_type = me.GetAudioJoinType()
            except Exception as e:
                muted = f"ошибка: {e}"
            try:
                can_unmute = self.audio_ctrl.CanUnMuteBySelf()
            except Exception as e:
                can_unmute = f"ошибка: {e}"
            logger.info(f"LINKEON mic: muted={muted}, can_unmute_by_self={can_unmute}, audio_join_type={join_type}")

        # Раз в 10 вызовов вместо тысячи: приглушить бота могут в любой момент,
        # и 100 секунд немого ассистента — не вариант.
        if ticker % 10 == 0:
            if self.audio_ctrl.CanUnMuteBySelf():
                unmute_result = self.audio_ctrl.UnMuteAudio(self.my_participant_id)
                if unmute_result != zoom.SDKERR_SUCCESS and report:
                    logger.info(f"LINKEON mic: UnMuteAudio вернул {unmute_result}")
            elif report:
                logger.info("LINKEON mic: сам снять приглушение не могу (CanUnMuteBySelf=False)")'''


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else Path.home() / "attendee")
    target = root / "bots" / "zoom_bot_adapter" / "zoom_bot_adapter.py"
    if not target.exists():
        print(f"не найден {target}")
        return 1

    src = target.read_text(encoding="utf-8")
    if MARKER in src:
        print("правка уже применена")
        return 0
    if OLD not in src:
        print("оригинальный periodically_unmute_audio не найден: Attendee обновился, правку надо пересмотреть")
        return 2

    backup = target.with_suffix(target.suffix + ".linkeon-orig")
    if not backup.exists():
        shutil.copy2(target, backup)
    target.write_text(src.replace(OLD, NEW), encoding="utf-8")
    print(f"правка применена, оригинал в {backup.name}")
    print("перезапустить: docker compose -f dev.docker-compose.yaml restart attendee-worker-local")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
