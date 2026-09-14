#!/usr/bin/env python3
"""
Локальная правка Attendee: звук из комнаты LiveKit — в МИКРОФОН, а не в камеру.

ЗАЧЕМ. Без неё ассистента во встрече Google Meet не слышно вовсе, хотя всё
остальное работает: участники зеркалятся, наша дорожка доезжает до страницы
бота, микрофон включён.

ПРИЧИНА. Адаптер LiveKit (`js_libs/livekit-client/2.21.0/livekit-client-adapter.js`)
отдаёт полученный поток так:

    window.botOutputManager.setBotOutputMediaStream(mediaStream);
    await window.botOutputManager.playBotOutputMediaStream("webcam");

То есть звук едет через ВЕБ-КАМЕРУ бота. Наш агент публикует только аудио,
поэтому адаптер подставляет чёрную видеодорожку (в логе — `type:
LiveKitVideoTrackNotAvailable`) и отправляет всё в камеру. А камеру Attendee
при входе в Meet выключает («Clicking the camera button…»), и поток никуда не
публикуется. Микрофон при этом честно включён, но несёт ДРУГУЮ дорожку —
`sourceAudioTrack` из внутреннего аудиографа страницы, куда звук из комнаты не
попадает.

ЧТО ДЕЛАЕТ ПРАВКА. Дополнительно соединяет аудиодорожку из комнаты с тем самым
графом: `audioContext → gainNode → audioDestination`. Клон `sourceAudioTrack`
из этого графа перехваченный `getUserMedia` и отдаёт встрече как микрофон,
поэтому после соединения ассистента слышно. Маршрут в камеру не трогаем — он
нужен, когда в комнате есть видео (демонстрация экрана, аватар).

Проверено на живой встрече Meet 10.09.2026: до правки — микрофон включён и
тишина, после — см. отчёт в infra/attendee/README.md.

ИДЕМПОТЕНТНА, оригинал сохраняется рядом с `.linkeon-orig`.

ЗАПУСК на стенде (исходники смонтированы в контейнеры как `.:/attendee`):

    python3 roomsync-audio-to-mic.py ~/attendee
    cd ~/attendee && docker compose -f dev.docker-compose.yaml restart \
        attendee-worker-local

ЭТО ВРЕМЕННО — как и правка микрофона. Держится в нашем репозитории, а не в
форке; после каждого обновления Attendee накатывать заново, иначе ассистент
молча онемеет.
"""

import shutil
import sys
from pathlib import Path

MARKER = "LINKEON_AUDIO_TO_MIC"

OLD = """    // Route the LiveKit media stream through the bot's webcam instead of
    // rendering it into an embedded video element on the page.
    window.botOutputManager.setBotOutputMediaStream(mediaStream);
    await window.botOutputManager.playBotOutputMediaStream("webcam");"""

NEW = """    // Route the LiveKit media stream through the bot's webcam instead of
    // rendering it into an embedded video element on the page.
    window.botOutputManager.setBotOutputMediaStream(mediaStream);
    await window.botOutputManager.playBotOutputMediaStream("webcam");

    // %(marker)s: звук — ещё и в микрофон.
    //
    // Маршрут выше ведёт в камеру, а камеру Attendee в Meet выключает при
    // входе, поэтому звук ассистента не публиковался вовсе: микрофон нёс
    // другую дорожку — sourceAudioTrack из внутреннего аудиографа страницы.
    // Соединяем дорожку из комнаты с тем же графом, из которого
    // перехваченный getUserMedia собирает микрофон.
    await linkeonRouteAudioToMic(mediaStream);""" % {"marker": MARKER}

HELPER = """
// %(marker)s: соединить аудио из комнаты с микрофонным трактом страницы.
//
// Граф микрофона: audioContext → gainNode → audioDestination, и клон
// audioDestination.stream отдаётся встрече как микрофон (см. перехват
// getUserMedia в shared_chromedriver_payload.js). Граф создаётся ЛЕНИВО —
// иначе, по комментарию авторов, звук пойдёт в колонки, — поэтому сначала
// просим его создать.
const linkeonRoutedTracks = new Set();
// Ссылки на элемент вывода и узел графа: без них сборщик мусора уберёт их
// вместе со звуком, и тишина вернётся через случайное время.
const linkeonAudioSinks = new Set();
const linkeonAudioNodes = new Set();

async function linkeonRouteAudioToMic(mediaStream) {
  const mgr = window.botOutputManager;
  const track = mediaStream?.getAudioTracks?.()[0];
  if (!mgr || !track) return;
  if (linkeonRoutedTracks.has(track.id)) return;   // не соединять дважды

  try {
    mgr._createSourceAudioTrack?.();
    const ctx = mgr.audioContext;
    const gain = mgr.gainNode;
    if (!ctx || !gain) {
      window.ws?.sendJson({ type: 'LinkeonAudioToMic', ok: false, reason: 'нет аудиографа' });
      return;
    }
    // Контекст мог быть создан до жеста пользователя и оказаться приостановлен;
    // в приостановленном графе дорожка молчит.
    if (ctx.state === 'suspended') await ctx.resume();

    const only = new MediaStream([track]);

    // Chrome не даёт удалённой дорожке WebRTC течь в WebAudio, пока поток
    // никуда не выводится: узел создан, соединён, а сигнала в нём нет.
    // Лечится тем, что поток дополнительно «проигрывается» элементом audio.
    //
    // Элемент ОБЯЗАН жить в ссылке: без неё сборщик мусора уберёт его вместе
    // с выводом, и тишина вернётся через случайное время. Приглушаем: динамики
    // бота нам не нужны, а незаглушённый вывод рискует вернуться во встречу
    // эхом.
    //
    // Проверено живой встречей 10.09.2026: до этого LinkeonAudioToMic
    // отчитывался ok:true при running-контексте, и звука всё равно не было —
    // не хватало ровно этого шага.
    const sink = new Audio();
    sink.srcObject = only;
    sink.muted = true;
    linkeonAudioSinks.add(sink);
    const played = sink.play().then(() => true).catch((e) => String(e && e.message || e));

    const src = ctx.createMediaStreamSource(only);
    src.connect(gain);
    linkeonRoutedTracks.add(track.id);
    linkeonAudioNodes.add(src);   // тот же довод: не дать собрать узел
    mgr.ensureMicOn?.();

    window.ws?.sendJson({
      type: 'LinkeonAudioToMic', ok: true, trackId: track.id, ctxState: ctx.state,
      sinkPlay: await played,
    });
  } catch (e) {
    window.ws?.sendJson({ type: 'LinkeonAudioToMic', ok: false, reason: String(e && e.message || e) });
  }
}
""" % {"marker": MARKER}


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else Path.home() / "attendee")
    target = root / "bots" / "web_bot_adapter" / "js_libs" / "livekit-client" / "2.21.0" / "livekit-client-adapter.js"
    if not target.exists():
        print(f"не найден {target}")
        return 1

    src = target.read_text(encoding="utf-8")
    if MARKER in src:
        print("правка уже применена")
        return 0
    if OLD not in src:
        print("маршрут в камеру не найден: Attendee обновился, правку надо пересмотреть")
        return 2

    backup = target.with_suffix(target.suffix + ".linkeon-orig")
    if not backup.exists():
        shutil.copy2(target, backup)
    target.write_text(src.replace(OLD, NEW) + HELPER, encoding="utf-8")
    print(f"правка применена, оригинал в {backup.name}")
    print("перезапустить: docker compose -f dev.docker-compose.yaml restart attendee-worker-local")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
